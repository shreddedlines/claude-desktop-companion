# Release notes

## v1.0.0 (2026-11-10): first release

First public release of Claude Desktop Companion, installed on Windows as **Claude Notifier**. One installer: `ClaudeNotifierSetup.exe` (about 23.5 MB). Checksum: see [`release/SHA256SUMS.txt`](release/SHA256SUMS.txt) and [`release/RELEASE-INFO.txt`](release/RELEASE-INFO.txt).

### Highlights

* **Session monitoring:** detects *finished*, *needs your input*, *needs permission*, *API error*, *session limit* and *process exited unexpectedly* for Claude Code sessions started from Claude Desktop (read-only).
* **Windows notifications** with sounds, persistent toasts for things that need a human, anti-spam cooldowns and burst limits.
* **Android phone push via ntfy** (public service or your own server), metadata only, with a guided first-run setup (private per-install topic, QR code, test message; phone push is switched on only after you confirm the test arrived).
* **Usage monitoring** for the 5-hour and weekly windows (warnings at 80 % and 90 %; says when the data is stale).
* **Dark mode:** *System* (default), *Light*, *Dark* from the tray menu, applied immediately; Windows High Contrast respected.
* **Watchdog and health check:** automatic restart with back-off and a restart budget; a warning if Claude is running but nothing is visible.
* **Windows installer** (Inno Setup 6): per-user (no administrator rights, no network, no Node.js needed), Start Menu shortcut, optional desktop shortcut (off by default), optional start-with-Windows (off by default), upgrade in place (closes the running notifier and starts it again exactly once), and an uninstaller that **never deletes your data**.

### Fixes made during the release preparation

* Choosing *Exit* right after another menu action could make the notifier restart instead of closing (a pending menu refresh ran after shutdown).
* The phone setup window's status page clipped its second row of buttons.
* The clipboard clean-up of the copied phone topic is now one non-blocking attempt that clears the clipboard only while it still holds exactly the copied text; a busy clipboard is retried (about 2 s) and a visible warning is shown if it cannot be cleared.
* The installer's "stop the running app" step now repeats until nothing of that installation is left (bounded), instead of one pass that could miss a just-started process.
* An existing "start with Windows" entry is kept (and shown ticked) when upgrading; an unattended install never removes it.

### Known limitations

* **The installer is not code-signed.** Windows SmartScreen may warn ("Windows protected your PC"), and Windows 11 **Smart App Control** may block `ClaudeNotifierSetup.exe` or its generated uninstaller (error "An Application Control policy has blocked this file"), with no per-file override. Reliable distribution needs a code-signing certificate; it is not available yet. Verify your download with the published SHA-256.
* Developed and tested on Windows 11 (one PC, plus one Windows 11 laptop with an Android phone for the phone setup). Other Windows versions and iOS are untested.
* The application depends on files Claude Desktop writes (session status files, `main.log`, the plan-usage history). These are not a documented interface; an update to Claude Desktop could break detection (the health check warns you).
* Only sessions started from Claude Desktop are monitored.
* Usage figures can be stale (Claude Desktop writes them only while its tray menu has been opened in the last 24 hours).
* Starting with Windows is set in the installer; there is no switch in the tray menu.
* The tray menu looks slightly soft at 125 % display scaling (it is not DPI-aware). Rounded menu corners and the menu border colour need Windows 11.
* Real Windows High Contrast and arrow-key navigation of the tray menu were simulated, not tested on a real High Contrast session.
* The test suites `step2` and `step6` need two live Claude Desktop sessions and could not be re-run on the final build (`step6` ended at 118 of 124 checks in its last run; the cause looks environmental but is not proven).
* The installer's graphical wizard was tested by clicking through it in an isolated test identity; the production-named installer was not installed on the development PC (to protect the developer's own installation), only its resolved script was checked.
* The welcome page of the installer is disabled (Inno Setup default), so its plain-language introduction text is not shown.

### Verification

* Release build: 32 files, manifest and production gates verified, no development controls, personal data or secrets in the package (`verify-stage.js`: 38 of 38).
* Installer: silent and graphical install, upgrade (also while the app runs), startup and desktop options, cancel, failure message, uninstall and data preservation, in an isolated test identity: 40 of 40 (`step20`) and 31 of 31 (`step21`).
* Runtime: Node.js v24.18.0, renamed `ClaudeNotifier.exe`, unmodified, Authenticode signature valid (OpenJS Foundation).

See [`tests/README.md`](tests/README.md) for the per-suite results and preconditions.
