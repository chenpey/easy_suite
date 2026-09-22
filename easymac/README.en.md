# EasyMac

[简体中文](README.md) | [English](README.en.md)

Current Version: `0.4.3`

[Download EasyMac Latest](https://github.com/chenpey/easy_suite/releases/tag/easymac-latest)

EasyMac scans installed applications on an old Mac, allows users to search, filter, and select items for migration, and exports an automated installation script ready to run on a new Mac.

Built as a lightweight local launcher and local web interface, it requires no app installation, Xcode, developer accounts, or extra runtime environments.

## Usage

1. Keep the `EasyMac` folder intact.
2. For first-time use, open macOS Terminal.
3. Copy the full authorization command from `首次使用.txt` (First Use instructions), paste it into Terminal, and press Enter.
4. The command automatically locates the App in your Downloads directory; once verification and authorization complete, it closes the Terminal tab and launches EasyMac.
5. Double-click `EasyMac.app` directly on subsequent launches.
6. Select items in the automatically opened local web page, preview the script, and download the migration ZIP.
7. Transfer the ZIP to your new Mac, unzip it, and double-click `EasyMac-Migration.command`.

EasyMac is not notarized with an Apple Developer ID as this project does not maintain a paid developer account. The authorization script uses `codesign` to verify bundle contents and a fixed Bundle ID, and removes only `EasyMac.app`'s own quarantine flag; it never disables Gatekeeper, modifies system security settings, or requests administrator privileges, and therefore does not and should not require an administrator password.

## Detection Scope

EasyMac scans:

- `/Applications`
- `~/Applications`
- Current Homebrew installation records
- Application App Store IDs
- Offline Homebrew Cask catalog bundled within the app

Items are categorized into:

- Homebrew Cask: Matched via local installation records, exact application bundle filenames, or unambiguous official Cask names matching both display name and filename.
- App Store: Valid App Store ID present in application metadata.
- CLI Tools: Top-level formulae returned by `brew leaves`.
- Web Apps (PWAs): Identified via Chrome/Edge `CrAppModeShortcutURL` metadata, retaining the host browser and scanned original URL (stripping known tracking parameters upon export).
- Manual Install: Standard applications without reliable automated installation sources.

## Migration Script Behavior

The exported script executes sequentially in Terminal on the new Mac:

1. Preflight checks: Refuses to run as root and requires macOS 13 or later.
2. Homebrew verification: Checks for existing Homebrew; if absent, prompts to install via the official installer. Automatically configures `brew shellenv` in the shell startup profile without duplicating existing entries.
3. Homebrew Cask & Formulae installation: Batched via `brew bundle` with automatic retry on failure and missing dependency resolution.
4. Node & nvm installation (if selected): Uses official nvm and installs latest Node LTS. Validates effective `NVM_DIR` and `ZDOTDIR` directly via a fresh zsh login shell without text regex parsing; existing custom nvm paths are preserved with clear notifications.
5. Mac App Store installations (if selected): Installs `mas` CLI, verifies App Store login status, and installs selected applications. Unsupported region items are recorded and skipped gracefully.
6. Web Apps (PWAs): Displays instructions and opens URLs in their respective host browsers.
7. Manual installs: Lists remaining applications with reminders for manual download or installation.
8. Execution summary: Logs saved to `~/Library/Logs/EasyMac/`. Outputs a clean summary of succeeded items, region skips, and failures.

## Security & Privacy

- Scanning, searching, selection, and script generation run entirely on your local machine.
- The web page makes zero network requests and never uploads your application inventory.
- EasyMac does not perform installations; it only exports scripts.
- Network access occurs solely when running the exported script on the new Mac.
- When only manual install items are selected, the script contains no Homebrew, `curl`, or download commands.
- When only web apps are selected, the script only lists host browsers and URLs without automated installers.
- Automated installation requires typing the confirmation phrase `install apps`.
- Downloads are packaged as ZIP files to preserve executable permissions on `.command` files.

After the page opens, the temporary scan directory is deleted after 30 minutes. Data already loaded remains active in the current tab; do not refresh thereafter.

## Project Structure

Source and generated artifacts are strictly separated:

```text
easymac/
├── VERSION                  # Version source of truth, maintained by root version script
├── FIRST_RUN.txt            # First-run authorization guide in Releases
├── catalog/casks.tsv.gz     # Single compressed offline Cask mapping
├── scripts/                 # Scan, launch, build, and catalog update scripts
├── test/                    # Node.js core tests
├── web/                     # Web page, logic, and icon source
├── build/                   # Local intermediate artifacts (gitignored)
└── dist/                    # Release artifacts (gitignored)
```

- `build/EasyMac.app` is the runnable application for local testing.
- `dist/EasyMac-v<version>.zip` is the sole release package.
- The release package contains only `EasyMac.app` and `首次使用.txt`; authorization scripts are bundled inside the App.
- `dist/*.sha256` verifies release archive integrity.
- `build/` and `dist/` are gitignored and can be safely deleted and rebuilt.

Clean local artifacts:

```bash
./scripts/build.zsh --clean
```

## Development & Testing

Run scan preview without opening a browser:

```bash
./scripts/scan-preview.zsh /tmp/easymac-test
```

Run core tests:

```bash
EASYMAC_SCAN_FIXTURE=/tmp/easymac-test/data.js \
  node --test test/core.test.cjs
```

Run tests and rebuild:

```bash
./scripts/scan-preview.zsh /tmp/easymac-test
EASYMAC_SCAN_FIXTURE=/tmp/easymac-test/data.js \
  node --test test/core.test.cjs
./scripts/build.zsh
```

Optional real nvm/LTS network integration test (uses temporary HOME and Homebrew test double, does not modify user environment):

```bash
EASYMAC_REAL_NVM=1 node --test --test-name-pattern='real official nvm' test/core.test.cjs
```

Build relies solely on macOS built-in tools: `osacompile`, `sips`, `iconutil`, and `codesign`. Ad-hoc code signing requires no Apple Developer account.

Preview generated macOS app icon:

```bash
./scripts/generate-icon.zsh
```

Update bundled offline Cask catalog:

```bash
node scripts/update-cask-catalog.mjs
```

This development command generates a compressed mapping from Homebrew's official API. End-user scans read this local file without network requests.

## Versioning & Release

Versions are managed via [`versions.json`](../versions.json) in the repository root:

```bash
node ../scripts/version.mjs bump easymac patch
node ../scripts/version.mjs check
```

Pushing an `easymac-v<version>` tag triggers GitHub Actions on macOS Runner to test, build, and publish a GitHub Release:

```bash
git tag -a easymac-v0.3.3 -m "发布：EasyMac v0.3.3"
git push origin easymac-v0.3.3
```

Release assets include the versioned ZIP and corresponding SHA-256 checksum file.
