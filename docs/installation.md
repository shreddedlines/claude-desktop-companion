# Installation guide

This guide is for people who just want to use **Claude Notifier** (the Windows application of Claude Desktop Companion). If you want to build or test the project, see [`development.md`](development.md) instead.

**You need:** Windows 11 (tested; Windows 10 compatibility is not yet verified) and Claude Desktop with Claude Code sessions. You do **not** need Node.js, a terminal or administrator rights, and Setup needs no internet connection.

## Quick install

1. **Download.** Go to the [latest release](https://github.com/shreddedlines/claude-desktop-companion/releases/latest), scroll to **Assets** and click **`ClaudeNotifierSetup.exe`**. If your browser says the file "isn't commonly downloaded", choose **Keep**.
2. **Open it.** Double-click the file. If Windows says **"Windows protected your PC"**, click **More info** and then **Run anyway**. (Why you see this: [next section](#why-windows-warns-you).)
3. **Click through Setup.**
   * *Select Additional Tasks* (both are **off** unless you tick them): *Create a desktop shortcut*, and *Start Claude Notifier when I sign in to Windows*. Click **Next**.
   * *Ready to Install*: click **Install**. A progress bar is shown; nothing is downloaded.
   * *Completing Setup*: leave **Launch Claude Notifier now** ticked and click **Finish**.
4. **Look for the icon** next to the clock (click the **^** arrow if it is hidden). Windows notifications now work. On the first start a window offers to set up **phone notifications**; you can skip it and do it later ([phone setup guide](phone-setup.md)).

That's it. Setup installs only for your own account.

## Why Windows warns you

The v1.0.0 installer is **not code-signed**. A digital signature comes from a certificate that costs money and needs identity checks; this free, independent project does not have one **yet**. Unsigned does not mean harmful, but Windows cannot vouch for it, so it warns. The source code is in this repository, and the installer is built from it.

| You see | What to do |
|---|---|
| Browser: *"isn't commonly downloaded"* / *"Unconfirmed download"* | Choose **Keep** (some browsers: *Show more → Keep anyway*). |
| **"Windows protected your PC"** (SmartScreen) | **More info → Run anyway**, only if you got the file from this repository's Releases page. |
| **"An Application Control policy has blocked this file"** / *"Smart App Control blocked…"* | Windows 11 **Smart App Control** (when *On*) blocks unsigned programs with **no** "Run anyway". You cannot install on that PC for now. **Do not turn Smart App Control off for this:** Windows won't let you turn it back on without resetting the PC. There is currently no signed installer, so use a PC where Smart App Control is *Off* or in *Evaluation* mode. Smart App Control judges each file by reputation, so the same installer may start on one PC and be blocked on another. |

Code signing would reduce these warnings, but it needs a paid code-signing certificate, which this project does not have.

### Check your download (optional)

Every release has a `SHA256SUMS.txt` file with the installer's fingerprint. To compare it:

1. Press the **Windows key**, type `PowerShell`, press **Enter**.
2. Run (adjust the folder if you saved the file elsewhere):
   ```powershell
   cd $env:USERPROFILE\Downloads
   Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256
   ```
3. The code must be **exactly** the one in `SHA256SUMS.txt` (also shown on the release page). If it differs, **do not run the file.**

## After installing

* **Phone notifications** are optional and off until you confirm a test: [`phone-setup.md`](phone-setup.md).
* **Use it:** right-click the tray icon for the menu (test notification, sounds on/off, *Appearance*: System, Light or Dark, and more). See the [README](../README.md#using-it).
* **Starting with Windows** is chosen in Setup and is **off** by default. To change it later, run the installer again and tick or untick *Start Claude Notifier when I sign in to Windows*. (If you ticked it before, the box is already ticked.)

## Upgrading

Run the new `ClaudeNotifierSetup.exe`. It installs over the old version:

* If the app is running, Setup **closes it, replaces the files and starts it again once**. If it was not running, it stays closed unless you tick *Launch Claude Notifier now*.
* Your **settings, appearance, phone setup and history are kept**; Setup never touches your data folder.
* An existing *start with Windows* choice is kept (the box is pre-ticked; unticking it removes the entry).

## Uninstalling

*Settings → Apps → Installed apps → Claude Notifier → Uninstall.* This closes the app and removes the program files, shortcuts, the start-with-Windows entry and the Windows-notification registration. It **does not delete your data**; at the end it tells you where it is. If you want it removed too, delete `%USERPROFILE%\.claude-notifier` yourself afterwards (note that `ntfy.json` holds your private phone topic; reinstalling after deleting it creates a new one).

If Smart App Control blocks the uninstaller, see [`troubleshooting.md`](troubleshooting.md#the-uninstaller-will-not-start) for removing the app by hand.

## If installation fails

Setup shows a plain message and ends without leaving a half-installed program, shortcut or registry entry. The usual causes are the Smart App Control block above, or the program folder not being writable. If Setup says Claude Notifier "is running and could not be closed automatically", choose **Exit** from its tray icon and run Setup again. More help: [`troubleshooting.md`](troubleshooting.md).

---

## Advanced

### Where things go

| What | Where |
|---|---|
| Program files | `%LOCALAPPDATA%\Programs\Claude Notifier` (per user) |
| Start Menu shortcut | `Claude Notifier` (the same entry the app keeps for Windows notifications; there is never a second one) |
| Optional desktop shortcut | `Claude Notifier` on your desktop |
| Optional startup entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `ClaudeNotifier` |
| **Your data** | `%USERPROFILE%\.claude-notifier` (never touched by the installer or uninstaller) |

### Silent / unattended installation (IT)

The installer is a standard Inno Setup program:

```powershell
# install silently, with both optional tasks
.\ClaudeNotifierSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="desktopicon,autostart"

# install silently with no optional tasks
.\ClaudeNotifierSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

An unattended install **never removes** an existing start-with-Windows entry (only a deliberate un-tick in the wizard does). Write a log with `/LOG="C:\path\setup.log"`.
