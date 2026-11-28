package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// maxBodyBytes caps request bodies (base64 payloads) to protect against
// memory-exhaustion via oversized uploads.
const maxBodyBytes = 25 << 20 // 25 MiB

type ManifestEntry struct {
	Hash  string `json:"hash"`
	Mtime int64  `json:"mtime"`
}

type FilePayload struct {
	Path          string `json:"path" binding:"required"`
	ContentBase64 string `json:"contentBase64"`
}

var ignoredFiles = map[string]bool{
	".DS_Store":   true,
	"Thumbs.db":   true,
	"desktop.ini": true,
}

func main() {
	port := "8080"
	apiKey := os.Getenv("API_KEY")
	if apiKey == "" {
		log.Fatal("API_KEY environment variable must be set")
	}

	vaultDir := os.Getenv("VAULT_DIR")
	if vaultDir == "" {
		vaultDir = "/data/vault"
	}

	absVaultDir, err := filepath.Abs(vaultDir)
	if err != nil {
		log.Fatalf("Failed to resolve vault path: %v", err)
	}
	// Resolve symlinks once so all later path checks compare against the
	// real vault root.
	if resolved, err := filepath.EvalSymlinks(absVaultDir); err == nil {
		absVaultDir = resolved
	}
	if err := os.MkdirAll(absVaultDir, 0755); err != nil {
		log.Fatalf("Failed to create vault directory: %v", err)
	}

	r := gin.Default()

	// Public health endpoint for container healthchecks
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Bearer Token Auth Middleware (constant-time comparison)
	r.Use(func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		expected := "Bearer " + apiKey
		if subtle.ConstantTimeCompare([]byte(authHeader), []byte(expected)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}
		c.Next()
	})

	// Per-IP rate limiting to slow down API-key brute force and abuse
	r.Use(ipRateLimiter(rate.Limit(20), 40))

	// Cap request body size before any handler reads it
	r.Use(func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes)
		c.Next()
	})

	api := r.Group("/api")
	// Audit log for every authenticated API call
	api.Use(func(c *gin.Context) {
		c.Next()
		log.Printf("[AUDIT] %s %s -> %d (client %s)", c.Request.Method, c.Request.URL.Path, c.Writer.Status(), c.ClientIP())
	})
	{
		// 1. Get current server manifest
		api.GET("/manifest", func(c *gin.Context) {
			manifest, err := buildManifest(absVaultDir)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			c.JSON(http.StatusOK, manifest)
		})

		// 2. Download a file
		api.GET("/file", func(c *gin.Context) {
			relPath := c.Query("path")
			fullPath, err := getSafePath(absVaultDir, relPath)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}

			data, err := os.ReadFile(fullPath)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
					return
				}
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			c.JSON(http.StatusOK, gin.H{
				"path":          relPath,
				"contentBase64": base64.StdEncoding.EncodeToString(data),
			})
		})

		// 3. Upload / Update a file
		api.PUT("/file", func(c *gin.Context) {
			var payload FilePayload
			if err := c.ShouldBindJSON(&payload); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}

			fullPath, err := getSafePath(absVaultDir, payload.Path)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}

			decoded, err := base64.StdEncoding.DecodeString(payload.ContentBase64)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid base64 payload"})
				return
			}

			if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			// Atomic write: temp file in the same directory, then rename
			if err := atomicWriteFile(fullPath, decoded, 0644); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			c.JSON(http.StatusOK, gin.H{"status": "ok", "path": payload.Path})
		})

		// 4. Delete a file (and clean up empty parent folders)
		api.DELETE("/file", func(c *gin.Context) {
			relPath := c.Query("path")
			fullPath, err := getSafePath(absVaultDir, relPath)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}

			if err := os.Remove(fullPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			pruneEmptyDirs(filepath.Dir(fullPath), absVaultDir)
			c.JSON(http.StatusOK, gin.H{"status": "deleted", "path": relPath})
		})
	}

	log.Printf("Homeserver Sync API listening on :%s (vault: %s)", port, absVaultDir)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

// getSafePath prevents directory traversal outside absVaultDir, including
// via symlinks placed inside the vault.
func getSafePath(absVaultDir, relPath string) (string, error) {
	if relPath == "" {
		return "", errors.New("path parameter is required")
	}
	cleaned := filepath.Clean(filepath.FromSlash(relPath))
	target := filepath.Join(absVaultDir, cleaned)

	// Resolve symlinks via the deepest existing ancestor (the target itself
	// may not exist yet on PUT), then re-join the remaining path.
	probe := target
	var resolved string
	for {
		if real, err := filepath.EvalSymlinks(probe); err == nil {
			rest, relErr := filepath.Rel(probe, target)
			if relErr != nil {
				return "", errors.New("invalid path: cannot resolve")
			}
			resolved = filepath.Join(real, rest)
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", errors.New("invalid path: cannot resolve")
		}
		probe = parent
	}

	rel, err := filepath.Rel(absVaultDir, resolved)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", errors.New("invalid path: traversal detected")
	}
	return resolved, nil
}

// atomicWriteFile writes data to a temp file in the same directory and then
// renames it over the target, so readers never observe a partial file.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after successful rename

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("atomic rename: %w", err)
	}
	return nil
}

// ipRateLimiter limits requests per client IP.
func ipRateLimiter(limit rate.Limit, burst int) gin.HandlerFunc {
	var mu sync.Mutex
	limiters := make(map[string]*rate.Limiter)

	return func(c *gin.Context) {
		ip := c.ClientIP()
		mu.Lock()
		limiter, ok := limiters[ip]
		if !ok {
			limiter = rate.NewLimiter(limit, burst)
			limiters[ip] = limiter
		}
		mu.Unlock()

		if !limiter.Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "Rate limit exceeded"})
			return
		}
		c.Next()
	}
}

// buildManifest walks the vault directory and streams SHA-256 hashes
func buildManifest(absVaultDir string) (map[string]ManifestEntry, error) {
	manifest := make(map[string]ManifestEntry)

	err := filepath.WalkDir(absVaultDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if ignoredFiles[d.Name()] {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		hash, err := hashFile(path)
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(absVaultDir, path)
		if err != nil {
			return err
		}

		manifest[filepath.ToSlash(relPath)] = ManifestEntry{
			Hash:  hash,
			Mtime: info.ModTime().UnixMilli(),
		}
		return nil
	})

	return manifest, err
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// pruneEmptyDirs removes empty parent folders up to (but excluding) absVaultDir
func pruneEmptyDirs(dir, absVaultDir string) {
	for dir != absVaultDir && strings.HasPrefix(dir, absVaultDir) {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) > 0 {
			break
		}
		_ = os.Remove(dir)
		dir = filepath.Dir(dir)
	}
}
