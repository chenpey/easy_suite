# Easy Suite

[简体中文](README.md) | [English](README.en.md)

Easy Suite is a multi-project repository for cross-device file transfer, self-hosted Markdown notes, Mac migration checklists, and table-driven API testing. Each project is independent with its own configuration and documentation.

## Versions

<!-- versions:start -->
| Project | Current Version |
| --- | --- |
| [EasyDrop](easydrop/) | `1.4.1` |
| [EasyNote](easynote/) | `1.6.2` |
| [EasyMac](easymac/) | `0.4.6` |
| [EasyTest](easytest/) | `0.4.2` |
<!-- versions:end -->

## Projects

### [EasyDrop](easydrop/)

A web-based text and file transfer hub deployed on Cloudflare Workers for exchanging content across computers, phones, and tablets over HTTPS.

- **Key Capabilities**: Isolated user spaces, admin account management, chunked concurrent uploads with resume support, client-side WebP thumbnails, time-limited public download links, Android PWA system share target, and cross-device history sync.
- **Tech Stack**: JavaScript, Cloudflare Workers, D1, R2.
- **Run & Deploy**: Run `npm ci && npm run setup && npm run dev` locally, or `bash deploy.sh` for production.

See [EasyDrop README](easydrop/README.en.md) for details.

### [EasyNote](easynote/)

A self-hosted Markdown note application for individuals and small teams, with an isolated workspace per account.

- **Key Capabilities**: CodeMirror 6 live preview alongside source and reading modes, autosave, folders and manual ordering, task center, Obsidian/Markdown import and export, paginated PDF export, time-limited or permanent read-only sharing, private images and attachments, full-text search, version history, offline notebook, three-way conflict merge, and remote MCP integration.
- **Tech Stack**: React, TypeScript, CodeMirror, pdfmake, PDF.js, Cloudflare Workers, D1, R2, Durable Object.
- **Run & Deploy**: Run `bash dev.sh` locally, or `bash deploy.sh` for production.

See [EasyNote README](easynote/README.en.md) for details.

### [EasyMac](easymac/)

A migration inventory tool that runs on an old Mac to scan installed software and generate a reviewable installation script for a new Mac.

- **Key Capabilities**: Scans Homebrew (Casks and Formulae), Mac App Store apps, standard apps, and web apps; supports search, filtering, and script export via a lightweight local launcher and web UI.
- **Download**: [EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)
- **Tech Stack**: AppleScript, Zsh, HTML, CSS, JavaScript.

See [EasyMac README](easymac/README.en.md) for details.

### [EasyTest](easytest/)

An Excel-driven Python testing framework for APIs and business workflows that compiles XLSX workbooks into deterministic JSON and executes them via CLI, pytest, or Notebook.

- **Key Capabilities**: HTTP, RPC, Database, UI, and scenario orchestration, shared data-driven sets, static preflight checks, offline mocks, file and SQLite snapshots, external screenshot storage, concurrent baseline protection, and self-contained HTML/PDF reports.
- **Tech Stack**: Python 3.12/3.13, pytest, openpyxl, SQLite.
- **Quick Start**: Run `uv sync && uv run pytest`, or `uv run easytest init ../my-tests` to scaffold a new project.

See [EasyTest README](easytest/README.md) for details.

## Requirements

Run project commands inside each project directory:

- **EasyDrop / EasyNote**: Node.js 22+
- **EasyMac**: macOS 13+ (unzip the release package, run the one-time authorization command from `首次使用.txt` in Terminal, then double-click `EasyMac.app` directly)
- **EasyTest**: Python 3.12 / 3.13 with `uv`

## Version Management

Each project declares its version source and sync targets in `<project>/version.config.json`. Root [`versions.json`](versions.json) and version tables are generated automatically. To bump and verify versions from the repository root:

```bash
node scripts/version.mjs bump <project> patch   # or minor / major
node scripts/version.mjs check
```

## Clean Reset

Run reset scripts inside each project directory:

```bash
cd easynote && bash reset.sh --local    # Reset local state (keeps .dev.vars)
cd easynote && bash reset.sh --remote   # Reset remote Worker, D1, and R2
cd easydrop && bash reset.sh --local
cd easydrop && bash reset.sh --remote
```

Run `bash deploy.sh` in the project directory afterwards to redeploy.
