# EasyDrop

[简体中文](README.md) | [English](README.en.md)

Current Version: `1.4.1`

A cross-device text and file transfer hub built on Cloudflare Workers, D1, and private R2 storage. Deploy once to exchange content across desktops, phones, and tablets over HTTPS.

## Key Capabilities

### Accounts & Security

- **Tenant Isolation**: Every user has an isolated space for text, files, uploads, revisions, and idempotency keys; all content endpoints verify both resource ID and session user ID.
- **Account Management**: Interactive initial admin setup on first deploy; admins can create, enable/disable, or delete users and toggle self-registration. Concurrent last-admin protection is enforced atomically.
- **Credential Standards**: Usernames (3–32 chars: letters, digits, `.`, `_`, `-`) and passwords (12–32 chars with digits, uppercase, and lowercase) use salted 100,000-iteration PBKDF2-SHA-256. Sessions use `HttpOnly` cookies; write requests verify same-origin `Origin` and `X-CSRF-Token`.
- **Self-Service Security**: Users can change passwords, generate single-use 256-bit recovery codes, or delete their accounts; password changes and global logout revoke all active sessions.

### Text & File Transfer

- **Text Sharing**: Supports multi-line text and code snippets (default 128 KiB limit), rendered as plain text with clickable `http://` and `https://` links, one-click copy, and delete.
- **Chunked Concurrent Uploads**: Supports file picker, drag-and-drop, and clipboard paste; processes 3 files concurrently by default with 3 concurrent 5 MiB chunks per file (200 MiB default per-file limit).
- **Integrity & Resume**: Computes per-chunk SHA-256 and whole-file fingerprints in the browser, verified by the Worker. Supports pause, resume, and re-selecting the source file after refresh (24-hour default recovery window).
- **Idempotency**: Text and upload requests carry `Idempotency-Key` (UUID v4) for safe retries.

### Downloads, Thumbnails & Temporary Links

- **Thumbnails & Previews**: Generates WebP thumbnails (up to 512 px) in parallel for JPEG, PNG, GIF, WebP, AVIF, and BMP images, stored in private R2 with in-app original image preview.
- **HTTP Range Downloads**: Supports `GET`, `HEAD`, and single-range `Range` requests with `ETag`, `Last-Modified`, and attachment headers.
- **Time-Limited Public Links**: Generate 1–168 hour login-free download links and QR codes per file, replaceable or revocable at any time.

### History Sync & Mobile PWA

- **Pagination & Polling**: Unified reverse-chronological history (10 items/page default) polling every 5 s when visible, syncing immediately on focus/reconnect with 5–60 s backoff.
- **QR Code & PWA**: Site Origin QR code in the header; installable as a standalone PWA via Web App Manifest and Service Worker.
- **Android Share Target**: When installed as a PWA via a supporting Chromium browser and opened once, EasyDrop appears in the Android system share sheet to stage shared text, links, or files locally for confirmation.

## Architecture & Storage

| Component | Responsibility |
| --- | --- |
| Cloudflare Worker | Routing, authentication, validation, sharing APIs, downloads, and cleanup |
| Workers Static Assets | Serves built HTML and content-hashed JS/CSS |
| D1 Database | Users, sessions, rate-limit counters, text, file metadata, idempotency, and upload states |
| Private R2 Bucket | Stores file blobs (`files/<id>`) and optional thumbnails (`files/<id>/preview`) |
| Cron Trigger | Runs every 15 minutes to clean expired sessions, share links, stale uploads, and deleted objects |

## Local Development

Requires Node.js 22+:

```sh
cd easydrop
npm ci
npm run setup      # Interactively configure initial local admin (.dev.vars)
npm run dev        # Starts at http://127.0.0.1:8787
```

Ephemeral preview:

```sh
npm run preview    # Random port and one-time password; discards data on exit
```

Reset local D1/R2 state (preserves `.dev.vars`):

```sh
bash reset.sh --local
```

## Deploy to Cloudflare

1. **Enable R2**: Open **Storage & databases → R2 → Overview** in Cloudflare Dashboard to activate R2.
   ![Cloudflare R2 Enablement](docs/img/cloudflare/cloudflare-r2-enable.svg)
2. **Choose Public Entry**:
   - `workers.dev`: Initialize your account subdomain under **Workers & Pages**.
     ![Cloudflare workers.dev Setup](docs/img/cloudflare/cloudflare-workers-dev.svg)
   - **Custom Domain**: Prepare an **Active** zone and an available hostname (e.g., `share.example.com`) in the same account.
3. **Create a Custom API Token** ([API Tokens](https://dash.cloudflare.com/profile/api-tokens/)):
   - Account permissions: `Account Settings (Read)`, `Workers Scripts (Edit)`, `D1 (Edit)`, `Workers R2 Storage (Edit)`.
   - Zone permissions (for Custom Domain): `Zone (Read)`, `Workers Routes (Read)`.
   ![Cloudflare API Token Permissions](docs/img/cloudflare/cloudflare-api-token.svg)
4. **Deploy**:

```sh
cd easydrop
bash deploy.sh
```

The script reads your token invisibly, builds assets, provisions D1 and private R2, runs migrations, deploys the Worker, verifies HTTPS reachability, and saves resource IDs to `wrangler.deploy.json` for subsequent updates.

Typical personal usage fits within Cloudflare Workers Free, D1 Free, and R2 Standard free tiers.

## Configuration

Configure `vars` in `wrangler.json` and redeploy:

| Parameter | Default | Range | Description |
| --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | `2592000` | 3600–31536000 | Sliding session lifetime (s, default 30 days) |
| `SESSION_RENEW_INTERVAL_SECONDS` | `900` | 60–86400 | Minimum session renewal interval (s) |
| `MAX_UPLOAD_BYTES` | `209715200` | 1–209715200 | Max single file size (bytes, default 200 MiB) |
| `UPLOAD_CHUNK_BYTES` | `5242880` | 5242880–99614720 | Multipart chunk size (bytes, default 5 MiB) |
| `UPLOAD_CONCURRENCY` | `3` | 1–6 | Concurrent chunks per file |
| `UPLOAD_FILE_CONCURRENCY` | `3` | 1–4 | Concurrent files uploaded |
| `UPLOAD_SESSION_TTL_SECONDS` | `86400` | 3600–518400 | Idle upload resume window (s, default 24 h) |
| `MAX_TEXT_BYTES` | `131072` | 1–1048576 | Max text entry size (bytes, default 128 KiB) |
| `POLL_INTERVAL_SECONDS` | `5` | 5–3600 | History revision polling interval (s) |
| `LOGIN_WINDOW_SECONDS` / `LOGIN_IP_LIMIT` / `LOGIN_GLOBAL_LIMIT` | `900` / `10` / `100` | — | Login rate-limit window and budgets |
| `ACCOUNT_ACTION_WINDOW_SECONDS` | `900` | 60–86400 | Registration & password-reset window (s) |
| `HISTORY_PAGE_SIZE` | `10` | 1–50 | History items per page (capped at 10) |
| `CLEANUP_BATCHES` | `4` | 1–8 | Cleanup batches per Cron run (50 items/batch) |
| `ALLOW_LOCAL_HTTP` | `false` | `true` / `false` | Set `true` only for local loopback dev |

## API Overview

Write endpoints require a valid session cookie, same-origin `Origin`, and `X-CSRF-Token`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/auth/config` | Public | Check self-registration status |
| `POST` | `/api/login` / `/api/register` / `/api/password/reset` | Same-Origin | Login, register, or reset password via recovery code |
| `GET` | `/api/bootstrap` / `/api/session` | Session | Fetch session config and initial history |
| `POST` | `/api/logout` | Write Check | Revoke current session |
| `POST` / `DELETE` | `/api/account/password`, `/recovery-code`, `/api/account` | Write Check | Change password, rotate recovery code, delete account |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/users`, `/api/users/<id>`, `/api/settings/registration` | Admin | User management and registration toggle |
| `GET` | `/api/revision`, `/api/history?before=<seq>` | Session | History revision and cursor pagination |
| `POST` | `/api/text` | Write Check | Submit text entry |
| `POST` / `GET` / `PUT` / `DELETE` | `/api/uploads`, `/api/uploads/<id>`, `/parts/<number>`, `/preview`, `/complete` | Session / Write Check | Chunked upload, thumbnail, completion, and cancel |
| `GET` / `HEAD` | `/previews/<id>`, `/images/<id>/<filename>`, `/uploads/<id>/<filename>` | Session | Thumbnail, image preview, and file download |
| `POST` / `DELETE` | `/api/history/<id>/share` | Write Check | Create, replace, or revoke temporary link |
| `GET` / `HEAD` | `/shared/<token>/<filename>` | Public | Temporary link download (supports Range) |
| `DELETE` / `POST` | `/api/history/<id>`, `/api/clear_history` | Write Check | Delete single item or clear history |

## Project Structure & Commands

| Path | Description |
| --- | --- |
| `src/worker.js` / `src/auth.js` | Worker routing, APIs, auth, and rate limiting |
| `web/` | Frontend UI and interactions |
| `migrations/` | D1 database schema |
| `scripts/` | Build, preview, and Cloudflare deployment scripts |
| `test/` | API, deploy protocol, and Playwright UI tests |
| `wrangler.json` / `deploy.sh` | Worker config and interactive deploy entrypoint |

Common commands (run inside `easydrop/`):

```sh
npm run check          # JavaScript syntax check
npm run build          # Build frontend assets to dist/
npm test               # API and deploy integration tests
npm run test:ui        # Playwright browser tests
bash reset.sh --remote # Reset remote Worker, D1, and R2
```
