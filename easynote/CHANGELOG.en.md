# Changelog

Full release history. The latest release is summarized in the [README](README.md).

## 1.4.2 Release Notes (2026-10-25)

- Fix dialogs opening with the focus on the top-right close button: the Quick Open search field now takes the focus after `Cmd/Ctrl+O`, so typing filters right away, ↑/↓ selects, the close button no longer shows a stray selection box and Enter does not close the dialog by accident.
- When a dialog has no field to type into, the dialog itself takes the initial focus and the panel is not outlined; `Tab` still reaches the close button first and `Esc` still closes the dialog.
- The bulk tag, folder create/rename and internal link dialogs also land in their own field again.
- Frontend focus and styling only. The server API, data format, archive format and database schema are unchanged, and no migration is required.

## 1.4.1 Release Notes (2026-10-19)

- Remove generated `1.` and `1.1` counters from the contents list and retain hierarchy through indentation, avoiding duplicate numbering when headings already include their own numbers.
- Fix the nested contents lists missing their style class, so every level uses the same unnumbered indentation; navigation, shares, the reader window and PDF export are unchanged.
- Frontend contents styling and regression coverage only. No database migration is required.

## 1.4.0 Release Notes (2026-10-19)

- Add note contents: a `[TOC]` paragraph of its own (blank lines around it) builds a clickable table of contents in preview, read-only shares, the independent reader window and PDF export. Entries nest by heading level and scroll to their heading. Headings inside blockquotes are skipped, empty headings are dropped, `[TOC]` inside code blocks or inline text stays literal, and a note without headings shows "No headings".
- The contents block is built with DOM APIs after DOMPurify sanitising and only writes heading text plus fixed attributes, so the existing XSS defences are unchanged. Search highlighting now runs after the contents are injected, so a search that matches `[TOC]` no longer removes the contents block.
- Save diagrams as images: every diagram in preview and shared pages can be exported as SVG or PNG. SVG stays vector-based and smaller; PNG pastes easily into software without SVG support. Exports keep the current theme colours and fonts and inline the background, so dark-theme diagrams do not lose their lines on white.
- Export filenames combine the note title with the diagram index and strip unsafe characters; exports contain no external links or external images.
- Add browser regressions for the contents structure (including continuous numbering across skipped heading levels), an empty contents block, contents surviving a search, contents scrolling in shares and the reader window, contents entries present in the exported PDF text, and diagram SVG / PNG export.
- Compatibility: frontend rendering, interaction and documentation only. The server API, data format, archive format and database schema are unchanged, and no migration is required.

## 1.3.12 Release Notes (2026-10-18)

- Fix the offline library replacing its list with a load failure once the connection drops. An unreachable background sync now keeps showing the mirrored notes, while the offline badge and the background sync notice remain. Previously browsing offline emptied the mirrored list until a manual retry.
- Replace Mermaid with Pele as the diagram renderer. Diagram code ships as one ~685 kB chunk (~255 kB gzip) instead of several lazy chunks (its layout engine alone was ~1.5 MB), reducing the offline precache and the first-preview download.
- Theme diagrams through CSS variables: switching between light and dark takes effect immediately and no longer re-renders up to 20 diagrams.
- Tighten diagram output sanitizing. The new renderer emits no `<style>` element, so that allowance is removed and only the `role` attribute needed for accessibility is kept. Diagram links and external images stay disabled, and diagram text stays escaped.
- Keep the existing injection defenses and the limits of 20 diagrams and 50,000 characters per source. Add browser regressions for a broken diagram and for the 21st diagram reporting an inline error.
- Compatibility: Pele targets Mermaid 12.1 syntax and all 25 example diagram blocks in this repository render. A few older constructs (for example `url(...)` inside `classDef` or `linkStyle`) fail to parse and show an inline error without affecting the rest of the note. Import [`examples/mermaid-all-types-demo.md`](examples/mermaid-all-types-demo.md) to check 20 common diagram types.
- This release only changes frontend rendering and documentation. No database migration is required, and the server API, data format and archive format are unchanged.

## 1.3.11 Release Notes (2026-10-17)

- Arrange bulk actions in two equal-width columns, giving Archive, Add Tag, Move Notes and Delete one cell each without leaving Delete alone on a row or wrapping button labels.
- Highlight the selected count with a subtle badge and use borderless Select All and Cancel controls. Keep disabled actions neutral, showing the danger color only when Delete is enabled. Wrap selection controls together in narrow lists and retain touch targets at least 44px high on mobile.
- Add layout regressions in both languages and themes, covering 220/300px desktop lists and 320/390px mobile viewports. Verify button alignment, single-line labels, disabled states and containment. This UI update requires no database migration.

## 1.3.10 Release Notes (2026-10-17)

- Fix internal note links after web ZIP restores. Allocate destination UUIDs before saving and remap links to new or deduplicated existing notes, preserving self-links and cycles. Recheck fingerprints when reimporting ordinary linked chains; reimporting an old ZIP containing self-links or cycles may still create additional copies.
- Toggle preview tasks using source lines from the Markdown parser, covering blockquotes, ordered and nested lists, and tasks starting on continuation lines without modifying examples inside fenced or indented code blocks.
- Precache Mermaid diagram and shared chunks along with syntax-highlighting scripts, allowing previously unopened diagrams to render on their first offline preview. Initial cache downloads grow accordingly; PDF engines and fonts remain cached on demand.
- Request persistent storage in the authenticated editor and show the result in Settings. Unsupported APIs, denied requests and permission errors do not block editing or saving; prompt users to export unsynced drafts. Persistent storage does not prevent manual site-data clearing.
- Add regressions for ZIP links and deduplication, task source positions, offline diagrams and highlighting, and storage permissions. Update both language guides. No new database migration is required.

## 1.3.9 Release Notes (2026-10-17)

- Reduce width and spacing in the Move Note and Move Folder dialogs. Make folder options clickable and highlighted across the full row, align root and nested folder indentation, and provide mobile rows at least 44px high.
- Center regular success notices near the top of the screen for better visibility. Retain the shared two-second duration configuration, feedback within dialogs, and error dismissal and retry behavior.
- Add desktop and mobile move regressions covering full-row clicks, touch target height, and success notices remaining within the viewport and unobscured. No new database migration is required.

## 1.3.8 Release Notes (2026-10-17)

- Fix an "Operation Incomplete" error after a note move has saved successfully but the subsequent list refresh fails. Close the move dialog on success and retain a retry action in the list for refresh failures; actual save failures still report an error.
- Unify success notices and "Copied" feedback at two seconds, configured through `SUCCESS_FEEDBACK_DURATION_MS` in `src/client/feedbackConfig.ts`. Repeated actions restart the timer; failures remain available for manual dismissal or recovery.
- Add browser regressions for refresh failures after successful moves, actual save failures, feedback expiry, timer resets and manual error dismissal. No new database migration is required.

## 1.3.7 Release Notes (2026-10-17)

- Fix a race in folder depth validation. Creation and moves recheck destination ancestors, source subtree height and cycles within the write itself, preventing concurrent changes after preflight from exceeding five levels. Add deterministic regressions for parent moves and subtree growth.
- Simplify folder rows and breadcrumb navigation. Desktop folder actions use right-click or `Shift+F10`, while mobile retains the action button. Remove the redundant back button, use breadcrumbs to return to ancestors or the root, and enlarge mobile toolbar and folder-action touch targets.
- Include pending database migrations in deployment confirmation, preventing Wrangler's second prompt from being obscured by progress heartbeats. Add interactive deployment regression coverage and usage notes.
- No new database migration is required. Upgrades from older versions still apply all pending migrations before deployment.

## 1.3.6 Release Notes (2026-10-17)

- Tighten sidebar, note-list and editor-toolbar spacing on desktop and mobile. Place note excerpts beside timestamps and keep folder rows aligned with their action buttons.
- Upgrade ZIP manifests to v3 to preserve note and folder manual order while retaining v2 import compatibility. Accept valid negative keys and renumber siblings when a drop would exceed the supported range, keeping exported backups restorable.
- Use modification-time and ID cursors with on-demand "Load More" in the online task center. Process at most 50 candidate notes plus one lookahead note per page and suppress duplicate entries. Pages are live rather than a fixed snapshot; reopen the task center to see notes edited ahead of the cursor. Offline mode still collects mirrored notes and drafts locally.
- Count only rejected passwords against the global login budget for both login and OAuth consent, so other users cannot exhaust it to block correct passwords. Per-IP throttling still runs before verification; the global failure budget does not cap password derivation CPU from distributed requests.
- Retain deletion tombstones for 30 days before scheduled cleanup. Old-revision updates still return `410`, but an old ZIP or revision-zero copy can recreate the original ID after cleanup. Document this limitation in both disaster recovery guides.
- Apply the new `0005_tasks.sql` task-scan index when upgrading; the existing deployment script runs it before publishing. Disaster recovery verification still accepts compatible backups from before the index. Add regressions for order bounds, archive round trips, task pagination and login budgets.

## 1.3.5 Release Notes (2026-10-17)

- Avoid duplicate `/api/notes` and `/api/tags` requests after the initial online library load, reducing Worker/D1 reads and unnecessary list generation updates.
- Prevent `Cmd/Ctrl+S` from reaching the browser's Save Page dialog when no note is selected and no draft is pending; when content exists, it still saves immediately and records a version snapshot.
- Add browser regression coverage for online startup request deduplication and the empty-state save shortcut. This is a client-side fix with no new database migration.

## 1.3.4 Release Notes (2026-10-17)

- Make `Cmd/Ctrl+K` the primary global search shortcut, retaining `Cmd/Ctrl+Shift+F` as a compatible alternative. Focus search and select the existing query; from the mobile editor, return to the note list first.
- Move Quick Open from `Cmd/Ctrl+K` to `Cmd/Ctrl+O` and edit/preview from `Cmd/Ctrl+Enter` to `Cmd/Ctrl+E`. `Cmd/Ctrl+Enter` now creates a note in the current folder. Add shortcuts for settings (`Cmd/Ctrl+,`), navigation (`Cmd/Ctrl+\`, opening the navigation menu at ≤900px), outline (`Cmd/Ctrl+.`), internal links (`Cmd/Ctrl+Shift+K`) and appearance (`Cmd/Ctrl+Shift+L`).
- Prioritize application shortcuts inside the editor without changing note text while preserving browser find, input composition, key repeat and shortcuts with other modifiers. Keyboard help now documents undo and redo.
- Switch folders, categories and sort order immediately while keeping the 200ms search debounce. Show a loading skeleton until results arrive, an empty state only after a successful empty response, and ignore stale responses after switching views.
- Retry the full startup process after folder, sync cursor or note loading fails, restoring folder navigation, categories, sorting and background sync while preserving existing local drafts. No new database migration is required.

## 1.3.3 Release Notes (2026-10-17)

- Reorder the list toolbar to Quick Open, Sort, Bulk Select, Sync and New, keeping browsing controls together.
- Add `Cmd/Ctrl+Shift+F` to focus global search and select the existing query. From the mobile editor, return to the note list before focusing search.
- Show the new shortcut in keyboard help, the Quick Open search command and both language guides. Search spans folders while retaining the current category and tag filters. No new database migration is required.

## 1.3.2 Release Notes (2026-10-17)

- The root level no longer repeats All Notes on a second line. The back button and folder path appear only inside a folder or while a search or tag filter is active.
- Below 340px of list width the sorting control collapses to its icon so the heading is not cut off; widen the list to see the Last modified or Manual order label again.
- Mobile keeps the icon-only control. This release only touches the list header and needs no new database migration.

## 1.3.1 Release Notes (2026-10-16)

- The plus button in the list toolbar no longer shows a "New" hover tooltip, which duplicated the creation menu underneath it.
- Tighten the list creation menu and the note and folder context menus with smaller padding, row height and corner radius; mobile keeps 36px touch rows.
- Restyle the sorting control from an outlined box into the borderless pill already used for sidebar active states, aligned with the toolbar icon height; narrow screens show the icon only.
- A visual-detail release. No new database migration is required.

## 1.3.0 Release Notes (2026-10-16)

- Remove the duplicate folder tree from desktop and mobile navigation. Browse folders in the mixed list; each folder's action menu supports creating subfolders, renaming, moving and deleting. Desktop also supports right-click and Shift+F10.
- The list's plus button offers New Note and New Folder at the current level. All Notes no longer has a folder-creation context menu. Mobile uses the same visible creation menu; subfolder creation is disabled offline and at the fifth level.
- Add a separate Back to parent folder button and clickable folder breadcrumbs. Navigation works with the sidebar collapsed; on mobile the path scrolls horizontally while the back button remains visible.
- Preserve folder dragging and manual ordering, with breadcrumbs accepting drops into ancestor folders. Add a bulk Move action that appends cross-folder selections in display order; partial save failures prevent group reordering.
- Remember sorting preferences independently for the root and each folder. Root defaults to Last modified and folders to Manual order. Equal manual positions retain folder name order and note modification order. No new database migration is required.

## 1.2.0 Release Notes (2026-10-16)

- All Notes now browses the root level, mixing top-level folders with unfiled notes in one list. Filed notes no longer appear there again. Opening a folder lists its direct subfolders and notes, without flattening descendant notes.
- Search spans folders even when started inside a folder. Tags, Archive and Trash retain their respective filters. Online pagination, the offline library and local drafts follow the same browsing scope.
- Open folders directly from the list, or drop notes and folders onto them. All Notes remains a drop target for moving items back to the root level. Folders and notes share list ordering and Load more; folders after an unloaded note page are deferred to preserve ordering.
- Preserve pinned notes and existing manual ordering within folders. No new database migration is required; upgrades from 1.1.x can use the existing deployment script directly.

## 1.1.1 Release Notes (2026-10-16)

- Remove the duplicate Root entry from desktop and mobile navigation, using All Notes as the single entry. All Notes continues to list notes across folders.
- On desktop, drop notes or subfolders onto All Notes to move them back to the root level. Drop highlighting, folder creation and keyboard menus remain available. This update requires no new database migration.

## 1.1.0 Release Notes (2026-10-16)

- On desktop, drag folders to reorder siblings or move them into another folder, and drag a selection of notes into a folder or Root. Folder depth, sibling-name uniqueness and cycle checks remain enforced.
- Root stays visible. Each folder can independently use Manual order or Last modified, with preferences stored per account in the current browser. Manual order supports dragging and Alt+Up / Alt+Down; search, tag and All Notes lists retain last-modified ordering.
- Reordering notes changes only their positions, preserving content, revisions and modification times. Cross-device position updates retain unsaved drafts and rebuild pagination in manually ordered lists.
- Upgrading to 1.1.0 requires `0004_order.sql`, which adds note and folder positions and a sorting index. The existing deployment script applies migrations before publishing code. ZIP restores preserve folders but not manual order. Mobile continues to use action menus; moving and reordering require a connection.
- Fix web ChatGPT MCP authorization: PWA navigation no longer intercepts OAuth, discovery metadata, MCP or share paths. Consent submissions strictly validate a same-origin Origin, falling back to a same-origin Referer only when Origin is absent, allowing popup cross-site markers and Referer-only submissions.
- Fix MCP search results being rejected when internal sorting fields are present. Upgrades from older versions must also have `0002_oauth.sql` applied; the deployment script checks and applies all pending migrations.

## 1.0.0 Release Notes (2026-10-16)

- Show the folder tree directly below All Notes instead of in a separate Folders section, with the same hierarchy order on desktop and mobile.
- Right-click All Notes on desktop to create a root folder, or open the menu with Shift+F10 or the menu key. Escape closes it and returns focus to All Notes; clicking outside or pressing Tab also closes it.
- Keep the New Folder touch entry in mobile navigation. Folder creation is disabled offline; existing folders and cached notes remain available.
- Upgrading from 0.11.0 requires no new database migration. Existing folders, notes and folder actions remain compatible.

## 0.11.0 Release Notes (2026-10-16)

- Add a folder tree in the sidebar, five levels deep, with create, rename, move and delete. Moving a folder carries its whole subtree and the notes inside it, and a folder can never be moved into itself or its own subtree.
- The note list gains a right-click menu for copy, edit, move and delete. The offline library mirrors the folder list, and AI/MCP note metadata now reports `folderId`.
- Sibling folder names stay unique: create, rename, move, ZIP import and disaster-recovery restore all validate the same rule and return 409 on a clash. Migration `0003_folders.sql` adds a unique sibling index as a backstop, using `COALESCE` so root folders with a `NULL` parent are compared too.
- One account may hold at most 1200 folders, matching the ZIP import and export budget. Importing merges same-name siblings and always generates new UUIDs for created folders, so a folder ID owned by another account no longer aborts the import.
- Folder restore creates each level with up to six concurrent requests, cutting the wait for large archives on slow networks.
- Disaster-recovery backups include folders, and the restore precheck now rejects old backups that contain duplicate sibling names. Deployments apply database migrations before the new code.

## 0.10.2 Release Notes (2026-10-15)

- Reduce the default autosave delay from 1000 ms to 500 ms. Edits made during a save keep their existing debounce deadline and save immediately once it has elapsed, without waiting another full interval. The saved status still requires server confirmation.
- Deliver cross-device change notifications in the background so they no longer delay completed save responses; retain failure logging and polling recovery.
- Register the offline worker before the full page finishes loading, using a deferred registration script while preserving immediate activation and control of the page.
- Treat PDF resources as an optional background cache: preparation failures no longer interrupt editing, saving, or enabling offline notes. Export failures appear in the PDF dialog. Offline PDF export may remain unavailable if the resources were not cached successfully.
- Add regression coverage for slow page resources, PDF cache failures, edits during saves, and background notifications. The database schema and migrations are unchanged.

## 0.10.1 Release Notes (2026-10-15)

- Fewer database round trips when saving a note: the current revision and the purge tombstone are read in one batch, and the save response comes from the write itself via `RETURNING` instead of a follow-up read, so the response always matches the revision that was written.
- Load the note list and the tag list in parallel, removing one serial round trip. A failed list refresh after a successful save is no longer treated as a save failure and no longer blocks further autosaves of that note (the content is already on the server); the list catches up on the next poll.
- The database schema and migrations are unchanged: upgrading from 0.10.0 needs no extra migration or backup step.

## 0.10.0 Release Notes (2026-10-15)

- Add OAuth authorization for remote MCP: clients that only support OAuth, such as ChatGPT on the web, can connect to `/mcp` directly, with automatic client registration and PKCE (S256). The consent page asks for the account password and a read-only or read-write access level.
- Each authorization creates one integration token named after the client, listed under "Settings → AI Integration", revocable at any time, and sharing the limit of 10 active tokens per account with manually created tokens.
- Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every refresh; reusing a rotated-out refresh token revokes that authorization immediately. Changing a password, disabling an account, an administrator password reset, or account deletion also revokes OAuth grants.
- OAuth endpoints accept HTTPS only: client registration uses the `ACCOUNT_WINDOW_SECONDS` window, consent submissions reuse the login rate limit, and unknown `/.well-known/*` paths return a JSON 404 instead of the app shell.
- Deployments apply database migrations before the new code. Disaster-recovery backups include the new OAuth client table; after the migration version changes, restore older backups with matching code.

## 0.9.0 Release Notes (2026-10-15)

- Add KaTeX inline and display math, including offline cold starts, shared and separate readers, PDF exports, and an importable example. PDF export rasterizes formulas and their containing paragraphs, headings, list items, or table cells; text inside those images cannot be selected or searched.
- Browser connectivity hints no longer block sync or image requests. Network failures and HTTP errors update connectivity separately, including when the offline library is disabled. The task center uses mirrored notes and unsynced drafts when the offline library is enabled.
- Retry temporary save failures up to twice with the same operation ID; prevent delayed reads from overwriting newer synchronized content or purge tombstones.
- Fix PDF exports containing math and Mermaid in the same list item, preserve image dimensions, reuse decoded images when their sources become unreachable if the canvas can read them, and report other images as unwritable, and cover large images mixed with inline math.
- Build current source before UI tests, update stale selectors, include client API and math parser tests in the regular test command, and remove unused translation keys.

## 0.8.7 Release Notes (2026-10-09)

- Fix the editor-lock screen when switching from a browser tab to the installed PWA. A foreground PWA automatically takes over; waiting pages resume when the previous editor closes, while preserving one editor per account and browser profile.
- Add an in-app history entry when opening a note on mobile. System Back returns to the note list, and Forward restores the note view. The Back button waits for history traversal before displaying the list to avoid races when reopening quickly.
- Disable horizontal overscroll navigation while retaining horizontal scrolling in code blocks and tables.
- Add regression coverage for PWA takeover, editor-lock recovery, and mobile Back/Forward; update existing mobile navigation tests to use the current button labels.

