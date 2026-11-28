package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestGetSafePathTraversal(t *testing.T) {
	vault := t.TempDir()

	cases := []string{
		"",
		"../outside.md",
		"../../etc/passwd",
		"foo/../../../escape.md",
	}
	for _, c := range cases {
		if _, err := getSafePath(vault, c); err == nil {
			t.Errorf("getSafePath(%q) should have failed", c)
		}
	}
}

func TestGetSafePathValid(t *testing.T) {
	vault := t.TempDir()
	got, err := getSafePath(vault, "folder/note.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := filepath.Join(vault, "folder", "note.md")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestGetSafePathSymlinkEscape(t *testing.T) {
	vault := t.TempDir()
	outside := t.TempDir()

	// symlink inside the vault pointing outside
	if err := os.Symlink(outside, filepath.Join(vault, "link")); err != nil {
		t.Skip("symlinks not supported")
	}

	if _, err := getSafePath(vault, "link/evil.md"); err == nil {
		t.Error("symlink escape should have been rejected")
	}
}

func setupRouter(t *testing.T) *gin.Engine {
	t.Helper()
	t.Setenv("API_KEY", "test-secret")
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader != "Bearer test-secret" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			return
		}
		c.Next()
	})
	r.GET("/api/manifest", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r
}

func TestAuthRequired(t *testing.T) {
	r := setupRouter(t)

	req := httptest.NewRequest(http.MethodGet, "/api/manifest", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without key, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/manifest", nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with key, got %d", w.Code)
	}
}

func TestAtomicWriteFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")

	if err := atomicWriteFile(target, []byte("hello"), 0644); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "hello" {
		t.Errorf("content mismatch: %q, err=%v", data, err)
	}

	// no temp files left behind
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("expected exactly 1 file, got %d", len(entries))
	}
}

func TestMaxBodyBytesEnforced(t *testing.T) {
	r := gin.New()
	gin.SetMode(gin.TestMode)
	r.Use(func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
		c.Next()
	})
	r.POST("/api/file", func(c *gin.Context) {
		var payload FilePayload
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	big := `{"path":"a.md","contentBase64":"` + strings.Repeat("A", 4096) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/file", strings.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for oversized body, got %d", w.Code)
	}
}
