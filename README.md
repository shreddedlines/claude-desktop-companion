# Claude Desktop Companion

**A Windows tray app that tells you when Claude Code, running inside Claude Desktop, needs you: with Windows notifications and, if you want, push notifications on your Android phone.**

> **Unofficial project.** Claude Desktop Companion is an independent, community project. It is **not affiliated with, endorsed by, or supported by Anthropic.** "Claude" and "Claude Code" are trademarks of Anthropic. This tool only *reads* files that Claude Desktop writes on your own PC; it does not talk to Anthropic's services.

> **Naming.** The repository and project are called *Claude Desktop Companion*. The Windows application it builds is installed and shown as **Claude Notifier** (Start Menu entry, tray icon, installer `ClaudeNotifierSetup.exe`).

> **Status: v1.0.0, first release.** The installer is **not code-signed yet**, so Windows SmartScreen may warn about it and Windows 11 *Smart App Control* may block it. See [Installation](#installation) and [Known limitations](#known-limitations).

---

## Contents

1. [What problem does it solve?](#what-problem-does-it-solve)
2. [Features](#features)
3. [Screenshots](#screenshots)
4. [How it works](#how-it-works)
5. [Installation](#installation)
6. [Phone notification setup](#phone-notification-setup)
7. [Using it](#using-it)
8. [Configuration and where your data lives](#configuration-and-where-your-data-lives)
9. [Uninstalling](#uninstalling)
10. [Troubleshooting](#troubleshooting)
11. [Privacy and security](#privacy-and-security)
12. [Known limitations](#known-limitations)
13. [Verification and test summary](#verification-and-test-summary)
14. [Building from source](#building-from-source)
15. [Repository layout](#repository-layout)
16. [License](#license)
17. [Disclaimer](#disclaimer)

---

## What problem does it solve?

Claude Code sessions in Claude Desktop often run for minutes while you do something else. They stop when they need **a permission decision**, **your answer to a question**, or when they are **finished**, or when something goes wrong (an API error, a session limit, a crashed process). If you are in another window, or away from the PC, you only notice when you look back.

Claude Desktop Companion watches your sessions in the background and notifies you at those moments, on the PC and optionally on your phone. It also warns you when your plan usage approaches its limits.

## Features

| Feature | What it does |
|---|---|
| **Claude Desktop / Claude Code session monitoring** | Watches the sessions started from Claude Desktop (read-only) and detects: *finished*, *needs your input*, *needs permission*, *API error*, *session limit reached*, *process exited unexpectedly*. |
| **Windows desktop notifications** | Toast notifications with sounds. Items that need a human stay on screen until the session continues. Repeated alerts are rate-limited so a chatty session cannot bury an important one. |
| **Android phone push (ntfy)** | Optional push notifications through [ntfy](https://ntfy.sh) (the public service or your own server). Messages are **metadata only** (project name, what happened, time); never prompts, code or transcripts. Tested with the Android app. |
| **Usage monitoring** | Warns at 80 % and 90 % of your **5-hour** and **weekly** plan-usage windows, and says so when the data is stale. It reads the usage history file that Claude Desktop itself keeps on your PC (no network, no tokens). |
| **Dark mode and light mode** | *System* (default), *Light* or *Dark*, chosen from the tray menu and applied immediately. Windows High Contrast is always respected. Toast banners follow the Windows theme. |
| **First-run phone onboarding with QR code** | A guided window creates a private ntfy topic on your PC, shows a QR code, sends a test message, and turns phone push on **only after you confirm the test arrived**. |
| **Background monitoring and supervisor** | A small watchdog restarts the notifier if it crashes (with back-off and a restart budget) and stays out of the way on a clean exit. A health check warns you if Claude is running but the notifier can see nothing. |
| **Bundled Node.js runtime** | The installer carries its own, unmodified, signed Node.js runtime. You do not install Node.js or use a terminal. |
| **Windows installer** | A per-user installer (Inno Setup): no administrator rights, no network, optional desktop shortcut, optional start-with-Windows, clean upgrade, and an uninstaller that never deletes your data. |

## Screenshots

> **Placeholders.** No screenshots are committed yet. Replace each line with a real image (for example in `docs/images/`) before or after publishing. See [`docs/images/README.md`](docs/images/README.md).

| Screen | Screenshot |
|---|---|
| Tray menu (dark) | *[placeholder: tray menu in dark mode]* |
| Tray menu (light) with the Appearance submenu | *[placeholder: tray menu in light mode]* |
| Windows toast: "Claude needs permission" | *[placeholder: toast notification]* |
| Phone setup window: subscribe page with QR code | *[placeholder: setup window, subscribe page]* |
| Phone notification in the ntfy app | *[placeholder: phone screenshot, with the topic hidden]* |
| Installer: "Select Additional Tasks" page | *[placeholder: installer wizard]* |

## How it works

```
 Claude Desktop (on your PC)                 Claude Desktop Companion ("Claude Notifier")
 ───────────────────────────                 ─────────────────────────────────────────────────────
 %USERPROFILE%\.claude\sessions\<pid>.json ─┐   watch-sessions.js   session state changes (read-only,
                                            ├─►                     pid + start time verified)
 %LOCALAPPDATA%\Claude\logs\main.log ───────┘   log-tailer.js       permission / stop lines (read-only)
                                                      │
                                              merge-events.js       one de-duplicated event stream
                                                      │
 %APPDATA%\...\plan-usage-history.json ──► usage-monitor.js ──┐
                                                      ▼        ▼
                                              policy.js  (cooldowns, burst limits, what to show)
                                                      │
                          ┌───────────────────────────┼───────────────────────────┐
                          ▼                           ▼                           ▼
                   ui-host.ps1 (tray, toasts,     store.js (local            ntfy.js ──► your ntfy
                   sounds, themed menu)           SQLite history)            server ──► your phone
```

`supervisor.js` starts and watches `notifier.js`, which owns all of the above. The phone setup window (`setup-window.ps1`) and the tray host (`ui-host.ps1`) are PowerShell/WinForms processes that only display things and report clicks; the logic lives in tested JavaScript modules. Full details: [`docs/architecture.md`](docs/architecture.md).

## Installation

**Requirements:** Windows 10 or Windows 11 (developed and tested on Windows 11), and Claude Desktop with Claude Code sessions. No administrator rights, Node.js or terminal are needed.

1. Download **`ClaudeNotifierSetup.exe`** from the project's **Releases** page (once published) and check its SHA-256 against `SHA256SUMS.txt`:
   ```powershell
   Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256
   ```
2. Double-click it and follow the wizard. Two optional tasks are **off** by default: *Create a desktop shortcut* and *Start Claude Notifier when I sign in to Windows*.
3. Leave *Launch Claude Notifier now* ticked on the last page. A tray icon appears next to the clock, and the phone setup window opens on first run.

It installs for your user only, into `%LOCALAPPDATA%\Programs\Claude Notifier`.

> ### The installer is not code-signed
> Version 1.0.0 is **unsigned**. Because of that:
> * **Windows SmartScreen** may show "Windows protected your PC". If you trust the file (its checksum matches), choose **More info → Run anyway**.
> * **Smart App Control** (Windows 11) can block unsigned programs with **no** "run anyway" option; Setup, or its uninstaller, may then not start. Please do not switch Smart App Control off for this: Microsoft does not let you turn it back on without resetting Windows. A signed release needs a code-signing certificate; see [`docs/installation.md`](docs/installation.md) and [`RELEASE-NOTES.md`](RELEASE-NOTES.md).

More: [`docs/installation.md`](docs/installation.md) (silent install for IT, upgrades, checksums).

## Phone notification setup

Phone push is **optional and off** until you confirm a test message.

1. On first start the **Set up phone notifications** window opens (later: tray icon → *Set up phone notifications…*).
2. Install the free **ntfy** app on your Android phone (Google Play or F-Droid; the window links to both).
3. Subscribe to **your private topic** in the ntfy app: scan the QR code, or press *Copy* and paste it. The copied topic is removed from your clipboard again after a minute.
4. Press *Send test notification*. When it arrives, press *I got it*.

The topic is generated on **your** PC, is unique per installation, and works like a password: anyone who knows it can read your notifications. Full guide, self-hosted servers and rotating the topic: [`docs/phone-setup.md`](docs/phone-setup.md).

## Using it

Right-click the tray icon:

| Menu entry | Meaning |
|---|---|
| *Active sessions (n)* | The Claude Desktop sessions currently seen, with their state. |
| Usage line | Your 5-hour / weekly usage, when available. |
| *Notifications enabled / disabled* | Switch Windows notifications on or off. |
| *Sounds enabled / disabled* | Switch notification sounds on or off. |
| *Send test notification* | Shows a test Windows notification. |
| *Phone notifications enabled / disabled* | Click to switch phone push on or off (once it is set up). |
| *Send test phone notification* | Sends a test message to your phone. |
| *Set up phone notifications…* | Opens the phone setup window (it reads *Phone setup…* once you have confirmed a test). |
| *Appearance* → System / Light / Dark | Theme; the check mark shows the current choice. |
| *Open data folder* | Opens `%USERPROFILE%\.claude-notifier`. |
| *Exit* | Stops the notifier for this session (the watchdog does not restart it). |

**Starting with Windows** is chosen in the installer (it is off by default). To change it later, run the installer again and tick or untick *Start Claude Notifier when I sign in to Windows*.

## Configuration and where your data lives

| What | Where |
|---|---|
| Program files | `%LOCALAPPDATA%\Programs\Claude Notifier` |
| **Your data** | `%USERPROFILE%\.claude-notifier` (for example `C:\Users\you\.claude-notifier`) |
| `settings.json` | Your choices: notifications, sounds, phone state, appearance. |
| `ntfy.json` | Your ntfy server and **private topic**: treat it like a password. |
| `history.db` | A short event history (metadata only). |
| `notifier.log`, `supervisor.log` | Technical logs (they never contain your topic). |
| `usage-state.json` | Which usage alerts were already shown. |

Both files are plain JSON. Annotated templates with placeholder values are in [`docs/examples/`](docs/examples/). Installing, upgrading and uninstalling never touch this folder.

## Uninstalling

*Settings → Apps → Installed apps → Claude Notifier → Uninstall.* This stops the notifier and removes the program files, shortcuts and the start-with-Windows entry. **Your data folder is not deleted**, so reinstalling restores everything; delete `%USERPROFILE%\.claude-notifier` yourself if you want it gone as well.

## Troubleshooting

Short version: check Windows notification settings and Focus assist; for the phone, check the subscription, the topic spelling, the ntfy notification permission (Android 13+) and that the phone is online. If Claude is running but the notifier sees nothing, a *health warning* appears. A built-in diagnostic prints a path-redacted report. Full guide: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Privacy and security

* **Read-only:** the app reads Claude Desktop's session status files, its `main.log`, and its plan-usage history file. It does **not** read transcripts, credentials, settings or tokens.
* **Metadata only:** phone messages are built from a fixed allow-list (project name, event type, a short whitelisted detail, time). The conversation-derived *session title* is **not** sent unless you opt in.
* **Local first:** the only network code in the application is the ntfy push (`src/ntfy.js`). There is no telemetry and no update check.
* **No secrets in the project:** your topic is generated on your PC at first run; nothing personal ships in the installer (verified by an automated scan of every release).

Details and the threat model: [`docs/privacy-and-security.md`](docs/privacy-and-security.md).

## Known limitations

* **The installer is unsigned** (SmartScreen warning; Smart App Control may block it). Signing needs a code-signing certificate.
* Developed and tested on Windows 11 and one Android phone; other Windows versions and iOS are untested.
* Works from files that Claude Desktop writes. It is **unofficial**: a Claude Desktop update could change them, in which case the built-in health check warns you and the notifier needs an update.
* Only sessions started **from Claude Desktop** are monitored by the release build (not Claude Code started in a terminal).
* Usage data can be stale: Claude Desktop writes it only while its own tray menu has been opened in the last 24 hours.
* Starting with Windows is set in the installer (there is no switch in the tray menu).
* The tray menu looks slightly soft at 125 % display scaling; rounded menu corners and the menu border colour need Windows 11. Real Windows High Contrast and arrow-key menu navigation were simulated, not tested on a real High Contrast session.
* Two test suites that need two open Claude Desktop sessions (`step2`, `step6`) could not be re-run on the final build; see below.

## Verification and test summary

The project ships with 20 test suites (`src/test-step2.js` … `src/test-step21.js`; documented in [`tests/README.md`](tests/README.md)). They use temporary folders, mock servers and throw-away identities and never touch your real data. Results recorded for **v1.0.0** (counts are individual checks):

| Area | Suites | Last recorded result |
|---|---|---|
| Event stream, policy, storage | step2, 3 | 17, 43 (step2: see note) |
| Phone push (mock server), usage monitor | step4, 5 | 59, 79 |
| Reliability, data-location and profile selection | step6, 7, 9 | 118 of 124 (see note), 69, 72 |
| Release packaging and privacy gates | step8, 10 | 31, 161 |
| Phone onboarding, QR code, setup window, end-to-end | step11–14 | 80, 23, 76, 47 |
| Dark mode, palettes, themed window and tray menu | step15–19 | 67, 109, 104, 51, 51 |
| Installer (silent and graphical wizard) | step20, 21 | 40, 31 |
| Release stage verification (`verify-stage.js`) | n/a | 38 of 38 |

**Honest notes:** `step2` and `step6` need two live Claude Desktop sessions; `step2` could not be re-run on the final build and `step6` ended at 118 of 124 in its last run (six checks of its notification-policy end-to-end and health scenarios, in a run where the pool of live sessions changed mid-run; the cause looks environmental but was **not proven**). Several suites drive real windows and need an interactive desktop. Details and preconditions: [`tests/README.md`](tests/README.md).

## Building from source

Short version (details in [`docs/development.md`](docs/development.md)):

```powershell
# run a headless test suite from the repository root
node src\test-step15.js

# stage the release (requires the exact pinned, signed Node.js runtime; see development.md)
node src\tools\stage.js --check release\stage      # verify an existing stage
node src\tools\verify-stage.js                     # end-to-end verification of the staged build

# build the installer (requires Inno Setup 6 in tools\innosetup, which is not committed)
node src\tools\build-installer.js --version 1.0.0
```

## Repository layout

```
claude-desktop-companion/
├── README.md, RELEASE-NOTES.md, .gitignore, .gitattributes
├── docs/        user and developer documentation, config templates (docs/examples)
├── src/         the project root: application modules, tools/ (staging, verification, installer script), test suites
├── tests/       test documentation (the test scripts live in src/ because they load the modules by relative path)
├── installer/   how the installer is built (output is generated and not committed)
└── release/     release information and checksums (the .exe is a GitHub Release asset, not committed)
```

## License

**No license has been chosen yet.** Until a `LICENSE` file is added, the default copyright rules apply: the code is publicly readable on GitHub but **all rights are reserved**; others may not legally copy, modify or redistribute it. See [`docs/licensing.md`](docs/licensing.md) for the options and their consequences. The installer bundles Node.js, which is MIT-licensed (its notice is installed with the app and kept in `src/tools/licenses/NODE-LICENSE.txt`).

## Disclaimer

Claude Desktop Companion is **not affiliated with, endorsed by, or sponsored by Anthropic**. It is provided **as is**, without warranty. It relies on files and behaviour of Claude Desktop that are not a documented, supported interface and may change at any time.
