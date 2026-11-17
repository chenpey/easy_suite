# EasyNote

[简体中文](README.md) | [English](README.en.md)

Current Version: `1.6.2`

A self-hosted Markdown note application for individuals and small teams. The frontend is built with React 19 + TypeScript + Vite as an installable PWA; the backend runs on a Cloudflare Worker serving APIs, remote MCP, OAuth, and static assets; D1 stores accounts and notes, R2 stores private images and attachments, a Durable Object broadcasts change signals, and a Cron trigger cleans expired data hourly.

## Key Capabilities

- **Writing & Editing**: CodeMirror 6 with three modes (Source / Live Preview / Reading, Live Preview by default), 500 ms autosave, pinning, archiving, tags, trash, outline, backlinks, stable internal links `[[UUID|Title]]`, `[TOC]`, KaTeX math, Mermaid/Pele diagrams (exportable as SVG/PNG), version history (20 snapshots kept by default), and multi-device WebSocket sync.
- **Images & Attachments**: Private images (JPEG / PNG / WebP, up to 8 MiB) and attachments (PDF / Markdown / TXT / CSV / JSON / ZIP, up to 20 MiB each, 10 files / 100 MiB per note); right-click "Download Note" exports `.md` or `.zip` with `attachments/`.
- **Organization & Search**: Up to 5 folder levels, drag-and-drop and `Alt+↑/↓` manual ordering, global search (`Cmd/Ctrl+K`), quick open (`Cmd/Ctrl+O`), and Task Center (aggregating open TODOs).
- **Sharing & AI Integration**: Time-limited (1 hour to permanent) read-only share links; remote Streamable HTTP MCP at `/mcp` with OAuth (PKCE S256) for Codex, ChatGPT, and other MCP clients.
- **Offline & PWA**: Standalone installable PWA with cold-start offline support; per-account IndexedDB mirrors notes and private files for offline editing and idempotent three-way merge upon reconnect.
- **Accounts & Ops**: Multi-tenant isolation, admin-approved registration, recovery codes, ZIP v3 / Obsidian / Markdown import & export, paginated PDF export, `backup.sh`, and `restore.sh`.

## Architecture

```text
Browser / PWA (React 19 + TypeScript + Vite)
   │  HTTPS: /api/*  /mcp  /oauth/*  / Static Assets
   ▼
Cloudflare Worker (src/worker, src/ai)
   ├── D1              Accounts, sessions, notes, versions, folders, sync seq, FTS5, shares, tokens
   ├── R2              Private images & attachments (<user_id>/<file_id>)
   ├── Durable Object  NoteEvents: per-account change broadcast (WebSocket Hibernation)
   └── Cron (hourly)   Cleanup of expired sessions, shares, unreferenced files, and deleted tenants
```

<details>
<summary>Directory Structure</summary>

```text
src/
├── client/     # React workspace, CodeMirror editor, 3-way merge, IndexedDB mirror, PDF, transfer
├── worker/     # Routing, auth, notes, Durable Object, private files, OAuth, sharing, AI APIs
├── ai/         # Remote MCP tools and resources
└── shared/     # Shared types and limits
migrations/     # D1 schema and incremental migrations (0001–0005)
scripts/        # setup / maintenance / cloudflare / deploy orchestration
test/           # Miniflare API, Playwright UI, and script tests
```

</details>

## Quick Start

Requires Node.js 22.12+:

```bash
cd easynote
bash dev.sh    # Installs deps, sets up local admin, and starts at http://127.0.0.1:8791
```

Common scripts (all support `--help`):

| Command | Purpose |
| --- | --- |
| `bash setup.sh` | Install dependencies and configure local admin |
| `bash dev.sh [--port 8793]` | Start local dev server (run `npm run dev:client` in another terminal for HMR) |
| `bash deploy.sh` / `bash deploy.sh --check` | Interactive production deploy / local build and preflight check |
| `bash reset-password.sh --local` / `--remote` | Interactively reset password and revoke sessions & AI tokens |
| `bash backup.sh --remote` | Create and verify full D1/R2 backup |
| `bash restore.sh <dir> --remote [--check]` | Preflight or execute restore to empty D1/R2 |
| `bash reset.sh --local` / `--remote` | Reset local or remote resources after confirmation |

## Deploy to Cloudflare

1. **Enable R2**: Complete R2 activation in Cloudflare Dashboard under **Storage & databases → R2 → Overview**.
2. **Choose Public Entry**: Use a `workers.dev` subdomain or an active custom domain (e.g., `notes.example.com`).
3. **Create API Token** ([API Tokens](https://dash.cloudflare.com/profile/api-tokens/)):
   - Account permissions: `Account Settings (Read)`, `Workers Scripts (Edit)`, `D1 (Edit)`, `Workers R2 Storage (Edit)`.
   - Zone permissions (for Custom Domain): `Zone (Read)`, `Workers Routes (Read)`.
4. **Deploy**: Run `bash deploy.sh` in `easynote/`, enter the hidden token, and confirm changes. For future updates, run `git pull --ff-only` followed by `bash deploy.sh`.

Personal instances under 1,000 notes typically fit within Workers Free, D1 Free, and R2 Standard free tiers (setting `VERSIONS_KEPT` to 5–10 leaves generous D1 headroom).

## Configuration

Server parameters are configured in `wrangler.json` under `vars`:

| Parameter | Default | Description |
| --- | --- | --- |
| `MAX_NOTE_BYTES` / `MAX_NOTES` | `262144` / `5000` | Max note body (256 KiB) / max notes per account |
| `MAX_IMAGE_BYTES` / `MAX_IMAGE_PIXELS` | `8388608` / `40000000` | Max image size (8 MiB) / max 40M pixels |
| `MAX_ATTACHMENT_BYTES` / `IMAGE_QUOTA_BYTES` | `20971520` / `1073741824` | Max attachment (20 MiB) / R2 quota per account (1 GiB) |
| `VERSIONS_KEPT` / `IMAGE_GRACE_HOURS` | `20` / `168` | Retained snapshots per note / unreferenced file grace period (hours) |
| `SESSION_DAYS` / `AUTOSAVE_MS` / `POLL_SECONDS` | `30` / `500` / `30` | Session lifetime (days) / autosave delay / poll interval |
| `LOGIN_WINDOW_SECONDS` / `LOGIN_IP_LIMIT` / `LOGIN_GLOBAL_LIMIT` | `900` / `20` / `200` | Login rate-limit window and budgets |
| `ALLOW_LOCAL_HTTP` | `false` | Set `true` for local loopback development |

## API Overview

Browser write endpoints verify same-origin `Origin` and `X-CSRF-Token`; AI endpoints use Bearer tokens. All data is isolated by account.

| Method / Path | Purpose |
| --- | --- |
| `GET /api/session`, `POST /api/login` / `logout` / `register` | Session state, login, logout, registration |
| `POST /api/account/password` / `logout-all` / `recovery-code` / `reset-password`, `DELETE /api/account` | Password, recovery code, and account management |
| `GET/POST /api/admin/users`, `PATCH/DELETE /api/admin/users/:id`, `PATCH /api/admin/settings/registration` | Admin user management and registration toggle |
| `GET /api/events`, `GET /api/sync`, `GET /api/sync/cursor` | WebSocket change notifications and incremental sync |
| `GET /api/notes`, `POST/GET/PUT/DELETE /api/notes/:id`, `GET /api/tasks` | Note CRUD, search, and Task Center |
| `GET /api/notes/:id/versions`, `backlinks`, `GET /api/tags`, `POST /api/notes/duplicates` | Version history, backlinks, tags, and duplicate check |
| `GET /api/shares`, `GET/POST/PATCH/DELETE /api/notes/:id/share`, `GET /api/public/shares/:token` | Read-only share management and public access |
| `PUT/GET /api/images/:id`, `PUT/GET /api/files/:id` | Private image and attachment upload/download |
| `GET/POST/DELETE /api/integrations/tokens`, `GET/POST/PUT /api/integrations/notes*` | AI token management and controlled note access |

## Syntax & Shortcuts

| Syntax / Shortcut | Behavior |
| --- | --- |
| `- [ ] Todo` / `- [x] Done` | Toggle interactively in Reading or Live Preview |
| `[[Note UUID\|Display Title]]` | Stable internal link |
| `[TOC]` (own paragraph) | Clickable table of contents |
| `$x^2$` / `$$...$$` / ` ```mermaid ` | KaTeX math / Mermaid diagrams (saveable as SVG/PNG) |
| `Cmd/Ctrl+K` / `Cmd/Ctrl+O` | Global search / Quick Open |
| `Cmd/Ctrl+S` / `Cmd/Ctrl+E` / `Cmd/Ctrl+P` | Save version / Toggle edit & read / Export PDF |
| `Cmd/Ctrl+Enter` / `Cmd/Ctrl+Shift+K` | New note in folder / Insert internal link |
| `Cmd/Ctrl+\` / `Cmd/Ctrl+.` / `Cmd/Ctrl+Shift+L` | Toggle sidebar / Outline & backlinks / Theme |

Importable examples are available in [`examples/`](examples/).

## Verification

```bash
bash deploy.sh --check
npm run build          # Type check + i18n check + build
npm test               # API and AI tests
npm run test:scripts   # Script workflow tests
npm run test:ai        # Remote Streamable HTTP MCP tests
npx playwright install chromium && npm run test:ui
```

## Further Reading & Versioning

- Release History: [`CHANGELOG.en.md`](CHANGELOG.en.md)
- AI / MCP Integration: [`docs/AI_INTEGRATION.en.md`](docs/AI_INTEGRATION.en.md)
- Backup & Recovery: [`docs/DISASTER_RECOVERY.en.md`](docs/DISASTER_RECOVERY.en.md)

To bump and verify versions from the repository root:

```bash
node scripts/version.mjs bump easynote patch
node scripts/version.mjs check
```
