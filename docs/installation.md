# Installation

This guide covers installing, upgrading and uninstalling **Claude Notifier** (the Windows application of Claude Desktop Companion).

## Requirements

* Windows 10 or Windows 11 (developed and tested on Windows 11).
* Claude Desktop with Claude Code sessions. The notifier monitors sessions that were started **from Claude Desktop**.
* No administrator rights, no Node.js, no terminal and no network connection are needed to install.

## 1. Download and verify

Download `ClaudeNotifierSetup.exe` from the project's **Releases** page. Release files are published together with a `SHA256SUMS.txt` file. Check that your download matches (PowerShell):

```powershell
Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256
```

The output must be exactly the hash in `SHA256SUMS.txt`. If it is not, do not run the file.

## 2. The installer is not code-signed (version 1.0.0)

The v1.0.0 installer has **no digital signature**. What that means for you:

| Windows protection | What may happen | What to do |
|---|---|---|
| **SmartScreen** | "Windows protected your PC" | If the checksum matched and you trust the download source, choose **More info → Run anyway**. |
| **Smart App Control** (Windows 11, when set to *On*) | Setup, or the uninstaller, may be **blocked outright** with the message *"An Application Control policy has blocked this file"*. There is no "run anyway". | Do not turn Smart App Control off just for this: Microsoft does not allow turning it back on without resetting Windows. Wait for a signed release, or install on a PC where Smart App Control is off or in evaluation mode. |

Smart App Control judges unsigned files by reputation, per file, so the same installer may start on one PC and be blocked on another. A **code-signing certificate** is the proper fix; a signed release is planned but needs one (see [`RELEASE-NOTES.md`](../RELEASE-NOTES.md)).

## 3. Run the installer

1. Double-click `ClaudeNotifierSetup.exe`.
2. **Select Additional Tasks** (both are **off** unless you tick them):
   * *Create a desktop shortcut*
   * *Start Claude Notifier when I sign in to Windows*
3. **Ready to Install → Install.** A progress bar is shown; nothing is downloaded.
4. **Finish.** *Launch Claude Notifier now* is ticked by default. The tray icon appears next to the clock and, on first run, the **phone setup** window opens (see [`phone-setup.md`](phone-setup.md); you can skip it).

### Where things go

| What | Where |
|---|---|
| Program files | `%LOCALAPPDATA%\Programs\Claude Notifier` (per user) |
| Start Menu shortcut | `Claude Notifier` (the same entry the app itself keeps for Windows notifications; there is never a second one) |
| Optional desktop shortcut | `Claude Notifier` on your desktop |
| Optional startup entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `ClaudeNotifier` |
| **Your data** | `%USERPROFILE%\.claude-notifier` (never touched by the installer or uninstaller) |

## Upgrading

Run the new `ClaudeNotifierSetup.exe`. Setup installs over the old version:

* If the notifier is running, Setup **closes it cleanly, replaces the program files and starts it again exactly once**. If it was not running, it stays closed unless you tick *Launch Claude Notifier now*.
* Your **settings, appearance, phone setup and history are kept**. The installer does not read or write your data folder.
* If you had *start with Windows* turned on, the box is **pre-ticked**. Unticking it removes the entry; leaving it ticked keeps exactly one entry (never a duplicate).
* Files that no longer exist in the new version are removed.

## Changing the "start with Windows" setting

There is no switch in the tray menu in v1.0.0. Run the installer again and tick or untick **Start Claude Notifier when I sign in to Windows**. As an alternative you can stop the notifier for the current session with *Exit* in the tray menu.

## Silent / unattended installation (IT)

The installer is a standard Inno Setup program:

```powershell
# install silently, with both optional tasks
.\ClaudeNotifierSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="desktopicon,autostart"

# install silently with no optional tasks
.\ClaudeNotifierSetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

An unattended install **never removes** an existing start-with-Windows entry (only a deliberate un-tick in the wizard does). A log is written with `/LOG="C:\path\setup.log"`.

## Uninstalling

*Settings → Apps → Installed apps → Claude Notifier → Uninstall* (or run `unins000.exe` in the program folder). The uninstaller:

* closes the running notifier,
* removes the program files, the Start Menu and desktop shortcuts, the startup entry and the Windows-notification registration,
* **does not delete your data**. At the end it tells you where it is.

If you want your data removed too, delete `%USERPROFILE%\.claude-notifier` yourself afterwards. Be aware that `ntfy.json` contains your private phone topic; deleting it means a new topic is generated if you reinstall.

## If installation fails

Setup shows a plain message and ends with a non-zero exit code, without leaving a half-installed program or any shortcut or registry entry behind. Common causes are the Smart App Control block described above, or the program folder not being writable. For a technical log, run the installer with `/LOG`.

See also [`troubleshooting.md`](troubleshooting.md).
