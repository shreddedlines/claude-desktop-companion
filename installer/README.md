# Installer

The installer is built with **[Inno Setup 6](https://jrsoftware.org/isinfo.php)**. Its sources are in [`../src/tools/`](../src/tools/) (the build tooling resolves its paths relative to that layout, see [`../docs/development.md`](../docs/development.md)); this folder is where the **generated** output goes and is not committed:

| Folder (generated, git-ignored) | Contents |
|---|---|
| `installer/out/` | `ClaudeNotifierSetup.exe`, the production installer |
| `installer/out-test/` | the isolated **test** variants used by `step20` / `step21` |
| `installer/work/` | the verified copy of the release stage that the installer is built from |

## Sources

| File | Purpose |
|---|---|
| `src/tools/installer/ClaudeNotifier.iss` | The Inno Setup script. |
| `src/tools/installer/stop-notifier.ps1` | Stops exactly the processes of one installation folder; embedded in the installer and uninstaller as an encoded command (it is **not** installed with the app). |
| `src/tools/build-installer.js` | Verifies the release stage, copies it to `installer/work/payload`, re-verifies the copy against `MANIFEST.txt`, and runs `ISCC`. |
| `src/tools/installer-test/wizard-driver.ps1` | UI Automation / mouse driver used only by the graphical installer test. |

## Behaviour

* **Per user**, `%LOCALAPPDATA%\Programs\Claude Notifier`, no administrator rights, no network.
* **Start Menu shortcut** `Claude Notifier` (the file the application itself keeps for Windows notifications); optional **desktop shortcut** (off by default).
* **Start with Windows** is an optional task, **off by default** for new installations; it writes the same `HKCU\...\Run` value (`ClaudeNotifier`) that the app's own `--autostart-enable` writes. On upgrade an existing entry is pre-ticked; a silent install never removes it; only a deliberate un-tick in the wizard does.
* **Upgrade in place:** the running notifier is stopped (watchdog first, repeated until nothing is left), files are replaced, and it is started again exactly once if it was running.
* **Uninstall** removes the program, shortcuts, the startup entry and the toast registration, and **never deletes `%USERPROFILE%\.claude-notifier`**.
* The installer **bundles the verified release stage unchanged**; it does not rebuild or modify the application.

## Building

Prerequisite: Inno Setup 6 (developed with 6.7.3) installed into `tools\innosetup\` at the repository root (the folder is git-ignored; download the official installer from jrsoftware.org and verify its signature).

```powershell
node src\tools\stage.js                                    # build the verified release stage first
node src\tools\verify-stage.js
node src\tools\build-installer.js --version 1.0.0          # -> installer\out\ClaudeNotifierSetup.exe
```

For the installer tests build the isolated variants (they have their own application id, shortcut name, startup value and toast key, so they can run beside a real installation):

```powershell
node src\tools\build-installer.js --test --version 1.0.0
node src\tools\build-installer.js --test --version 1.0.1
node src\test-step20.js
node src\test-step21.js
```

## Code signing (not configured in v1.0.0)

The v1.0.0 installer is **unsigned**, so SmartScreen may warn and Windows 11 Smart App Control may block it (and the generated `unins000.exe`). When a code-signing certificate is available, add a `SignTool` definition on the `ISCC` command line (`/S<name>=<command>`, not in the script), `SignedUninstaller=yes`, SHA-256 digests and an RFC 3161 timestamp. **The private key must never be stored in this repository, the application folder, the installer source or the release package.** See [`../docs/development.md`](../docs/development.md#code-signing-not-yet-in-the-repository).
