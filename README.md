# Vaulty

Vaulty syncs an Obsidian vault with a self-hosted backend ("homeserver") over a
small REST API. It consists of two parts:

```
├── backend/    # Go (Gin) sync API, serves the vault files from disk
└── plugin/     # Obsidian plugin that pushes/pulls vault files
```

## How sync works

1. The plugin fetches the server **manifest** (`GET /api/manifest`) — a map of
   `path -> { hash (SHA-256), mtime }` for every file on the server.
2. It builds the same map locally (hashes are cached per file and only
   recomputed when mtime/size change).
3. Each path is reconciled against the **last synced state**:
   - changed on one side only → push or pull that file
   - deleted on one side (but present in last synced state) → delete on the other
   - changed on both sides → the local version is saved as
     `<name>.conflict-<timestamp>.<ext>` and the remote version is pulled
4. A failing file does not abort the sync; failures are reported in the
   completion notice.

All API calls use `Authorization: Bearer <API_KEY>`. **Use HTTPS** — with plain
HTTP the API key is sent in cleartext (the plugin warns about non-HTTPS URLs).

## Backend setup

```bash
cd backend
export API_KEY=$(openssl rand -hex 32)   # required, no default
docker compose up -d --build
```

The vault is stored in `./data` (mounted to `/data/vault`). The API listens on
`:8080` with per-IP rate limiting and a 25 MiB request body cap. A public
`GET /health` endpoint is used for the container healthcheck.

### API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe (no auth) |
| GET | `/api/manifest` | `{ path: { hash, mtime } }` of all server files |
| GET | `/api/file?path=...` | Download one file (base64) |
| PUT | `/api/file` | Upload one file `{ path, contentBase64 }` |
| DELETE | `/api/file?path=...` | Delete one file (prunes empty folders) |

## Plugin setup

1. Build the plugin: `pnpm -C plugin install && pnpm -C plugin run build`
   (or download a release from the GitHub Releases page).
2. Copy `plugin/main.js`, `plugin/manifest.json` and `plugin/styles.css` into
   `<vault>/.obsidian/plugins/vaulty/`.
3. Enable **Vaulty** in Obsidian settings and configure the homeserver URL and
   API key (the same `API_KEY` as the backend). The API key is stored in the
   plugin's `data.json`, which is excluded from sync.

## Releases (CI)

- Push a tag `plugin-v*.*.*` (or trigger the **Release Obsidian plugin**
  workflow manually with a tag) → builds the plugin, attests `main.js`,
  `manifest.json` and `styles.css`, and publishes a GitHub release.
- Push a tag `backend-v*.*.*` → builds and pushes the backend image to
  `ghcr.io/<owner>/vaulty/backend` (only when `backend/**` changed).
- Every push/PR runs `lint.yml`: plugin build+lint and backend
  vet+test+govulncheck.
