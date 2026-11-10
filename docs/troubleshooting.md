# Troubleshooting

Paths below use `%USERPROFILE%\.claude-notifier` for the **data folder** (tray menu → *Open data folder*) and `%LOCALAPPDATA%\Programs\Claude Notifier` for the **program folder**.

## Installation problems

### "Windows protected your PC" (SmartScreen)

The v1.0.0 installer is **not code-signed**. Check the file's SHA-256 against `SHA256SUMS.txt` (`Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256`); if it matches and you trust where you got it, choose **More info → Run anyway**.

### "An Application Control policy has blocked this file" (Smart App Control)

Windows 11 *Smart App Control* (when *On*) blocks unsigned programs by reputation, per file, with no "run anyway". It can block `ClaudeNotifierSetup.exe` and the uninstaller `unins000.exe`. Options:

* There is currently no signed installer to use instead: signing it would avoid this block, but it needs a paid code-signing certificate, which this project does not have.
* Use a PC where Smart App Control is *Off* or in *Evaluation* mode.
* **Do not** turn it off just for this: Microsoft does not let you turn it back on without resetting Windows.

The application itself runs on such PCs: its runtime is the unmodified, signed Node.js, and the rest are scripts. Only the unsigned installer files are affected.

### Setup stops with a message

Setup ends with a non-zero exit code and leaves no half-installed program, shortcut or registry entry. Typical causes: the block above, or the program folder not being writable. If Setup says Claude Notifier "is running and could not be closed automatically", choose *Exit* from its tray icon and run Setup again. For a technical log run the installer with `/LOG="C:\path\setup.log"`.

### The uninstaller will not start

If Smart App Control blocks `unins000.exe`, remove Claude Notifier by hand (your data is not touched):

1. Task Manager → end `ClaudeNotifier.exe` (and any `powershell.exe` started from the program folder).
2. Delete the program folder `%LOCALAPPDATA%\Programs\Claude Notifier`.
3. Delete the Start Menu entry `Claude Notifier` and the optional desktop shortcut.
4. In the registry editor, under `HKEY_CURRENT_USER`, delete: the value `ClaudeNotifier` in `Software\Microsoft\Windows\CurrentVersion\Run` (if present), the key `Software\Classes\AppUserModelId\ClaudeNotifier.Companion`, and the key `Software\Microsoft\Windows\CurrentVersion\Uninstall\{9D2E6C1A-4B7F-4E0B-9C5A-3F6B1A7D2E10}_is1`.

## Windows notifications do not appear

* **Windows Settings → System → Notifications:** make sure notifications are on and *Claude Notifier* is allowed. Check *Do not disturb* / *Focus*.
* The tray menu shows a status line when Windows reports that notifications are disabled for the app, or when the Start Menu shortcut (which Windows needs to show banners) could not be created.
* Use *Send test notification* in the tray menu.
* Toast banners follow the Windows theme; they are not affected by the Appearance setting.

## The tray icon is not there after a restart

Starting with Windows is **off by default**. Start *Claude Notifier* from the Start Menu, and run the installer again to tick *Start Claude Notifier when I sign in to Windows* if you want it automatic.

## Phone notifications

See [`phone-setup.md`](phone-setup.md). The usual causes of a missing test message:

1. You did not tap **Subscribe** for the topic in the ntfy app.
2. The topic was typed with a mistake (use *Copy*, then paste).
3. Android 13+ needs the notification permission for ntfy (*Settings → Apps → ntfy → Notifications*).
4. The phone is offline, or battery optimisation delays ntfy.
5. The server is unreachable from your PC: the window shows a plain-language explanation and *Try again*.

If the tray shows **Phone push is failing**, several pushes in a row failed (network, server, or an invalid configuration). Use *Send test phone notification* after fixing it.

## "Health warning" notices

The notifier compares independent views and warns only when they disagree, never because Claude is merely idle.

| Notice | Meaning | What to do |
|---|---|---|
| *Claude is running, but no sessions are visible* | Claude Code processes exist but the session-file watcher accepts none. | Restart Claude Notifier. If it persists, Claude Desktop probably changed its session files and the notifier needs an update. |
| *Claude Desktop's log lines are not being matched* | Events arrive from session files only. | Notifications still work but may be less accurate; Desktop's log format may have changed. |
| *Session status files are not changing* | Log activity is seen but the status files are silent. | Restart Claude Notifier; if it persists, an update is needed. |
| *The event stream stopped responding* | The internal stream process stopped sending its heartbeat. | Restart Claude Notifier. |

## Usage numbers show "no data yet" or "stale"

Usage figures come from a file that **Claude Desktop** writes, and Desktop only appends to it while its own tray menu has been opened within the last 24 hours. If the data is stale, open Claude Desktop's tray menu to refresh it. If **more than one Claude profile** is open, the notifier says so and does not guess which account to read.

## The notifier keeps restarting or stopped

The watchdog restarts a crashed notifier with back-off, at most 5 times in 10 minutes, then shows one notification and stops. Look at `supervisor.log` and `notifier.log` in the data folder. A clean *Exit* from the tray is never restarted.

## Collect a diagnostic report

From the program folder (paths in the report are redacted):

```powershell
cd "$env:LOCALAPPDATA\Programs\Claude Notifier"
.\ClaudeNotifier.exe notifier.js --diagnose --out "$env:USERPROFILE\Desktop\claude-notifier-diagnose.txt"
```

Review it before sharing. It does not contain your home folder path or account ids, but you are responsible for checking what you post publicly. **Never post `ntfy.json`, your topic, or the contents of the data folder.**

## Enterprise-managed PCs

The tray menu and the setup window are PowerShell scripts started with the system PowerShell. Policies that restrict PowerShell (AppLocker, WDAC, Constrained Language Mode) may block them; this configuration has **not** been tested.
