# EasyDrop

[简体中文](README.md) | [English](README.en.md)

Current Version: `1.2.6`

EasyDrop is a text and file sharing tool built on Cloudflare Workers, using username and password authentication, a D1 database, and private R2 object storage. Once deployed, computers, phones, and tablets can exchange content across networks via a single HTTPS address.

Ideal for personal cross-device text and file transfers, it also supports multiple users on the same instance with isolated personal workspaces. Administrators manage registration and accounts, while content access remains strictly segregated per user.

## 1.2.6 Updates

- **Settings Modal English Layout Polish**: Optimized layout and text alignment of the account settings modal in English mode, adjusting label and control widths to prevent text wrapping and misalignments; refined responsive spacing and layout on mobile and narrow screens.

## 1.2.5 Updates

- **i18n Architecture Refactoring**: Consolidated all copy into an independent dictionary (`web/i18n.js`) supporting `t(key, ...args)` parameter interpolation.
- **Static & Dynamic Decoupling**: HTML static copy uses `data-i18n*` attributes rendered once on load, while JS dynamic copy uses explicit `t(...)` calls, completely removing the `MutationObserver` text replacement hack.
- **Automated Key Alignment Script**: Added `scripts/check-i18n.mjs` integrated into `check` and `test` pipelines, blocking builds if translations are missing or misaligned.

## 1.2.4 Updates

- **Language Option Standardization**: Kept native labels "中文" and "English" unchanged in the settings language selector, and unified the label to "语言/Language" to avoid translation confusion.

## 1.2.3 Updates

- **Copy Feedback Localization**: Fixed the "Copied" feedback tooltip remaining in Chinese when copying text or file links in English mode; added dynamic observation and localization support for the `data-copy-feedback` attribute.

## 1.2.2 Updates

- **Translation & Pagination Fixes**: Added English translations for the file picker area and "Current Page" filter tag; removed the global string replacement rule that accidentally stripped the "页" character, ensuring pagination indicators display properly.

## 1.2.1 Updates

- **i18n & Layout Polish**: Fixed centered/separated layout defect in the language selector within Account Settings, adopting standard Apple-style space-between alignment; reordered phrase dictionary to prevent substring conflicts (e.g. deleted items count, chunk upload status); added `alt` and meta description translations; dynamically formatted timestamps and share expiry dates according to selected UI language.

## 1.2.0 Updates

- The UI defaults to Chinese and can switch to English from the login page or account settings, with mobile layouts adapted for longer English labels.

## 1.1.7 Updates

- **Apple HIG Design Overhaul**: Account settings and user management adopt an Inset Grouped card style, macOS-inspired Segmented Controls, circular user letter avatars, and semantic status badges.
- **Form Layout Fixes**: Eliminated hidden ID placeholder offsets caused by two-column CSS grid; refactored into a clean, single-column responsive form and options row.
- **Dark Mode & Thumbnail Polish**: Transparent image thumbnail backgrounds adapt to dark theme; optimized responsive spacing for mobile dialogs and forms.

## 1.1.6 Updates

- Added system dark theme support, password visibility toggles with rule hints, and merged admin user management into the Account modal.
- Added drag-and-drop and secure clipboard file uploads, plus `Cmd/Ctrl+Enter` text sharing shortcut.
- Added history type filtering for the current page; select-all, counts, and deletion strictly apply to currently visible records.
- Updated browser regression tests for user management, filtering, and modal paste handling.

## Table of Contents

- [Features](#features)
- [Architecture & Data Storage](#architecture--data-storage)
- [Cost & Usage Estimation](#cost--usage-estimation)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Authentication & Security](#authentication--security)
- [API Reference](#api-reference)
- [Project Structure & Commands](#project-structure--commands)
- [FAQ](#faq)
- [Scope & Limitations](#scope--limitations)
- [Verification](#verification)

## Features

### User Authentication & Management

- Unauthenticated visits redirect to the login page; entering valid credentials grants access to the main sharing view.
- Self-registration is disabled by default; administrators can temporarily enable it in "User Management". Self-registered accounts default to regular users in pending-approval status and require administrator activation before logging in.
- Initial deployment interactively provisions an administrator; admins can create users, edit profiles or passwords, enable/disable/delete accounts, and assign admin or regular roles.
- Each user possesses an isolated workspace for text, files, upload sessions, history revisions, and idempotent operations. Admins only manage accounts and never automatically gain access to other users' content.
- Usernames are normalized to lowercase, 3–32 characters, permitting only alphanumeric characters, dots, underscores, and hyphens.
- Passwords must be 12–32 characters and contain uppercase letters, lowercase letters, and digits.
- Logged-in users can verify their current password in "Account Settings" to change passwords, generate recovery codes, or delete their account (the delete button is automatically hidden if the user is the sole active administrator; self-deletion is only allowed for regular users or when multiple active administrators exist). Changing passwords revokes all sessions and invalidates existing recovery codes.
- Recovery codes use 256-bit random tokens, displayed only once upon generation; D1 stores only the SHA-256 digest. Upon successful password recovery, the code is invalidated immediately; lost codes can still be reset by an administrator.
- Account deletion immediately disables the account and revokes sessions, followed by background batch cleanup of the user's D1 records and R2 objects. Content creation re-checks account status and auth version during actual writes, preventing in-flight requests from persisting new content post-deletion.
- Last-admin protection and account status updates execute within the same conditional write; even under concurrent disable, demote, delete, or self-deletion actions, at least one active administrator is guaranteed to remain.
- Each browser login establishes an independent server session with a default 30-day sliding expiry; continuous access extends sessions at most once every 15 minutes, preventing frequent polling from generating redundant D1 writes.
- Modifying profiles/passwords, disabling users, or deleting accounts immediately revokes all sessions for that user without waiting for background sweeps.
- Session state is maintained via HttpOnly Cookies; passwords and session tokens are never written to `localStorage`.
- Logging out revokes the current session without affecting other logged-in devices. The frontend stops polling, cancels in-flight requests, and returns to the login page.
- Expired sessions or password changes reject subsequent protected requests with `401`, requiring re-authentication.
- History viewing, text submission, uploads, standard downloads, deletion, and clear operations require login. Only time-limited links explicitly created by authenticated users can be downloaded without authentication.

### Text Sharing & Copying

Enter content in the text area and click "Share Text"; successfully saved records appear in the user's sharing history, accessible and copyable across other logged-in devices of the same account.

- Supports Chinese, multi-line text, and code snippets, preserving original line breaks and surrounding whitespace.
- Empty or whitespace-only submissions are rejected; default per-item limit is 128 KiB (131,072 bytes), measured in UTF-8 bytes rather than character counts.
- The input area displays current size and allowed limit; exceeding the limit disables submission, and the backend verifies independently.
- History displays creation time and full text. Content is rendered as plain text without executing HTML/scripts or parsing Markdown; valid `http://` and `https://` URLs are rendered as clickable links opening in a new window.
- Each text record can be copied or deleted with one click. Copying relies on browser clipboard permissions and requires HTTPS in production.
- Submissions cannot be duplicated while in-flight, but editing the next draft is permitted; completion of the previous request does not clear modified inputs.

### Multi-File Upload

Click "Choose Files", drag and drop files, or paste files when no dialog is open to add multiple files and initiate uploads immediately. By default, 3 files are processed concurrently, each non-empty file utilizing R2 Multipart Upload with concurrent part uploads. File-level and part-level concurrency are both controlled by server configuration.

- Default per-file limit is 200 MiB, validated both client-side and server-side; UI uses KB/MB with a 1024 base.
- Default upload chunk size is 5 MiB, processing 3 files concurrently with 3 concurrent parts per file; the final part may be smaller than 5 MiB. Each Worker request handles exactly one part without buffering the entire file on the server.
- The browser calculates per-part SHA-256 and derives a whole-file fingerprint; the Worker verifies each part body. The fingerprint is bound to an idempotency key, and part hashes are persisted alongside R2 ETags to prevent mismatched chunks.
- Supports non-ASCII filenames, empty files, and duplicate filenames. Duplicates receive unique internal IDs without overwriting existing files, restoring original filenames upon download.
- Filenames may contain up to 255 UTF-8 bytes, prohibiting path separators and control characters.
- Uploading displays a "Pause" control; pausing aborts in-flight parts while preserving server-acknowledged parts. Clicking "Resume" reads server state and retransmits only missing or checksum-mismatched parts.
- Each file indicates progress, checksum verification, part counts, and "Uploaded" or "Failed" status; thumbnail generation and upload run concurrently with file parts without blocking file transmission. Multi-part files display "Merging" during object assembly, whereas single-part files remain at "Uploading part 1/1" until published. Reaching 100% transfer does not equate to completion; "Uploaded" is shown only after R2 completion and D1 record publication succeed. Optional thumbnail failure displays "Uploaded (No Thumbnail)" without failing the main file. Success indicators auto-dismiss after 8 seconds.
- Partial failures preserve succeeded files and detail errors; retrying processes only incomplete files.
- File metadata (name, size, modification time, fingerprint, operation key, upload ID) is stored in browser `localStorage` per user ID without saving file contents. Refreshing or reopening requires re-selecting the file, which resumes using existing server parts upon match.
- Upload sessions refresh their timestamp on part acknowledgment or resumption, expiring after 24 hours of inactivity via scheduled cleanup. R2 automatically aborts incomplete multipart uploads after 7 days by default; do not configure R2 lifecycle shorter than the app recovery window.
- File selection and history clearing are disabled during active uploads. Leaving the page triggers browser unload warnings.
- Browser timeout per part is 30 minutes, retrying up to 3 times on failure with retry counts reflected in the UI.

### Idempotency & Duplicate Submission Protection

Text submissions and file uploads utilize `Idempotency-Key` headers. The frontend generates a UUID v4 per operation, reused on retries, while D1 tracks operation status and results.

| Operation Status | Behavior on Duplicate Request |
| --- | --- |
| Already completed, but client missed response | Returns original record without re-inserting |
| Operation still in-flight | Returns `409`, retryable later with same key |
| Operation explicitly failed | Permits re-claiming and execution; only one retry can claim at a time |
| Operation succeeded, but record was deleted | Returns `410`, does not recreate record |
| Key reused with mismatched request parameters | Returns `409`, rejects reuse |

Completed or failed operation records are retained for approximately 24 hours and pruned by cron. Active chunk uploads refresh the timestamp; re-selecting matching files in the same browser reuses the original key. Expired keys initiate fresh uploads.

Operation keys bind filename, size, chunk size, and file fingerprint for validation; they do not perform cross-operation deduplication. Custom API callers must not reuse keys across different files.

### File Downloads

- Each file record includes an independent download button. The Worker validates session and record state before streaming from private R2; downloads trigger directly in-page without blank tabs.
- For JPEG, PNG, GIF, WebP, AVIF, and BMP, the frontend generates high-quality WebP thumbnails (max 512px, max 512 KiB) prior to uploading. Clicking thumbnails or preview buttons opens the original image in a modal; downloading original images uses a separate button. SVGs are never displayed inline.
- Thumbnails are stored as distinct private R2 objects. History refreshes reuse unchanged image DOM nodes without re-fetching.
- Each record provides download and link copying; hovering or focusing download buttons renders a QR code.
- Standard file links and QR codes contain only protected site URLs and URL-encoded filenames; accessing them from new devices prompts for login, automatically starting the download upon authentication.
- Users can generate 1–168 hour temporary links and QR codes per file. Temporary links require no login; creating a new link replaces prior links for that file, and links can be revoked before expiration. Clicking initiates direct download without blank tabs.
- Temporary link requests bind to the active modal file; closing or switching files discards stale responses without overwriting active link states.
- Temporary links use 256-bit random tokens; D1 stores only the SHA-256 digest. Anyone holding the link can download within its validity window; treat them as public credentials.
- Files stream as attachments, preventing inline HTML execution under the site domain.
- Supports `GET` download, `HEAD` metadata inspection, and single-range HTTP `Range` requests with `Accept-Ranges`, `ETag`, and `Last-Modified`; invalid ranges return `416`.
- Resumable downloads are supported via byte ranges. Download managers must track offsets and issue `Range` headers; the UI does not include a pause/resume download manager.
- Concurrent single-range requests on the same file are permitted, allowing multi-threaded download managers; the web UI uses single-stream browser downloads.
- Download URLs locate objects via internal file IDs with encoded filenames, matching database records strictly without exposing public R2 endpoints.
- Unauthenticated requests receive `401`; deleted or nonexistent files return `404`.

### Sharing History & Cross-Device Sync

- Text and files appear in a unified list, ordered newest to oldest.
- Timestamps are stored as Unix timestamps and rendered according to the client device's timezone and locale.
- Cursor-based pagination provides Previous/Next page navigation, defaulting to 10 items per page without fetching the entire history at once. The header displays total record count, and the footer shows "Page current/total" (e.g., "History 13" and "Page 1/2").
- History version polling runs every 5 seconds by default; paused when the tab is hidden or during active uploads/loading.
- Tab visibility, window focus, or network restoration triggers immediate checks without waiting for the timer.
- Version changes trigger automatic current-page refreshes, restoring scroll position and reusing unchanged DOM nodes; empty pages post-deletion navigate to the previous page.
- Network errors display messages and back off exponentially (5s, 10s, 20s, 40s, 60s), resetting to 5s upon success.

Default `HISTORY_PAGE_SIZE=10`, effective page size `min(HISTORY_PAGE_SIZE, 10)`, counting text and files together. Text length is governed by `MAX_TEXT_BYTES`.

### Deletion & Clearing

Individual records offer deletion buttons, and the history header provides a "Clear History" button; both require confirmation.

- Deleting text removes the record; deleting files removes the record and schedules deletion of R2 files and thumbnails.
- Clearing marks all existing records and in-flight uploads as deleted.
- The server revokes visibility and new download access immediately, then asynchronously removes physical files; API returns `202 Accepted`.
- Deletion requests trigger a batch of background cleanups; scheduled cron handles remaining items and retries.
- New shares created by other devices after a clear operation proceed normally; clearing does not affect other users.
- No trash bin or undo functionality exists. Content copied to clipboard, downloaded, or in-transit cannot be recalled.

### QR Codes & Mobile Access

Hovering or focusing the header QR button displays the site QR code and full URL; clicking opens an enlarged modal with a copy link button. The QR code encodes only the site Origin (protocol, domain, port) without credentials.

Scanning requires standard login. The interface is responsive for desktop and mobile widths, supporting long filename wrapping. For local preview (`127.0.0.1`), the QR code represents the local host only and cannot be accessed from external mobile devices; cross-device use requires deployment to an HTTPS domain.

Includes Web App Manifest, Android maskable icons, Apple Touch Icon, and a Service Worker for standalone window installation. JS/CSS files use content-hashed filenames; the Service Worker caches public assets without intercepting navigation, API, downloads, or user data. Session cookies use `SameSite=Lax`.

## Architecture & Data Storage

| Component | Responsibility |
| --- | --- |
| Cloudflare Worker | Routing, authentication, validation, sharing APIs, downloads, background cleanup |
| Workers Static Assets | Serves built HTML, JavaScript, and CSS |
| D1 Database | Stores users, password verifiers, text content, file metadata, sessions, rate limits, operations, revisions |
| Private R2 Bucket | Stores binary files `files/<internal-id>` and thumbnails `files/<internal-id>/preview` |
| Cron Trigger | Periodically cleans expired sessions, pending deletes, and orphaned objects |

Static assets configure `run_worker_first: true`. Login pages, unauthenticated app shells, and JS/CSS are publicly accessible; the frontend invokes `/api/bootstrap` to retrieve session config and first-page history, redirecting to login if unauthenticated.

D1 Tables:

| Table | Stored Data |
| --- | --- |
| `users` | Username, password verifier, recovery code digest, role, status, auth version, content revision |
| `items` | User ID, text/file records, supported media types, states (`pending`, `ready`, `deleting`) |
| `sessions` | User ID, session token digest, CSRF token, auth version, sliding expiration |
| `login_attempts` | Source IP and global login attempt counters |
| `account_attempts` | IP and global attempt counters for registration and recovery |
| `operations` | User ID, idempotency key, request fingerprint, result record ID, status |
| `multipart_uploads` | R2 Multipart Upload ID, chunk size, total parts, status, last activity |
| `multipart_parts` | Confirmed part number, size, SHA-256, R2 ETag |
| `file_shares` | Active temporary share token digests and expiration times per file |
| `app_state` | Self-registration toggle and R2 orphan sweep cursor |

Files are registered as `pending` and published to `ready` upon R2 write confirmation. Only `ready` records appear in history. Deleted items transition to `deleting`. D1 and R2 operations are not cross-service transactions; cron补偿 cleanups resolve inconsistencies.

Cron expression `*/15 * * * *` runs every 15 minutes:

- Deletes expired sessions and login attempt logs older than 24 hours.
- Deletes expired temporary file share records; expired links are rejected at request time regardless.
- Marks multipart uploads idle for over `UPLOAD_SESSION_TTL_SECONDS` (default 24h) as deleting and aborts them; uninitialized records abort after 1 hour.
- Cleans idempotency records older than 24 hours.
- Processes up to 4 batches of pending deletes (50 items per batch); text deletes do not call R2.
- Deletes user records once all deleted user content is fully purged.
- Checks up to 50 R2 objects per run, deleting orphaned objects older than 1 hour not tracked in D1, advancing a cursor.

Normal shares never expire automatically; they persist until deleted.

## Cost & Usage Estimation

Price verification date: **2026-09-17**. Defaults to Workers Free, D1 Free, and R2 Standard free tiers (**$0/month** within limits).

Upgrading to **Workers Paid** introduces a minimum account fee of `$5/month`. Workers Free and D1 Free operate within daily hard limits; R2 Standard charges for usage exceeding monthly free allowances.

### Free Tier Limits

| Service | Free Allowance |
| --- | --- |
| Worker Invocations | 100,000 requests/day |
| Worker CPU | 10 ms CPU time per invocation |
| D1 Row Reads | 5,000,000 rows/day |
| D1 Row Writes | 100,000 rows/day |
| D1 Storage | 5 GB per account; 500 MB max per free database |
| R2 Standard Storage | 10 GB-month/month |
| R2 Class A Operations | 1,000,000 operations/month (writes, uploads, lists) |
| R2 Class B Operations | 10,000,000 operations/month (reads, downloads) |
| R2 Egress & Deletes | Free |

Allowances are shared across the Cloudflare account. R2 free allowances apply only to Standard storage.

### Cost Control & Production Recommendations

- Changing `POLL_INTERVAL_SECONDS` from 5 to 60 reduces background polling calls by ~92% at the cost of slower sync; focus restoration checks are unaffected.
- Delete unneeded files regularly; there is no automatic expiration or budget-based hard stop.
- Monitor Workers Metrics for calls and CPU, D1 Metrics for rows read/written and storage, and R2 Usage for GB-month and operations.
- Account-wide limits are shared; configure Cloudflare usage notifications.
- Unauthorized requests rejected by the Worker still consume invocations and D1 checks; application rate limiting does not prevent edge traffic surges.
- Estimates exclude custom domains, taxes, paid WAF, or external backups.

Official references: [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Static Assets Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 Pricing](https://developers.cloudflare.com/r2/pricing/).

## Local Development

Requires Node.js 22 or later.

```sh
cd easydrop
npm ci
npm run setup
npm run dev
```

`setup` interactively reads initial admin credentials in the terminal, writing them to `.dev.vars`.

`dev` uses local D1/R2 emulation under `.wrangler/`. Default address is `http://127.0.0.1:8787`; specify other ports via `npm run dev -- --port 8788`.

To reset local state, run `bash ../reset.sh easydrop --local` from the repository root, preserving `.dev.vars` credentials.

For quick temporary testing:

```sh
npm run preview
```

Preview generates a random port and one-time password, binding strictly to `127.0.0.1` and discarding data upon exit.

## Deployment

Complete R2 enablement, public route selection, and API Token creation in Cloudflare Dashboard before deploying. `deploy.sh` handles database creation, R2 setup, Worker deployment, migrations, and bindings.

### 1. Choose Public Access

| Route | Requirements | Deployed URL |
| --- | --- | --- |
| `workers.dev` | Initialize account-level `workers.dev` subdomain | `https://<worker-name>.<account-subdomain>.workers.dev` |
| Custom Domain | Active Zone in the same Cloudflare account with an unused hostname | e.g. `https://share.example.com` |

### 2. Enable R2

1. Log into [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to the target account.
2. Go to **Storage & databases → R2 → Overview**, or navigate directly to [R2 Overview](https://dash.cloudflare.com/?to=/:account/r2/overview).
3. On first use, follow the prompts to complete the R2 subscription checkout (**Add R2 subscription**, **Get started**, or **Continue**).
4. Return to R2 Overview and confirm that the **Create bucket** button appears. The deployment script creates `<worker-name>-files` and enforces private access.

![Cloudflare R2 Enablement Flow](docs/img/cloudflare/cloudflare-r2-enable.svg)

The R2 "subscription" activates the R2 product independently from your Workers plan. R2 Standard includes 10 GB-month storage, 1,000,000 Class A operations, and 10,000,000 Class B operations per month for free.

### 3. Prepare Access Domain

#### 3.1 Using workers.dev

1. Navigate to **Workers & Pages** in the target account.
2. Locate **Your subdomain**. Set it up on first use, or click **Change** to view/modify if already configured.
3. Choose an account-level subdomain (e.g. `my-account`), resulting in the suffix `my-account.workers.dev`.
4. Run the deployment script to create the Worker and obtain the full URL.

![Cloudflare workers.dev Subdomain Initialization Flow](docs/img/cloudflare/cloudflare-workers-dev.svg)

The `workers.dev` subdomain belongs to the entire account rather than an individual Worker. A Worker named `my-share` under `my-account` will be available at `https://my-share.my-account.workers.dev`.

#### 3.2 Using Custom Domain

1. Ensure the apex domain has been added to the same Cloudflare account with Zone status **Active**.
2. Prepare an unused hostname (e.g. `share.example.com`) for the deployment script to create the DNS record.
3. Enter the full hostname at the `Custom domain` prompt during deployment; the script attaches the domain via Wrangler, and Cloudflare automatically provisions DNS and edge certificates.

### 4. Create API Token

Create a **User API Token** under [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens/):

Base permissions:

| Scope | Permission | Level | Purpose |
| --- | --- | --- | --- |
| Account | Account Settings | Read | Discover accessible accounts |
| Account | Workers Scripts | Edit | Manage Worker, assets, and `INITIAL_ADMIN` secret |
| Account | D1 | Edit | Manage database and migrations |
| Account | Workers R2 Storage | Edit | Manage private R2 bucket |

Additional permissions required only for Custom Domains:

| Scope | Permission | Level | Purpose |
| --- | --- | --- | --- |
| Zone | Zone | Read | Verify Active Zone for the hostname |
| Zone | Workers Routes | Read | Allow Wrangler to verify route conflicts |

Include the target account in **Account Resources**, and the root domain zone in **Zone Resources** if using Custom Domains.

![EasyDrop Cloudflare API Token Scopes and Permissions](docs/img/cloudflare/cloudflare-api-token.svg)

### 5. Run Deployment

```sh
cd easydrop
bash deploy.sh
```

A single command manages dependencies, resource verification, database creation, migrations, build, and publishing.

Subsequent deployments reuse existing resources and prompt to confirm routes.

## Configuration

Configured in `wrangler.json` under `vars`:

| Key | Default | Allowed Range | Description |
| --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | `2592000` | 3600–31536000 | Sliding session TTL, default 30 days |
| `SESSION_RENEW_INTERVAL_SECONDS` | `900` | 60–86400 | Minimum session renewal interval |
| `MAX_UPLOAD_BYTES` | `209715200` | 1–209715200 | Per-file size limit (max 200 MiB) |
| `UPLOAD_CHUNK_BYTES` | `5242880` | 5242880–99614720 | Multipart chunk size (min 5 MiB) |
| `UPLOAD_CONCURRENCY` | `3` | 1–6 | Concurrent parts per file |
| `UPLOAD_FILE_CONCURRENCY` | `3` | 1–4 | Concurrent uploading files |
| `UPLOAD_SESSION_TTL_SECONDS` | `86400` | 3600–518400 | Idle upload session recovery window |
| `MAX_TEXT_BYTES` | `131072` | 1–1048576 | Per-text size limit (128 KiB) |
| `POLL_INTERVAL_SECONDS` | `5` | 5–3600 | Visible history poll interval |
| `LOGIN_WINDOW_SECONDS` | `900` | 60–86400 | Login rate limit window |
| `LOGIN_IP_LIMIT` | `10` | 1–1000 | Max login attempts per IP |
| `LOGIN_GLOBAL_LIMIT` | `100` | 1–10000 | Max global login attempts |
| `ACCOUNT_ACTION_WINDOW_SECONDS` | `900` | 60–86400 | Registration and recovery window |
| `REGISTRATION_IP_LIMIT` | `5` | 1–1000 | Max registrations per IP |
| `REGISTRATION_GLOBAL_LIMIT` | `25` | 1–10000 | Max global registrations |
| `PASSWORD_RESET_IP_LIMIT` | `10` | 1–1000 | Max password resets per IP |
| `PASSWORD_RESET_GLOBAL_LIMIT` | `100` | 1–10000 | Max global password resets |
| `HISTORY_PAGE_SIZE` | `10` | 1–50 | Page size (capped at 10) |
| `CLEANUP_BATCHES` | `4` | 1–8 | Cleanup batches per cron execution |
| `ALLOW_LOCAL_HTTP` | `false` | `true` / `false` | Local development HTTP override |

## Authentication & Security

- Passwords require 12–32 characters with uppercase, lowercase, and numeric characters, salted and hashed using 100,000 PBKDF2-SHA-256 iterations.
- Sessions use 256-bit random tokens stored in production with `__Host-`, `HttpOnly`, `Secure`, and `SameSite=Lax`. All mutating requests require same-origin verification and CSRF tokens.
- Rate limiting enforces per-IP and global caps via atomic D1 writes.
- R2 buckets remain strictly private with no public URLs; downloads are validated and streamed through Workers.

## API Reference

All APIs share origin with the frontend. "Write validation" requires session cookies, same-origin headers, and `X-CSRF-Token`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` / `HEAD` | `/`, `/index.html` | None | Application shell |
| `GET` / `HEAD` | `/login`, `/register`, `/reset-password` | None | Auth pages |
| `GET` | `/api/auth/config` | None | Registration availability check |
| `POST` | `/api/login` | Same-origin | Authenticate and set session cookie |
| `POST` | `/api/register` | Same-origin | Register pending user and return recovery code |
| `POST` | `/api/password/reset` | Same-origin | Reset password via recovery code |
| `GET` | `/api/bootstrap` | Session | Session configuration and first-page history |
| `GET` | `/api/session` | Session | Current user, CSRF token, expiry, config |
| `POST` | `/api/logout` | Write check | Invalidate current session |
| `POST` | `/api/account/password` | Write check | Change password and revoke all sessions |
| `POST` | `/api/account/recovery-code` | Write check | Generate or rotate recovery code |
| `DELETE` | `/api/account` | Write check | Self-delete account and schedule cleanup |
| `PATCH` | `/api/settings/registration` | Admin | Toggle self-registration |
| `GET` / `POST` | `/api/users` | Admin | List or create users |
| `PATCH` / `DELETE` | `/api/users/<id>` | Admin | Update, toggle, or delete users |
| `GET` | `/api/revision` | Session | User content revision |
| `GET` | `/api/history?before=<seq>` | Session | Paginated user history |
| `POST` | `/api/text` | Write check | Create text share |
| `POST` | `/api/uploads` | Write check | Initialize or resume multipart upload |
| `GET` | `/api/uploads/<id>` | Session | Upload session status and confirmed parts |
| `PUT` | `/api/uploads/<id>/preview` | Write check | Upload WebP thumbnail (1–524,288 bytes) |
| `PUT` | `/api/uploads/<id>/parts/<number>` | Write check | Upload binary part with `X-Part-SHA256` |
| `POST` | `/api/uploads/<id>/complete` | Write check | Finalize multipart upload and publish record |
| `DELETE` | `/api/uploads/<id>` | Write check | Abort upload and schedule cleanup |
| `GET` / `HEAD` | `/previews/<id>` | Session | Stream thumbnail bitmap |
| `GET` / `HEAD` | `/images/<id>/<filename>` | Session | Stream original image preview |
| `GET` / `HEAD` | `/uploads/<id>/<filename>` | Session | Download file or inspect metadata |
| `POST` | `/api/history/<id>/share` | Write check | Create 1–168h temporary link |
| `DELETE` | `/api/history/<id>/share` | Write check | Revoke temporary link |
| `GET` / `HEAD` | `/shared/<token>/<filename>` | None | Download file via temporary token |
| `DELETE` | `/api/history/<id>` | Write check | Delete single record and its files |
| `POST` | `/api/clear_history` | Write check | Clear all user records and schedule cleanup |

## Project Structure & Commands

| Path | Purpose |
| --- | --- |
| `src/worker.js` | Routing, sharing, file APIs, scheduled cleanup |
| `src/auth.js` | Password hashing, sessions, CSRF, rate limiting |
| `web/` | Web application frontend, styles, and assets |
| `migrations/` | Baseline D1 database schema |
| `scripts/build.mjs` | Frontend build, asset hashing, Service Worker |
| `scripts/manage.mjs` | Local admin setup and interactive deployment |
| `scripts/cloudflare.mjs` | Cloudflare API, account discovery, resource provisioning |
| `scripts/preview.mjs` | Isolated temporary local preview |
| `test/` | API, deployment protocol, and browser tests |
| `wrangler.json` | Worker template, bindings, configuration, cron |
| `deploy.sh` | One-command interactive deployment script |

## FAQ

| Issue | Resolution |
| --- | --- |
| Returns `503` (initial admin missing) | Run `npm run setup` locally; fix Token permissions and rerun `bash deploy.sh` remotely |
| Login throttled (too many attempts) | Wait out `Retry-After`; devices sharing an egress IP share the quota |
| Multipart upload at 100% displays "Merging" | R2 completion and D1 record publishing in progress; wait for confirmation |
| Upload fails | Check error details for status and message; retrying transmits only unconfirmed parts |
| Resuming uploads after refresh | Re-select the original file within 24h; browser matches upload ID and verifies parts |
| History polling stopped | Paused when hidden or uploading; resumes automatically upon tab focus |
| Deleted files still occupy R2 storage | Access revoked immediately; physical files are deleted in batches by cron |
| Phone cannot access local QR code | `127.0.0.1` is loopback; deploy to an HTTPS domain for cross-device access |
| Token fails account discovery | Provide Account ID explicitly when prompted; verify required token permissions |
| Custom Domain returns `10000` on `/workers/routes` | Add **Zone / Workers Routes / Read** to token and include root zone in Zone Resources |

## Verification

```sh
npm run check
npm test
npm run test:ui
```

`npm test` runs API integration tests using workerd, D1, and R2 emulation. `test:ui` runs Playwright browser tests across desktop and mobile viewports.
