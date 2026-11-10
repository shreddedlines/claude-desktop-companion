# Architecture

This document describes how Claude Desktop Companion (installed as **Claude Notifier**) is built. All file names refer to [`src/`](../src/).

## Design principles

1. **Read-only toward Claude Desktop.** The app only *reads* a few files that Claude Desktop writes. It never writes to Claude's folders, never reads transcripts, credentials, settings or tokens.
2. **Metadata only.** What is stored locally and what is sent to a phone is built from fixed allow-lists of event metadata.
3. **Pure logic, thin UI.** Decisions (what to show, when, whether a push may be sent) live in small, testable JavaScript modules with injected clocks and senders. The Windows UI processes only render and report clicks.
4. **Every claim has a test.** Privacy rules, state machines and release gates each have automated tests (see [`tests/README.md`](../tests/README.md)).
5. **One data folder, outside AppData.** `%USERPROFILE%\.claude-notifier`, so the same files are seen however the app was launched.
6. **Release ≠ development.** Test and debug controls live in `devhooks.js`; the release contains an inert stub, and the release scanner fails the build if any development control name appears.

## Process model

```
Claude-Notifier.vbs  (wscript, hidden, started by the Start Menu shortcut / startup entry)
  └─ ClaudeNotifier.exe supervisor.js           the watchdog
       └─ ClaudeNotifier.exe notifier.js        the application (single instance, lock.js)
            ├─ ClaudeNotifier.exe merge-events.js --json --hold 1200     event stream
            │    └─ ClaudeNotifier.exe watch-sessions.js                 session-file watcher
            ├─ powershell.exe ui-host.ps1                                 tray icon, menu, toasts, sounds
            └─ powershell.exe setup-window.ps1   (only while the phone setup window is open)
```

`ClaudeNotifier.exe` is the unmodified, signed Node.js runtime, renamed. Programs the app starts (PowerShell, `reg.exe`, `wscript.exe`) are started by **full path** resolved through `winpaths.js`; nothing depends on `PATH`, and a release gate rejects code that launches a system program by bare name.

### Supervisor (`supervisor.js`)

Starts `notifier.js` and waits. A clean exit (exit code 0: tray *Exit*, "already running", SIGTERM) ends the supervisor too. Any other exit or crash is logged with code and signal and followed by a restart with exponential back-off; at most 5 restarts per 10 minutes, then it stops and shows one Windows notification (`notify-once.ps1`).

## Data flow

### 1. Sources (`watch-sessions.js`, `log-tailer.js`, `merge-events.js`)

| Source | Location | Used for |
|---|---|---|
| Session status files | `%USERPROFILE%\.claude\sessions\<pid>.json` | busy / idle / waiting transitions. A file counts as live only if the PID exists **and** its creation time matches the file's `procStart` (rejects dead and recycled PIDs). Only sessions of the `claude-desktop` entrypoint are used. |
| Claude Desktop log | `%LOCALAPPDATA%\Claude\logs\main.log` (+ `main1.log` on rotation) | permission requests, Stop hook, session limit, API errors, process exits. Read-only tail that handles rename and copy-truncate rotation, partial lines and split UTF-8. |
| Plan-usage history | Claude Desktop's own `plan-usage-history.json` (discovered, see below) | the 5-hour and weekly usage percentages (`usage-monitor.js`). |

`merge-events.js` runs the watcher as a child and the log tailer, then emits **one normalized, de-duplicated event stream**: the same event seen in both sources within a short hold window (about 1.2 s in the notifier) becomes a single event. It also emits heartbeats that the health canary watches.

### 2. Policy (`policy.js`)

A pure function: normalized event in, `{ notified, reason, actions[] }` out. It adds anti-spam on top of the merge:

* an identical event (same session and type, same request id when there is one) inside a cooldown is suppressed; a *different* prompt is never suppressed;
* a burst limiter: at most 4 normal toasts and 8 persistent toasts per window, the rest become one summary toast. The two buckets are independent, so chatty events cannot hide important ones;
* a persistent toast is retracted when the session resumes or finishes; a *waiting* event resolved before delivery is dropped; stale events (replay, delayed) never notify.

Event types: `TURN_FINISHED`, `WAITING_FOR_USER`, `WAITING_FOR_PERMISSION`, `API_ERROR`, `SESSION_LIMIT`, `PROCESS_EXITED_ERROR`, `WAITING_UNKNOWN`, `USAGE_WARNING`, `USAGE_CRITICAL`, `USAGE_STALE` and app notices (`HEALTH_WARNING`, `PHONE_FAILING`).

### 3. Outputs

* **Windows UI:** `notifier.js` sends JSON lines to `ui-host.ps1` (tray menu model, toasts, theme) and receives menu clicks. Toasts need a Start Menu shortcut with an AppUserModelID (`app-shortcut.ps1`), which the app keeps up to date itself.
* **Phone:** `ntfy.js` builds the request body from an allow-list (`topic`, `title`, `message`, `priority`, `tags`) and posts it with Node's built-in `fetch`. It is the **only module with a network client**. Per-type priorities, hold delays (cancelled if the session resumes) and on/off switches come from `ntfy.json`.
* **History and settings:** `store.js` keeps `settings.json` and a metadata-only SQLite history (`history.db`, Node's built-in `node:sqlite`, with a JSONL fallback).
* **Sounds:** `sounds.js` generates the notification sounds into the data folder.

## Finding Claude Desktop's files (`paths.js`, `claude-profile.js`)

Claude Desktop is an MSIX app, so Windows may show processes it launches a private copy of `%APPDATA%`. The notifier therefore stores its own data outside AppData and **discovers** Claude's files instead of assuming paths (every `Claude*` folder under AppData, plus package stores). `claude-profile.js` decides which Claude Desktop profile is **active** (from the running Electron processes' `--user-data-dir`, then from live Claude Code processes, then from file activity) so the usage monitor reads the right account's file; if it cannot tell, it reports *ambiguous* and does not guess.

## Reliability

* **Health canary (`health.js`).** Pure logic that compares independent views (are Claude Code processes running? does the watcher see sessions? do both sources agree? is the stream's heartbeat alive?) and raises one warning per episode (*SESSIONS_BLIND*, *LOG_BLIND*, *FILES_BLIND*, *STREAM_STALLED*), never because Claude is merely idle.
* **Single instance (`lock.js`)**, stale-lock detection, clean exit codes that the supervisor understands.
* **Phone failure tracking:** repeated push failures raise a *Phone push is failing* notice.

## Phone onboarding (`onboarding.js`, `setup-controller.js`, `setup-window.ps1`, `qr.js`)

`onboarding.js` is a state machine (`new → in-progress → test-sent / test-failed → confirmed`, or `dismissed`) with injected store, sender and clock. Rules enforced there, each with tests: the topic is generated **on this machine**; `phoneEnabled` becomes true **only** through the user's confirmation of a test the server accepted in the last 30 minutes; a corrupt `ntfy.json` is never overwritten silently; rotating the topic turns phone push off; the topic is never written to a log. `setup-controller.js` bridges the state machine and the WinForms window over JSON lines; `qr.js` is a dependency-free QR encoder (verified by independent decoding) whose codes are always drawn black on white.

## Appearance (`theme.js`, `palette.js`)

The preference (`system` | `light` | `dark`) is stored as the single `appearance` key in `settings.json`. `theme.js` reads the Windows apps theme and High Contrast flag with `reg.exe` and resolves the effective theme (High Contrast always wins and means "plain Windows colours"). `palette.js` holds 24 semantic colour tokens for Light and Dark, tested for WCAG contrast (text 4.5:1, non-text 3:1). The tray host draws a custom menu renderer (with a fallback to Windows' own rendering in High Contrast); the setup window themes every control; toasts remain under Windows control.

## Release packaging (`src/tools/stage.js`, `verify-stage.js`)

`stage.js` builds the release from an **allow-list** (27 application files, third-party notices, the licence text and the pinned runtime = 32 files) in a separate folder and replaces the previous output only after every gate passed:

* the manifest (SHA-256, size, path; reproducible, no timestamps or absolute paths);
* the dependency closure (every local `require` and referenced script is in the package);
* no development control names anywhere (`--data-dir`, `--no-lock`, `--system-theme` …), no development environment variables;
* a privacy scan for protected strings (read in memory, never printed) and personal paths;
* the runtime's version, Authenticode signature and SHA-256 are pinned.

`verify-stage.js` then **runs** the staged build with a `PATH` that contains nothing useful and a fake Windows profile, and checks that production ignores every development control, uses the default folders, holds the lock, and performs a first-run phone setup, without touching the real machine.

## Installer (`src/tools/installer/`, `src/tools/build-installer.js`)

An Inno Setup 6 script builds `ClaudeNotifierSetup.exe` from a **copy** of the verified stage (re-checked against the manifest). Per-user, no administrator rights. A small PowerShell script (`stop-notifier.ps1`, embedded as an encoded command) stops exactly the processes of one installation folder (watchdog first, repeated until none is left) before an upgrade or uninstall. The Start Menu shortcut uses the same name the app itself maintains. The startup value `ClaudeNotifier` is written in the same form as the app's own `--autostart-enable`. The installer and uninstaller never touch `%USERPROFILE%\.claude-notifier`. A `--test` build variant has its own identifiers so that installer tests can run beside a real installation. See [`installer/README.md`](../installer/README.md).

## Testing approach

Tests are synthetic and isolated: temporary folders, fake Windows profiles, mock ntfy servers, throw-away AppUserModelIDs and registry keys, and UI Automation plus pixel sampling for the real windows. See [`tests/README.md`](../tests/README.md).
