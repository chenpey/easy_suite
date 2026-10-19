# Release Notes

Full release history. The latest release is summarized in the [README](README.md).

## 0.4.5 Release Notes (2026-10-19)

- Fix Gatekeeper quarantine blocking exported migration scripts on a new Mac. The migration ZIP now includes both `EasyMac-Migration.command` and `EasyMac-First-Run.txt`, with a right-click Open path and Terminal first-run instructions.
- The migration script clears quarantine only from itself. If removal fails, it prints a clear warning and continues without disabling Gatekeeper, changing security settings or requesting administrator privileges.
- The export UI and both language guides now explain the first-run recovery path. After the first successful run, the migration script can be opened normally.
- Icon builds now fall back to Quick Look when `sips` cannot render the SVG. If both paths fail, diagnostics from both tools are retained so newer macOS releases do not hide the build failure.
- Add real ZIP and quarantine regressions covering CRC, extracted permissions, clearing only the command's own marker, and the non-blocking warning for immutable files.
- Compatibility: the migration inventory and installer contract remain compatible, and this release only adds a first-run guide without cleaning other files. The new Mac does not need EasyMac installed, but the old Mac must use 0.4.5 or later to export the first-run guide.

## 0.4.4 Release Notes (2026-09-25)

- Change `app-launch.zsh` to use a unique temporary directory, preventing directory collisions when multiple instances launch concurrently.
- Make `scan-preview.zsh` reject an existing output directory instead of overwriting it.

## 0.4.3 Release Notes (2026-09-22)

- Refactor internationalization into a standalone dictionary (`i18n.js`) with `t(key, ...args)` interpolation.
- Mark static HTML text with `data-i18n*`, resolve dynamic JavaScript text through `t(...)`, and remove `MutationObserver`.
- Add `scripts/check-i18n.mjs` to verify that Chinese and English keys stay aligned.

## 0.4.2 Release Notes (2026-09-22)

- Standardize the settings language label as Language/语言 while preserving the Chinese and English option names.

## 0.4.1 Release Notes (2026-09-22)

- Expand dynamic attribute handling for `aria-label`, `title`, `placeholder` and `alt`, improving English coverage.
- Add translated meta description content and installer guidance.

## 0.4.0 Release Notes (2026-09-22)

- Add Chinese and English UI switching, defaulting to Chinese and remembering the user's choice.
- Add a settings panel and improve the English and narrow-screen layouts.

## 0.3.3 Release Notes (2026-09-22)

The project is now named EasyMac, with application identity and release automation updated throughout.

- Rename EasyNewMac to EasyMac.
- Update the application name, Bundle ID (`party.tiandi.easymac`), icon resources and local web UI text.
- Update GitHub Actions and the `easymac-v*` tag convention.
- Preserve scanning and migration support, including app discovery, offline Cask matching, migration script generation and shell configuration checks.

The release package contains EasyMac.app and “首次使用.txt”.
