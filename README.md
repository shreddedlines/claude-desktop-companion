# Claude Desktop Companion

**A Windows tray app that tells you when Claude Code, running inside Claude Desktop, needs you: with Windows notifications and, if you want, push notifications on your Android phone.**

> **Unofficial project.** Claude Desktop Companion is an independent, community project. It is **not affiliated with, endorsed by, or supported by Anthropic.** "Claude" and "Claude Code" are trademarks of Anthropic. The app only *reads* files that Claude Desktop writes on your own PC; it does not talk to Anthropic's services.

## Download

> ### [Download ClaudeNotifierSetup.exe (latest release)](https://github.com/shreddedlines/claude-desktop-companion/releases/latest)
> For **Windows 11** (tested; Windows 10 compatibility is not yet verified) · about 23.5 MB · no administrator rights needed · nothing else to install
>
> **Please read this first:** the installer is **not code-signed yet**, so Windows may show a warning ("Windows protected your PC"). That is expected. It is explained in plain words [below](#windows-warns-me-what-do-i-do), including how to continue safely.

The application is installed and shown as **Claude Notifier** (Start Menu, tray icon). *Claude Desktop Companion* is the name of this project.

**Jump to:** [Install in four steps](#install-in-four-steps) · [Windows warns me](#windows-warns-me-what-do-i-do) · [What it does](#what-it-does) · [Phone notifications](#phone-notifications-optional) · [Using it](#using-it) · [Your data and uninstalling](#configuration-and-where-your-data-lives) · [Problems?](#problems) · [Privacy](#privacy-and-security) · [Known limitations](#known-limitations) · [For developers](#for-developers)

---

## Install in four steps

You need Windows 11 (the version it has been tested on; Windows 10 compatibility is not yet verified) and Claude Desktop with Claude Code sessions. You do **not** need Node.js, a terminal or administrator rights.

1. **Download.** Open the [**latest release**](https://github.com/shreddedlines/claude-desktop-companion/releases/latest), scroll to **Assets** and click **`ClaudeNotifierSetup.exe`**. If your browser says the file "isn't commonly downloaded", choose **Keep**.
2. **Open it.** Double-click the downloaded file. If Windows says **"Windows protected your PC"**, click **More info**, then **Run anyway**. *(Why this happens: [see below](#windows-warns-me-what-do-i-do).)*
3. **Click through Setup.** The first page offers two optional tasks, both **off** unless you tick them: *Create a desktop shortcut* and *Start Claude Notifier when I sign in to Windows*. Click **Next**, then **Install**, then **Finish** (leave *Launch Claude Notifier now* ticked).
4. **You are done.** A small icon appears next to the clock (you may need to click the **^** arrow to see it). Windows notifications now work. On the first start, a window offers to set up **phone notifications**; you can skip it and do it later ([how](docs/phone-setup.md)).

That is all. Setup installs only for your user account, needs no network, and **uninstalling never deletes your settings**.

More detail (silent install for IT, upgrading, where files go): [`docs/installation.md`](docs/installation.md).

## Windows warns me: what do I do?

**Why it happens.** Windows trusts programs that carry a *digital signature* from a certificate authority. Getting such a certificate costs money and requires identity checks, and this free, independent project does not have one **yet**. So the v1.0.0 installer is **unsigned**. Unsigned does not mean harmful, but Windows cannot vouch for it, so it warns. The full source code of the app is in this repository, and the installer is built from it.

**What you may see, and what to do:**

| You see | What it means | What to do |
|---|---|---|
| Your browser: *"isn't commonly downloaded"* / *"Unconfirmed download"* | The file is new and unsigned. | Choose **Keep** (in some browsers: *Show more → Keep anyway*). |
| **"Windows protected your PC"** (SmartScreen) | Windows doesn't recognise the publisher. | Click **More info → Run anyway**, *only if* you downloaded the file from this repository's Releases page. |
| **"An Application Control policy has blocked this file"** or *"Smart App Control blocked…"* | Windows 11 **Smart App Control** (when set to **On**) blocks unsigned programs **with no "Run anyway" button**. | You cannot install on that PC for now. **Please do not turn Smart App Control off for this:** Windows does not let you turn it back on without resetting the PC. There is currently no signed installer, so use a PC where Smart App Control is off. |

**Check that your download is genuine (optional, 1 minute).** Every release includes a `SHA256SUMS.txt` file with the installer's fingerprint. To compare it:

1. Press the **Windows key**, type `PowerShell` and press **Enter**.
2. Type this, using the folder where you saved the file (usually *Downloads*), and press **Enter**:
   ```powershell
   cd $env:USERPROFILE\Downloads
   Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256
   ```
3. The long code it prints must be **exactly** the same as the one on the release page or in `SHA256SUMS.txt`. If it is not, **do not run the file.**

Code signing would reduce these warnings, but it needs a paid code-signing certificate, which this project does not have. Until then, please use the steps above.

---

## What it does

Claude Code sessions in Claude Desktop often run for minutes while you do something else. They stop when they need **a permission decision**, **your answer to a question**, or when they are **finished**, or when something goes wrong. If you are in another window, or away from the PC, you only notice when you look back. Claude Desktop Companion watches your sessions in the background and tells you at those moments, and warns you when your plan usage approaches its limits.

| Feature | What it does |
|---|---|
| **Claude Desktop / Claude Code session monitoring** | Watches sessions started from Claude Desktop (read-only) and detects: *finished*, *needs your input*, *needs permission*, *API error*, *session limit reached*, *process exited unexpectedly*. |
| **Windows desktop notifications** | Toast notifications with sounds. Items that need a human stay on screen until the session continues. Repeated alerts are rate-limited so a chatty session cannot bury an important one. |
| **Android phone push (ntfy)** | Optional push notifications through [ntfy](https://ntfy.sh) (the public service or your own server). Messages are **metadata only** (project name, what happened, time), never prompts, code or transcripts. Tested with the Android app. |
| **Usage monitoring** | Warns at 80 % and 90 % of your **5-hour** and **weekly** plan-usage windows, and says so when the data is stale. It reads the usage file that Claude Desktop itself keeps on your PC (no network, no tokens). |
| **Dark mode and light mode** | *System* (default), *Light* or *Dark*, chosen from the tray menu and applied immediately. Windows High Contrast is always respected. |
| **First-run phone setup with QR code** | A guided window creates a private ntfy topic on your PC, shows a QR code, sends a test message, and turns phone push on **only after you confirm the test arrived**. |
| **Runs quietly in the background** | A small watchdog restarts the app if it crashes; a health check warns you if Claude is running but nothing is being seen. |
| **Nothing else to install** | The installer carries its own, unmodified, signed Node.js runtime. |

## Screenshots

> **Placeholders.** No screenshots are committed yet. See [`docs/images/README.md`](docs/images/README.md) for what will be shown.

| Screen | Screenshot |
|---|---|
| Tray menu (dark) | *[placeholder: tray menu in dark mode]* |
| Tray menu (light) with the Appearance submenu | *[placeholder: tray menu in light mode]* |
| Windows notification | *[placeholder: toast notification]* |
| Phone setup window: subscribe page with QR code | *[placeholder: setup window, subscribe page]* |
| Phone notification in the ntfy app | *[placeholder: phone screenshot, with the topic hidden]* |
| Installer: "Select Additional Tasks" page | *[placeholder: installer wizard]* |

## Phone notifications (optional)

Phone push is **optional and off** until you confirm a test message.

1. On first start the **Set up phone notifications** window opens (later: tray icon → *Set up phone notifications…*).
2. Install the free **ntfy** app on your Android phone (Google Play or F-Droid; the window links to both).
3. Subscribe to **your private topic** in the ntfy app: scan the QR code, or press *Copy* and paste it. The copied topic is removed from your clipboard again after a minute.
4. Press *Send test notification*. When it arrives, press *I got it*.

The topic is generated on **your** PC, is unique per installation, and works like a password: anyone who knows it can read your notifications. Full guide, self-hosted servers and creating a new topic: [`docs/phone-setup.md`](docs/phone-setup.md).

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
| *Exit* | Stops the app for this session. |

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

Both settings files are plain JSON; annotated templates with placeholder values are in [`docs/examples/`](docs/examples/). Installing, upgrading and uninstalling never touch this folder.

**Uninstalling:** *Settings → Apps → Installed apps → Claude Notifier → Uninstall.* This stops the app and removes the program files, shortcuts and the start-with-Windows entry. **Your data folder is not deleted**, so reinstalling restores everything; delete `%USERPROFILE%\.claude-notifier` yourself if you want it gone as well.

## Problems?

* **No notifications:** check Windows *Settings → System → Notifications* (and *Do not disturb*), then use *Send test notification* in the tray menu.
* **Phone test doesn't arrive:** check that you tapped *Subscribe* in the ntfy app, the topic spelling (use Copy and paste), the notification permission on Android 13+, and that the phone is online.
* **Installer blocked or warned:** see [Windows warns me](#windows-warns-me-what-do-i-do).

More, including health warnings and a diagnostic report: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Privacy and security

* **Read-only:** the app reads Claude Desktop's session status files, its `main.log`, and its plan-usage history file. It does **not** read transcripts, credentials, settings or tokens.
* **Metadata only:** phone messages are built from a fixed allow-list (project name, event type, a short whitelisted detail, time). The conversation-derived *session title* is **not** sent unless you opt in.
* **Local first:** the only network code in the application is the ntfy push (`src/ntfy.js`). There is no telemetry and no update check.
* **No secrets in the project:** your topic is generated on your PC at first run; nothing personal ships in the installer (verified by an automated scan of every release).

Details and the threat model: [`docs/privacy-and-security.md`](docs/privacy-and-security.md).

## Known limitations

* **The installer is unsigned** (SmartScreen warning; Smart App Control may block it). Signing needs a code-signing certificate.
* Developed and tested on Windows 11 and one Android phone; other Windows versions and iOS are untested.
* It works from files that Claude Desktop writes. It is **unofficial**: a Claude Desktop update could change them, in which case the built-in health check warns you and the app needs an update.
* Only sessions started **from Claude Desktop** are monitored (not Claude Code started in a terminal).
* Usage data can be stale: Claude Desktop writes it only while its own tray menu has been opened in the last 24 hours.
* Starting with Windows is set in the installer (there is no switch in the tray menu).
* The tray menu looks slightly soft at 125 % display scaling; rounded menu corners and the menu border colour need Windows 11. Real Windows High Contrast and arrow-key menu navigation were simulated, not tested on a real High Contrast session.

## License

**No license has been chosen yet.** Until a `LICENSE` file is added, the default copyright rules apply: the code is publicly readable on GitHub but **all rights are reserved**; others may not legally copy, modify or redistribute it. See [`docs/licensing.md`](docs/licensing.md). The installer bundles Node.js, which is MIT-licensed (its notice is installed with the app and kept in `src/tools/licenses/NODE-LICENSE.txt`).

## Disclaimer

Claude Desktop Companion is **not affiliated with, endorsed by, or sponsored by Anthropic**. It is provided **as is**, without warranty. It relies on files and behaviour of Claude Desktop that are not a documented, supported interface and may change at any time.

---

# For developers

Everything above is for people who just want to use the app. The rest of this page is for people who want to understand, build or test it. Detailed guides: [`docs/development.md`](docs/development.md) (building and testing), [`docs/architecture.md`](docs/architecture.md) (design), [`tests/README.md`](tests/README.md) (test suites).

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

`supervisor.js` starts and watches `notifier.js`, which owns all of the above. The phone setup window (`setup-window.ps1`) and the tray host (`ui-host.ps1`) are PowerShell/WinForms processes that only display things and report clicks; the logic lives in tested JavaScript modules. The application has **no npm dependencies**. Full details: [`docs/architecture.md`](docs/architecture.md).

## Building from source

Short version (details, prerequisites and the release process are in [`docs/development.md`](docs/development.md)):

```powershell
# run a headless test suite from the repository root
node src\test-step15.js

# stage the release (requires the exact pinned, signed Node.js runtime; see development.md)
node src\tools\stage.js --check release\stage      # verify an existing stage
node src\tools\verify-stage.js                     # end-to-end verification of the staged build

# build the installer (requires Inno Setup 6 in tools\innosetup, which is not committed)
node src\tools\build-installer.js --version 1.0.0
```

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
