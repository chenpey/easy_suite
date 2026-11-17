# EasyMac

[简体中文](README.md) | [English](README.en.md)

Current Version: `0.4.6`

[Download EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

EasyMac scans installed software on an old Mac, lets you search, filter, and select items to migrate, and exports a reviewable installation script for your new Mac. It runs via a lightweight local launcher and local web UI out of the box.

## Usage

1. Unzip and keep the complete `EasyMac` folder.
2. On first launch, open macOS Terminal and run the authorization command from `首次使用.txt` to verify and open EasyMac (thereafter, double-click `EasyMac.app` directly).
3. In the local web UI, select items to migrate, preview the generated script, and download the migration ZIP.
4. On the new Mac, unzip the archive, follow `EasyMac-First-Run.txt` to launch `EasyMac-Migration.command` (via right-click "Open" or Terminal), and type `install apps` to begin installation.

## Detection & Installation

- **Scan Sources**: `/Applications`, `~/Applications`, local Homebrew records, App Store metadata IDs, and the bundled offline Cask catalog.
- **Categories**:
  - **Homebrew Cask**: Matches local install records or exact unique `.app` bundle names to official Casks.
  - **App Store**: Detects apps with valid App Store IDs and verifies installation via `mas list`.
  - **CLI Tools**: Top-level Formulae from `brew leaves`.
  - **Web Apps**: Detects Chrome/Edge `CrAppModeShortcutURL` apps, preserving host browser and cleaned target URLs.
  - **Manual Install**: Lists remaining apps for reference.
- **Node.js / nvm**: Uses the official nvm v0.40.7 installer to configure nvm and install the latest Node.js LTS as default, reading effective `NVM_DIR` and `ZDOTDIR` from a real zsh login shell.
- **Homebrew**: Installs with up to 3 concurrent downloads, per-item fallback retries, and final verification (logs saved in `~/Library/Logs/EasyMac/`). Runs as a standard user on macOS 14+.

## Security & Privacy

- Scanning, filtering, and script generation run 100% locally and offline.
- The exported script requires typing `install apps` before installing and runs under standard user permissions.
- Temporary scan directories are automatically cleaned up 30 minutes after opening the page.

## Project Structure

```text
easymac/
├── VERSION                  # Version source of truth
├── FIRST_RUN.txt            # Release first-run authorization guide
├── catalog/casks.tsv.gz     # Offline Cask mapping catalog
├── scripts/                 # Scan, launch, build, and catalog update scripts
├── test/                    # Node.js core tests
├── web/                     # Local web UI and icon source
├── build/                   # Local build artifacts (gitignored)
└── dist/                    # Release artifacts (gitignored)
```

## Development & Testing

```bash
./scripts/scan-preview.zsh /tmp/easymac-test
EASYMAC_SCAN_FIXTURE=/tmp/easymac-test/data.js node --test test/core.test.cjs
./scripts/build.zsh
```

Additional commands:

```bash
./scripts/build.zsh --clean           # Clean build/ and dist/
./scripts/generate-icon.zsh           # Preview generated macOS icon
node scripts/update-cask-catalog.mjs  # Update bundled offline Cask catalog
```

See [`CHANGELOG.en.md`](CHANGELOG.en.md) for full release history.

## Versioning & Release

```bash
node ../scripts/version.mjs bump easymac patch
node ../scripts/version.mjs check
git tag -a easymac-v0.4.6 -m "发布：EasyMac v0.4.6"
git push origin easymac-v0.4.6
```

Pushing an `easymac-v<version>` tag triggers GitHub Actions on a macOS runner to test, build, and publish the Release.
