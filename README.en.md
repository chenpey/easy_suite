# Easy Suite

[简体中文](README.md) | [English](README.en.md)

Easy Suite centrally manages three independent utility projects. Each project maintains its own dedicated dependencies, configuration, data storage, and documentation. Cloudflare D1/R2 resources and local runtime artifacts are also managed separately.

## Versions

<!-- versions:start -->
| Project | Current Version |
| --- | --- |
| [EasyDrop](easydrop/) | `1.1.7` |
| [EasyNote](easynote/) | `0.5.0` |
| [EasyMac](easymac/) | `0.3.3` |
<!-- versions:end -->

## Projects

### [EasyDrop](easydrop/)

A cross-device text and file sharing tool based on Cloudflare Workers. Features isolated multi-user workspaces, admin-controlled registration and account management, text sharing, chunked concurrent uploads with resume capability, client-side WebP thumbnails, time-limited login-free file links, and backoff-assisted cross-device history synchronization. D1 stores accounts, text, and upload states; private R2 stores original files and optional thumbnails.

Tech Stack: JavaScript, Cloudflare Workers, D1, R2.

For local development, navigate into the directory and run `npm ci`, `npm run setup`, and `npm run dev`. For production deployment, run `bash deploy.sh`, which uses an interactive API Token flow to create or reuse Worker, D1, private R2, and public access endpoints.

See [EasyDrop README](easydrop/README.md) for details.

### [EasyNote](easynote/)

A multi-user self-hosted Markdown note-taking app with images, powered by Cloudflare Workers. Each user is an isolated tenant; notes, attachments, offline caches, and AI tokens are completely separated. Administrators can manage users and approve registrations. Features autosave, task center, Obsidian/Markdown import, cross-platform PDF export with page-by-page preview, time-limited or permanent read-only sharing with centralized management, private images, full-text search, trash bin, version history, default-enabled full offline note library, and concurrent conflict protection, responsive for desktop and mobile.

Tech Stack: React, TypeScript, CodeMirror, pdfmake, PDF.js, Cloudflare Workers, D1, R2.

For local development, navigate into the directory and run `bash dev.sh`. For production deployment, run `bash deploy.sh`, which uses an interactive Cloudflare API Token to automatically discover accounts and create or reuse Worker, D1, private R2, and public access endpoints (supporting `workers.dev` or automatic custom domain binding). Remote deployment and maintenance use a scoped Cloudflare custom API Token read invisibly from the terminal on each run, lifetime limited to the current process. Personal instances with under 1,000 notes typically fit within Workers, D1, and R2 free tiers.

See [EasyNote README](easynote/README.md) for details.

### [EasyMac](easymac/)

Scans Homebrew, Mac App Store, and standard applications on an old Mac, allowing users to search, filter, and select items for migration, preview, and export an automated installation script for the new Mac. Composed of a terminal-free local launcher and a local web page, requiring no Xcode, developer account, or additional runtime environments. Scanned manifests are never uploaded, and EasyMac itself performs no installations.

Release Download: [EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

Tech Stack: AppleScript, Zsh, HTML, CSS, JavaScript.

See [EasyMac README](easymac/README.md) for details.

## Usage

The three projects are completely independent; all commands should be executed within their respective project directories:

- EasyDrop and EasyNote require Node.js 22 or later.
- EasyMac requires macOS 13 or later. After unzipping the release package, complete the one-time authorization command in Terminal per `首次使用.txt` to open, and double-click `EasyMac.app` directly thereafter.

Refer to each project's README for specific startup, testing, deployment, configuration, and security boundaries.

## Version Management

The single source of truth for versions is [`versions.json`](versions.json). Do not directly edit individual project version files, `package.json`, or README version lines. When preparing to commit functional updates, run in the repository root:

```bash
node scripts/version.mjs bump easynote patch
# or: node scripts/version.mjs bump easymac minor
node scripts/version.mjs check
```

The script synchronizes project version files, `package.json`, lockfiles, runtime versions, README files, and the root version tables. `patch` is suited for backwards-compatible fixes, `minor` for new features, and `major` for breaking changes. Follow up with a versioned commit message, e.g., `发布：EasyMac v0.1.0`.

## Clean Reset

The `reset.sh` script in the repository root clears EasyNote or EasyDrop:

```bash
bash reset.sh easynote --local
bash reset.sh easydrop --local
bash reset.sh easynote --remote
bash reset.sh easydrop --remote
```

Local mode deletes `.wrangler/state` for the selected project, preserves local administrator configurations in `.dev.vars`, and prompts to clear browser site data. Remote mode reads the project's `wrangler.deploy.json`, prompts for full confirmation text and an invisible Cloudflare API Token, then deletes the Worker, empties and recreates the R2 bucket, and rebuilds the D1 schema. Once completed, navigate into the project and run `bash deploy.sh` to redeploy.

Remote cleanup requires all objects in R2 to be tracked by the application. If orphaned objects exist, the script stops when deleting the bucket; perform **Empty Bucket** on that bucket in Cloudflare Dashboard first, then rerun the cleanup command.
