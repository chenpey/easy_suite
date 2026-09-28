# Easy Suite

[简体中文](README.md) | [English](README.en.md)

Easy Suite is a multi-project repository containing four independent tools for file sharing, note-taking, Mac migration, and automated testing. Each project has its own dependencies, configuration, data storage, and documentation.

## Versions

<!-- versions:start -->
| Project | Current Version |
| --- | --- |
| [EasyDrop](easydrop/) | `1.3.0` |
| [EasyNote](easynote/) | `0.8.6` |
| [EasyMac](easymac/) | `0.4.4` |
| [EasyTest](easytest/) | `0.3.1` |
<!-- versions:end -->

## Projects

### [EasyDrop](easydrop/)

EasyDrop is a web-based file transfer service deployed on Cloudflare Workers. After signing in to the same site, users can send text and files between computers, phones, and tablets.

Its main capabilities include isolated multi-user workspaces, admin-controlled registration and account management, chunked concurrent uploads with resume support, client-side WebP thumbnails, time-limited login-free file links, and backoff-assisted history synchronization. D1 stores accounts, text, and upload states; private R2 stores original files and optional thumbnails.

Tech Stack: JavaScript, Cloudflare Workers, D1, R2.

For local development, navigate into the directory and run `npm ci`, `npm run setup`, and `npm run dev`. For production deployment, run `bash deploy.sh`, which uses an interactive API Token flow to create or reuse Worker, D1, private R2, and public access endpoints.

See [EasyDrop README](easydrop/README.md) for details.

### [EasyNote](easynote/)

EasyNote is a self-hosted web application for writing, organizing, searching, and sharing Markdown notes across devices. It is designed for individuals and small teams, with a separate data space for every account.

Its main capabilities include autosave, a task center, Obsidian/Markdown import, PDF export with page-by-page preview, time-limited or permanent read-only sharing, private images, full-text search, trash, version history, a complete offline notebook, and concurrent conflict protection. Administrators can manage users and approve registrations, while notes, attachments, offline caches, and AI tokens remain isolated by user.

Tech Stack: React, TypeScript, CodeMirror, pdfmake, PDF.js, Cloudflare Workers, D1, R2.

For local development, navigate into the directory and run `bash dev.sh`. For production deployment, run `bash deploy.sh`, which uses an interactive Cloudflare API Token to automatically discover accounts and create or reuse Worker, D1, private R2, and public access endpoints (supporting `workers.dev` or automatic custom domain binding). Remote deployment and maintenance use a scoped Cloudflare custom API Token read invisibly from the terminal on each run, lifetime limited to the current process. Personal instances with under 1,000 notes typically fit within Workers, D1, and R2 free tiers.

See [EasyNote README](easynote/README.md) for details.

### [EasyMac](easymac/)

EasyMac is a migration inventory tool that runs on an old Mac. It helps users choose which software to carry over and generates a reviewable installation script for the new Mac; EasyMac itself does not install software.

Its main capabilities include scanning Homebrew, Mac App Store, and standard applications, searching and filtering migration items, and previewing and exporting the installation script. It uses a terminal-free local launcher and local web page, requires no Xcode, developer account, or additional runtime, and never uploads the scanned inventory.

Release Download: [EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

Tech Stack: AppleScript, Zsh, HTML, CSS, JavaScript.

See [EasyMac README](easymac/README.md) for details.

### [EasyTest](easytest/)

EasyTest is a Python tool for testing APIs and business workflows. Testers author cases in Excel, which the framework compiles into deterministic JSON and runs through the CLI, pytest, or a Notebook.

Its main capabilities include HTTP, RPC, database, UI, and business workflow orchestration, whole-suite static preflight, offline mocks, file and SQLite snapshots, external screenshot storage, concurrent baseline protection, and self-contained HTML/PDF reports.

Tech Stack: Python 3.12/3.13, pytest, openpyxl, SQLite.

For local development, navigate into the directory and run `uv sync` and `uv run pytest`. Create a project with `uv run easytest init ../my-tests`.

See [EasyTest README](easytest/README.md) for details.

## Usage

The four projects are completely independent; all commands should be executed within their respective project directories:

- EasyDrop and EasyNote require Node.js 22 or later.
- EasyMac requires macOS 13 or later. After unzipping the release package, complete the one-time authorization command in Terminal per `首次使用.txt` to open, and double-click `EasyMac.app` directly thereafter.
- EasyTest requires Python 3.12 or 3.13; `uv` is recommended for environment management.

Refer to each project's README for specific startup, testing, deployment, configuration, and security boundaries.

## Version Management

The single source of truth for versions is [`versions.json`](versions.json). Do not directly edit individual project version files, `package.json`, or README version lines. When preparing to commit functional updates, run in the repository root:

```bash
node scripts/version.mjs bump easynote patch
# or: node scripts/version.mjs bump easymac minor
# or: node scripts/version.mjs bump easytest patch
node scripts/version.mjs check
```

The script synchronizes project version files, package manifests, lockfiles, runtime versions, README files, and the root version tables. `patch` is suited for backwards-compatible fixes, `minor` for new features, and `major` for breaking changes. Follow up with a versioned commit message, e.g., `发布：EasyMac v0.1.0`.

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
