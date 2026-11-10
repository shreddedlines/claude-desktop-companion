# Development guide

## Repository layout and why it looks like this

```
claude-desktop-companion/            <- repository root
├── src/                             <- the PROJECT ROOT: application modules, tools/, test suites
│   ├── notifier.js, supervisor.js, ... (27 application files)
│   ├── tools/
│   │   ├── stage.js, verify-stage.js    release staging, gates and end-to-end verification
│   │   ├── build-installer.js           builds ClaudeNotifierSetup.exe
│   │   ├── installer/                   Inno Setup script + stop-notifier.ps1
│   │   ├── installer-test/              driver for the graphical installer test
│   │   ├── uia.js, uia-agent.ps1        UI Automation helper used by the window tests
│   │   ├── licenses/NODE-LICENSE.txt    licence text of the bundled runtime
│   │   └── release/devhooks.js          the inert production stub of devhooks.js
│   └── test-step2.js ... test-step21.js
├── docs/   tests/   installer/   release/    documentation and release information
└── (generated, git-ignored)  release/stage/  installer/out*/  installer/work/  installer-test/  tools/innosetup/ ...
```

The tests and tools were written against a fixed relative layout: tests load modules with `require('./notifier')` and use their own folder as the application root; the tools use the folder **above** `src/tools` as the "workspace root" for generated output (`release/stage`, `installer/out`, `installer-test`, `tools/innosetup`). Keeping `src/` as one runnable project root with the repository root as the workspace root preserves that layout **exactly**, which is why the 27 application files are byte-identical to the verified v1.0.0 sources and why the `tests/` and `installer/` folders contain documentation only.

**Publication edits.** Relative to the original development tree, exactly four files of the 57 under `src/` were adjusted for publication; none is an application file:

* `src/test-step10.js`: the "source-folder path in a shipped file" fixture used one developer's hard-coded folder, so it could only pass on that machine. It now plants the real source folder of the tree under test (the scanner's "source folder" rule is exactly that), and the personal-path assertion is required whenever that folder matches the rule, as before.
* `src/test-step20.js`, `src/test-step21.js`, `src/tools/build-installer.js`: a comment or header line that named the developer's folder now says `<repository root>`.

> The release manifest records SHA-256 hashes of the exact bytes of each source file. `.gitattributes` therefore disables line-ending conversion (`* -text`). Do not change that, and do not run an editor-wide "normalise line endings" over `src/`.

## Prerequisites

* **Windows 11** (tested; Windows 10 compatibility is not yet verified) and PowerShell 5.1 (the UI parts are PowerShell/WinForms).
* **Node.js v24.18.0** (the release bundles exactly this version; the application has **no npm dependencies** and uses Node's built-in `node:sqlite` and `fetch`).
* For the QR decoding checks and screenshots in some tests: Python with `opencv-python` (optional).
* For the installer: **Inno Setup 6** (developed with 6.7.3) in `tools\innosetup\` at the repository root (not committed).

## Running from source

The launcher falls back to `node` on `PATH` when it does not find the bundled runtime:

```powershell
node src\supervisor.js        # watchdog + notifier + tray (a real tray icon appears)
```

Development and test controls (for example `--data-dir`, `--ui none`, `--no-lock`, `--system-theme`) live in `src/devhooks.js`. They exist **only** in the development tree: the release contains the stub `src/tools/release/devhooks.js`, and the release scanner fails the build if any control name leaks into the package.

When experimenting, always use a scratch data folder so your real configuration is never touched, for example:

```powershell
node src\notifier.js --ui none --dump-menu --no-lock --no-usage --duration 5 --data-dir $env:TEMP\cdc-data
```

(`--ui none` runs without the tray and prints the menu model as JSON; `--duration 5` makes it exit after five seconds.)

## Tests

```powershell
node src\test-step15.js        # fast, headless
```

Each suite prints one `PASS`/`FAIL` line per check and a final `n/n checks passed`, and exits non-zero on failure. They use temporary folders, mock ntfy servers, fake Windows profiles and throw-away registry keys/identities. **Some suites open real windows and need an interactive desktop, and two need two live Claude Desktop sessions**; see [`../tests/README.md`](../tests/README.md) for what each suite covers and needs.

## Building a release

1. **Stage** (requires the exact pinned, signed `node.exe`; the tool verifies version, Authenticode signature and SHA-256):
   ```powershell
   node src\tools\stage.js [--out DIR] [--node C:\path\to\node.exe]    # default output: release\stage
   node src\tools\stage.js --check release\stage                       # re-verify manifest and every gate
   node src\tools\verify-stage.js                                      # run the staged build end to end (fake profile)
   ```
2. **Installer** (the release stage is **copied**; the original is never modified):
   ```powershell
   node src\tools\build-installer.js --version 1.0.0        # -> installer\out\ClaudeNotifierSetup.exe
   node src\tools\build-installer.js --test --version 1.0.0 # isolated test variant -> installer\out-test\
   ```
3. Installer tests (need both `--test` builds, `1.0.0` and `1.0.1`):
   ```powershell
   node src\test-step20.js     # silent install / upgrade / uninstall in an isolated test identity
   node src\test-step21.js     # the graphical wizard, driven by real mouse clicks
   ```
   Both run in a *test identity* (own application id, shortcut name, startup value and toast key) with a fake Windows profile; they snapshot your real data, startup value and shortcuts first and verify at the end that nothing changed.
4. **Checksums and release notes:** record the installer's SHA-256 and size (see [`../release/README.md`](../release/README.md)).

### Code signing (not yet in the repository)

The v1.0.0 installer is unsigned. When a certificate is available, the Inno Setup script should use a `SignTool` definition passed on the command line (so no key, thumbprint or password is in the script) and `SignedUninstaller=yes`, SHA-256 digests and an RFC 3161 timestamp. **A private signing key must never be stored in this repository, the application folder, the installer source or the release package**; the `.gitignore` excludes common key and credential file types as a safety net. Keep key material on a hardware token or in a cloud HSM and read credentials from outside the repository.

## Conventions

* **No npm dependencies.** Keep it that way: it keeps the supply chain and the release scan simple.
* **Metadata only.** Any new data sent to a phone must be added to the allow-list in `ntfy.js` and covered by a privacy test.
* **Separation:** the phone configuration code (`onboarding.js`, `ntfy.js`) must stay independent of appearance; `step16` asserts that neither uses the palette.
* **ASCII-only PowerShell** in `setup-window.ps1` (Windows PowerShell 5.1 reads BOM-less files as ANSI); `step13` and the release scanner reject non-ASCII characters.
