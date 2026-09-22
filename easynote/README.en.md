# EasyNote

[简体中文](README.md) | [English](README.en.md)

Current Version: `0.7.4`

A self-hosted Markdown note-taking application for individuals or small teams. React + TypeScript frontend, pdfmake PDF generation with PDF.js paginated preview, Cloudflare Worker API, D1 database for accounts and notes, and private R2 object storage for images and attachments.

## 0.7.4 Updates

- **Enhanced Tag Picker Interaction**: The tag selection popover now supports pressing `ESC` or clicking outside to dismiss, auto-focuses the search input upon opening, and includes a dedicated close button.
- **UI Polish & i18n Fixes**: Fixed the "Reopen" primary button styling and English translation on the multi-tab lock screen; resolved edge-clipping of tooltips (e.g. `Move to Trash`) on the rightmost toolbar button.

## 0.7.3 Updates

- **Modal Title & Layout Optimizations**: Fixed modal dialog titles (e.g. Move to Trash) to translate directly in the React VDOM layer; optimized sidebar width (adjusted to 200px) and toolbar button sizes, with note list headers set to single-line ellipsis to prevent wrapping on longer English titles like `Archived Notes`; added translations for icon button tooltips and fixed settings panel text wrapping.

## 0.7.2 Updates

- **i18n & Localization Fixes**: Date and time formatting in English mode dynamically uses `'en-US'`; enabled `data-tooltip` and `alt` attribute translations; reordered phrase dictionary to resolve substring precedence conflicts (e.g. tag operations, revision notices, size limits, and conflict copy suffixes); added missing dynamic notices and error translations.

## 0.7.1 Updates

- **Fixed Desktop Layout**: Resolved an issue where mobile navigation, search, and compose controls were inadvertently visible on desktop screens, causing note list title wrapping and extraneous controls. Restored proper word count styling.

## 0.7.0 Updates

- **Redesigned Tag Management**: Brand new "Manage Tags" dialog with dedicated support for Add, Edit (rename), Merge, and Delete operations, along with a full tag list overview.
- **Refined Note-level Tagging**: Note footer tags are now rendered as clean Tag Chips; supports single-note tagging, untagging, and on-the-fly tag creation, eliminating any risk or confusion around deleting global tags from a single note.

## 0.6.0 Updates

- Tag management now supports multi-select, including selecting and removing existing tags.
- The UI defaults to Chinese and can switch to English in Settings, with desktop and 320px mobile layouts adapted for longer English labels.

## 0.5.1 Updates

- Moved the existing-tag selector to the left of the tag input and fixed clipped selector text.

## 0.5.0 Updates

- Note tags can now be selected directly from existing tags while retaining free-form input and multiple-tag support.

## 0.4.4 Updates

- Note list announces only titles and update timestamps to screen readers, eliminating full body summary readouts.
- Online and offline note lists load in batches of 50, using "Load More" on demand to reduce initial rendering overhead for large offline libraries.
- Restored update timestamps in mobile note list view for clearer note freshness.

## 0.4.0 - 0.4.3 Updates

- **Remote MCP Tools & Resources**: Integrates with AI via standard Model Context Protocol (MCP), providing permission-scoped search, batch reading, and controlled note modifications.
- **Durable Object Real-Time Notifications**: Broadcasts note mutations across devices in milliseconds via WebSocket, demoting periodic polling to a disconnection fallback.
- **Task Center**: Aggregates Markdown TODO items across all notes with one-click navigation to source lines.
- **Configuration & Stability**: Optimized Codex MCP routing, fixed exact note counts, and improved offline attachment loading performance.

## 0.3.2 Updates

- Optimized startup and refresh: Parallelizes local offline session reads and server session validation. Shows cached notes immediately when available; resumes background sync post-validation, purging stale caches upon logout or account switch.
- Streamlined session API: Skips account initialization checks for valid sessions; verifies sessions and registration availability in parallel.
- Non-blocking attachment caching: Displays local notes immediately and updates the list once text sync completes; images and attachments cache in the background with 30s timeouts.

## 0.3.1 Updates

- Unified modal feedback layer: Displays success and error messages directly at the top of active dialogs without overlay obstruction.
- Verified desktop and 320px mobile layouts across sharing, tags, account, and security modals.

## Implemented Features

- Multi-tenant model: Initial admin provisioning, user management, approval-based registration (disabled by default), recovery codes, account deletion, HttpOnly session cookies, CSRF, origin checks, and login rate limiting. Notes, versions, attachments, offline caches, and AI tokens are strictly tenant-isolated.
- Note creation, standalone title, Markdown editing/preview, checkable tasks, autosave, pin to top, archive, tags, and full-text keyword search.
- Task Center: Aggregates incomplete Markdown TODOs with source note and line number references, with direct jump-to-source support.
- Single blank note rule: Keeps at most one completely blank note per account; creating a new note reuses an existing blank note if present.
- CodeMirror 6 editor, markdown-it parsing with DOMPurify sanitization, supporting footnotes, code highlighting, and safe HTML blocks.
- Mermaid diagrams: Flowcharts, mindmaps, and other Mermaid charts rendered on-demand in preview mode.
- Image pasting, drag-and-drop, and file selection (JPEG, PNG, WebP); private attachments (PDF, Markdown, TXT, CSV, JSON); inserted at cursor position.
- PDF export with authentic paginated preview, A4/Letter formats, portrait/landscape orientation, and scaling; direct download on desktop, system share sheet on iOS/Android.
- Trash bin, restore, permanent deletion, and tombstone records preventing stale devices from resurrecting purged notes.
- Revision-based concurrency control, 3-way merge from base revisions, manual conflict resolution with conflict copies, idempotent retries, manual snapshot history, and version restore.
- Full offline note library (enabled by default): IndexedDB mirrors note content, private files, full-text search, and pending drafts, automatically submitting changes upon reconnecting.
- Durable Object WebSockets broadcast mutation signals (create, update, delete) per account; clients fetch authoritative data upon notification. Foreground polling and focus restoration act as fallbacks.
- Installable PWA with standalone window, home screen icon, app shell caching, and offline cold start.
- Searchable command palette (`Cmd/Ctrl+K`), document outline, stable internal links (`[[UUID|Title]]`), and backlinks.
- Tag renaming, merging, deletion, plus batch archive and tagging.
- AI read/write integration: Restricted tokens, exact note statistics, cross-status FTS5 relevance search, match character ranges, batch reading, MCP Resources, and writing tools. AI edits enter version history.
- Desktop/mobile layouts, light/dark themes, ZIP export/recovery, and import support for Obsidian directories, Markdown/TXT ZIPs, and individual files.
- Revocable time-limited or permanent read-only share links with centralized management.
- Scheduled cleanup of expired sessions, share links, login counters, unreferenced files, failed uploads, and deleted tenant data.

## Project Structure

```text
easynote/
├── src/
│   ├── client/
│   │   ├── App.tsx            # Login, workspace, settings, and dialogs
│   │   ├── Editor.tsx         # CodeMirror and sanitized Markdown preview
│   │   ├── useNotebook.ts     # Autosave, revision conflicts, list, polling
│   │   ├── merge.ts           # 3-way merge and conflict detection
│   │   ├── drafts.ts          # IndexedDB drafts, offline mirror, private files
│   │   ├── api.ts             # API client, error handling, private file uploads
│   │   ├── pdf.ts             # Structured PDF generation and paginated preview
│   │   ├── transfer.ts        # ZIP export, validation, remapping, import
│   │   ├── UserManagement.tsx  # Admin user and registration management
│   │   ├── NoteSharing.tsx     # Single-note read-only sharing
│   │   ├── ShareManagement.tsx # Share list, renewal, and revocation
│   │   ├── styles.css
│   │   └── main.tsx
│   ├── worker/
│   │   ├── index.ts           # Request routing and Cron triggers
│   │   ├── auth.ts            # Multi-user, sessions, recovery, admin, rate limits
│   │   ├── events.ts          # Durable Object WebSocket mutation notifications
│   │   ├── features.ts        # Task center and read-only sharing
│   │   ├── integrations.ts    # AI tokens, snapshots, delta sync, controlled writes
│   │   ├── notes.ts           # Notes, tags, versions, soft delete, purging
│   │   ├── images.ts          # Private files, quota reservation, cleanup
│   │   └── core.ts            # Config validation, limits, errors, shared types
│   ├── ai/
│   │   ├── index.ts           # Remote MCP tools and Resources
│   │   └── client.ts          # MCP internal API client
│   └── shared/types.ts
├── docs/AI_INTEGRATION.md     # User and AI integration guide
├── docs/DISASTER_RECOVERY.md  # Backup and disaster recovery procedures
├── migrations/                # D1 schema baseline
├── scripts/                   # Setup, maintenance, Cloudflare API, deployment
├── test/                      # Integration and UI tests
├── setup.sh                  # Prepare local dependencies and admin
├── dev.sh                    # One-command local development server
├── deploy.sh                 # Interactive production deployment
├── backup.sh                 # Interactive D1/R2 disaster recovery backup
├── restore.sh                # Backup verification and restore
├── reset-password.sh         # Interactive password recovery
├── wrangler.json             # Worker config, bindings, and environment variables
├── vite.config.ts
└── playwright.config.ts
```

## Local Development

Requires Node.js 22.12 or later and Bash (macOS / Linux).

```bash
cd easynote
bash dev.sh
```

First launch automatically installs dependencies and interactively prompts for initial admin credentials, builds the frontend, applies D1 migrations, and starts the service. Access at `http://127.0.0.1:8791`.

| Command | Description |
| --- | --- |
| `bash setup.sh` | Install dependencies and initialize admin without starting the server |
| `bash dev.sh` | Start local development server (auto-initializes if unconfigured) |
| `bash dev.sh --port 8793` | Start on custom port |
| `bash deploy.sh` | Interactive production deployment |
| `bash deploy.sh --check` | Local build and Wrangler preflight checks |
| `bash reset-password.sh --local` | Reset local account password |
| `bash reset-password.sh --remote` | Reset remote account password |
| `bash ../reset.sh easynote --local` | Clear local D1/R2 state while preserving admin config |
| `bash ../reset.sh easynote --remote` | Reset remote Cloudflare D1/R2 and Worker |
| `bash backup.sh --remote` | Create and verify full D1/R2 disaster recovery backup |
| `bash restore.sh <dir> --remote --check` | Preflight check for backup restoration |
| `bash restore.sh <dir> --remote` | Restore backup to empty D1/R2 resources |
| `npm run test:ai` | Test remote Streamable HTTP MCP integration |

### Version Management

Versions are maintained in [`versions.json`](../versions.json) at the repository root:

```bash
node scripts/version.mjs bump easynote patch
node scripts/version.mjs check
git add .
git commit -m "发布：EasyNote v0.4.4"
```

## Production Deployment

### 1. Enable R2

When using R2 for the first time, log into [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Storage & databases → R2 → Overview**, and complete the R2 subscription checkout. Once the **Create bucket** button appears, return to your terminal; manual bucket creation is not required.

![EasyNote Cloudflare D1, R2, and workers.dev Resource Preparation](docs/img/cloudflare/cloudflare-resources.svg)

The deployment script automatically discovers accounts based on your Token, creates or reuses dedicated `easynote-db` and private `easynote-images`, and retrieves the D1 UUID.

### 2. Choose Public Access

- Leave blank for `workers.dev` (creates an account-level subdomain if absent).
- Enter a custom domain (e.g. `notes.example.com`), which must belong to an Active Zone in the same account.

### 3. Create Custom API Token

Create a Custom API Token under [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens/):

- Account Settings: Read (to discover accounts)
- Workers Scripts: Edit (to create/update Worker, assets, and secrets)
- D1: Edit (to manage database and migrations)
- Workers R2 Storage: Edit (to manage private R2 bucket)
- (Custom Domain only) Zone: Read
- (Custom Domain only) Workers Routes: Read

![EasyNote Cloudflare API Token Scopes and Permissions](docs/img/cloudflare/cloudflare-api-token.svg)

### 4. Deploy

```bash
bash deploy.sh
```

Follow the prompts to enter your API Token, select or confirm resources, and finalize deployment.

## Key Behaviors

### Autosave & Conflicts

Autosave updates note content with `createVersion: false`. Explicit saves (`Cmd/Ctrl+S` or "Sync and Update Version") set `createVersion: true` to snapshot history. AI writes enforce version creation. Duplicate content does not create redundant history snapshots.

Simultaneous edits on different devices are resolved using revision numbers. Conflicts return `409 Conflict`, preserving local drafts and allowing users to branch into conflict copies without overwriting remote data.

### Shortcuts & Knowledge Links

`Cmd/Ctrl+K` opens the quick command palette for navigation, actions, search, and settings.

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+S` | Save, sync, and record version snapshot |
| `Ctrl+E` / `Cmd/Ctrl+Enter` | Toggle edit and preview mode (retains cursor position) |
| `Cmd/Ctrl+B` / `Cmd/Ctrl+I` | Toggle bold / italic in editor |
| `Cmd/Ctrl+P` | Export current note as PDF |
| `Cmd/Ctrl+/` | View keyboard shortcuts |
| `Esc` | Close dialogs |

Internal links use `[[Note UUID|Display Title]]`. Backlinks are automatically calculated across all active notes.

### AI Integration (MCP)

EasyNote supports Model Context Protocol (MCP) natively:

1. Generate a token under "Settings → AI Integration" in the web app.
2. Connect your AI client (e.g. Codex) to `https://your-domain/mcp` using Bearer authentication.
3. AI agents gain permission-scoped access to search, read, create, or modify notes through standard MCP tools and resources. See [`docs/AI_INTEGRATION.en.md`](docs/AI_INTEGRATION.en.md) for full details.

## Configuration

Configured in `wrangler.json` under `vars`:

| Key | Default | Description |
| --- | --- | --- |
| `MAX_NOTE_BYTES` | 262144 | Maximum note body size (256 KiB) |
| `MAX_IMAGE_BYTES` | 8388608 | Maximum image size (8 MiB) |
| `MAX_IMAGE_PIXELS` | 40000000 | Maximum image pixels (40 MP) |
| `MAX_ATTACHMENT_BYTES` | 20971520 | Maximum attachment size (20 MiB) |
| `IMAGE_QUOTA_BYTES` | 1073741824 | Per-user R2 file quota (1 GiB) |
| `MAX_NOTES` | 5000 | Maximum notes per user (including trash) |
| `VERSIONS_KEPT` | 20 | Maximum historical snapshots per note |
| `IMAGE_GRACE_HOURS` | 168 | Retention grace period for unreferenced files |
| `SESSION_DAYS` | 30 | Session expiration duration in days |
| `AUTOSAVE_MS` | 1000 | Autosave delay after typing stops |
| `POLL_SECONDS` | 30 | Foreground sync polling fallback interval |
| `LOGIN_WINDOW_SECONDS` | 900 | Login attempt rate limit window |
| `LOGIN_IP_LIMIT` | 20 | Login attempts per IP within window |
| `LOGIN_GLOBAL_LIMIT` | 200 | Global login attempts within window |

## Verification

```bash
bash deploy.sh --check
npm run build
npm test
npm run test:ai
npm run test:scripts
npx playwright install chromium
npm run test:ui
```
