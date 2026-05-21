# Changelog

## v0.2.1 - 2026-05-21

- Corrected macOS first-run docs: right-click open is not reliable on every macOS version for unsigned downloads.
- Added `MAC_FIRST_RUN.txt` to the macOS ZIP with the exact quarantine-removal fallback.
- Updated release packaging to use dynamic version numbers and attempt ad-hoc signing for the macOS `.app`.

## v0.2.0 - 2026-05-21

- Added release packaging for separate macOS and Windows ZIP downloads.
- Added an unsigned macOS `.app` wrapper that launches the local workbench without a `.command` file.
- Added a clearer Windows package entry point: `Start PP Article Library.bat`.
- Clarified macOS unsigned-app warnings and first-open steps in README and release notes.

## v0.1.0 - 2026-05-21

- First public source release of PP Article Library.
- Includes local PDF library management, browser-based reading, AI notes, citation templates, category export, EasyScholar integration, OCR fallback, sticky notes, annotation/chat data structure, and cross-platform path compatibility.
- Ships Windows `.bat` and macOS `.command` launchers for the source version.
- Keeps personal PDFs, notes, API keys, indexes, citations, exports, and manuscript drafts out of GitHub.
- Licensed under the PolyForm Noncommercial License 1.0.0 for noncommercial use.
