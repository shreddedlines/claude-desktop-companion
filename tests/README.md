# Tests

The test scripts live in [`../src/`](../src/) (`test-step2.js` … `test-step21.js`), **next to the modules they test**, because they load those modules by relative path and use their own folder as the application root (see [`../docs/development.md`](../docs/development.md)). This folder holds the test documentation.

"step" is the name of the development stage each suite was written in (the numbering starts at 2; there is no `step1`).

## How to run

From the repository root:

```powershell
node src\test-step15.js
```

Every suite prints one `PASS` / `FAIL` line per check, ends with `n/n checks passed`, and exits non-zero if any check failed. They use temporary folders, mock ntfy servers (nothing real is sent), fake Windows profiles and throw-away identities. **They never touch your real `%USERPROFILE%\.claude-notifier`.** (Some suites take a read-only snapshot of your real data first and verify at the end that it is unchanged.)

## Suites

| Suite | Covers | Needs | Last recorded result |
|---|---|---|---|
| `step2` | `merge-events.js`: the merged, de-duplicated event stream; log rotation (rename and truncate); stale and recycled PIDs | **2 live Claude Desktop sessions** (borrows two valid pid / start-time pairs; read-only) | 17 / 17 (not re-run on the final build) |
| `step3` | `policy.js` (cooldowns, burst limits, retraction), `store.js`, `sounds.js`, the notifier with simulated tray input | headless | 43 / 43 |
| `step4` | `ntfy.js` payload allow-list and privacy, retries, transport against a local mock server | headless | 59 / 59 |
| `step5` | `usage-monitor.js`: 80 % / 90 % thresholds, stale data, account switch, restart behaviour | headless | 79 / 79 |
| `step6` | Reliability regressions: supervisor lifecycle, health canary, CPU use, cooldowns, unknown *waiting*, phone failures, single instance, Windows toasts, privacy | **2 live Claude Desktop sessions**; briefly starts the real tray host | 118 / 124 in the last run (see below) |
| `step7` | Data-folder location (AppData virtualization), usage-history discovery, migration, launch-context separation | headless | 69 / 69 |
| `step8` | Bundled Node.js runtime and launcher: stages a build and proves it runs without Node.js on `PATH` | the pinned Node.js; real processes | 31 / 31 |
| `step9` | Active Claude Desktop profile selection (`claude-profile.js`) with fake profiles and mocked process data | headless | 72 / 72 |
| `step10` | Release packaging and privacy validation: attacks the stage (tampering, planted secrets, dev controls) | the pinned Node.js; **long (about 5 minutes)** | 161 / 161 |
| `step11` | Onboarding state machine and ntfy configuration lifecycle (`onboarding.js`) | headless | 80 / 80 |
| `step12` | `qr.js` against independent decoders | Python with OpenCV | 23 / 23 |
| `step13` | The real phone setup window (UI Automation, screenshots, QR decoding, clipboard clean-up and its contention/retry behaviour) | **interactive desktop**, Python + OpenCV | 76 / 76 |
| `step14` | First-run phone onboarding end to end through the real notifier and a mock server | interactive desktop; at least one Claude Desktop session file as a template | 47 / 47 |
| `step15` | `theme.js`: appearance preference, persistence, fallbacks, Windows theme detection, High Contrast | headless | 67 / 67 |
| `step16` | `palette.js`: token completeness, WCAG contrast (text 4.5:1, non-text 3:1), QR colours | headless | 109 / 109 |
| `step17` | Light / Dark / High Contrast in the real setup window (pixel sampling, focus rings, dialogs) | **interactive desktop** (do not use the PC while it runs) | 104 / 104 |
| `step18` | The real tray host: themed menu rendering, hover, live theme change, High Contrast, real mouse clicks | **interactive desktop** | 51 / 51 |
| `step19` | The Appearance preference inside the real notifier (persistence, restarts, untouched `ntfy.json`, live setup-window re-theming) | **interactive desktop** | 51 / 51 |
| `step20` | The installer in an isolated test identity (silent install, upgrade while running, startup/desktop options, uninstall, data preservation) | Inno Setup 6 and both `--test` installers built (`1.0.0` and `1.0.1`) | 40 / 40 |
| `step21` | The graphical installer wizard, driven by real mouse clicks (default checkboxes, Launch now, pre-ticked startup, un-tick, cancel, failure message) | as `step20`, plus an interactive desktop | 31 / 31 |

Release verification (not a `test-step` file): `node src\tools\verify-stage.js` runs the staged build end to end; **38 / 38** on the v1.0.0 release.

## Honest notes on the recorded results

* **`step2` and `step6`** need two live Claude Desktop sessions. On the final build, `step2` could not be run (only one Desktop session was open). `step6` ended at **118 of 124**: five checks of its "waiting with an unknown reason" end-to-end scenario and one health check failed. In that run, the pool of live sessions the test borrows had changed while it ran, so the cause looks environmental. It was **not proven**, and no notifier code changed between its last fully green run (124 / 124) and that run. Please re-run both on a machine with two open sessions.
* **Interactive-desktop suites** (`step13`, `17`, `18`, `19`, `21`, and parts of `6`, `14`) photograph and click real windows. Keep the desktop quiet while they run. A browser taking the foreground can make a pixel-sampling check retry; retries are printed, never hidden.
* **`step13`** had intermittent failures in its clipboard checks earlier in development. They were traced to timing assumptions in the test (fixed sleeps around a clipboard that other Windows components may briefly hold open) and to one weakness in the application (the clipboard clean-up was best-effort and silent). Both were fixed without weakening any assertion, and the suite then passed ten consecutive runs.
* **`step20` and `step21`** run unsigned installer files. On Windows 11 with Smart App Control enabled, Windows may refuse to start an unsigned executable (this happened a few times during development); the suites retry the start, count every refusal and print it.
* **`step10` and very long folder paths.** One of its embedded `verify-stage` checks reads a start-up line that the notifier writes to its log cut off at 300 characters. If the repository is cloned into a very deeply nested folder, that line can be truncated and the check ("the event stream uses the default sessions / log folders and the fixed 1200 ms hold") fails although the product is correct. Run the suites from a short path such as `C:\dev\claude-desktop-companion`.
* The tests describe what was verified on the development machine (Windows 11). They do not prove behaviour on other Windows versions.

## Adding a test

Follow the existing pattern: scratch folders only, injected clocks and senders, one `check(name, ok, detail)` per fact, and a final summary with a non-zero exit code on failure. Never read or write the real data folder, registry keys or shortcuts from a test, and never print a topic or token.
