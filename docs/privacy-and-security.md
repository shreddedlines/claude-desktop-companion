# Privacy and security

This page states what the application reads, stores and sends, and where its limits are. Each statement about code behaviour is enforced by an automated test or a release gate unless marked otherwise.

## What it reads on your PC (read-only)

| File | Purpose |
|---|---|
| `%USERPROFILE%\.claude\sessions\<pid>.json` | Session status (busy, idle, waiting) and project name. Only files named `<digits>.json` are opened. |
| Claude Desktop's `main.log` / `main1.log` | Permission requests, Stop hooks, session limits, API errors, process exits. |
| Claude Desktop's `plan-usage-history.json` | The 5-hour and weekly usage percentages. |
| Process list (names, ids, image path, `--user-data-dir`) | To tell which Claude Desktop profile is active, and to confirm that a session's process is really alive. Full command lines never reach the application. |
| Windows theme and High Contrast registry values | Appearance. |

It **never** reads conversation transcripts, credentials or tokens, Claude's settings, the `*.key` files or peer pipes. Usage data carries an organisation id: it is never displayed or sent; only a short hash is kept locally, to notice an account switch.

## What it stores locally

In `%USERPROFILE%\.claude-notifier` (see [`../README.md`](../README.md#configuration-and-where-your-data-lives)): your settings, `ntfy.json` (server, private topic, optional token), a metadata-only event history (time, session label, project folder name, event type, short whitelisted detail, whether a notification was shown), logs, and generated sound files. Nothing is encrypted at rest: protect the folder as you would any file under your user profile.

## What leaves your PC

**Only phone push messages**, and only if you set up and confirmed phone notifications. The application contains **one** network client: Node's built-in `fetch` in `src/ntfy.js` (the onboarding code sends through it). There is no telemetry, analytics, crash reporting or update check. The installer needs no network.

A push request body is built **only** from this allow-list:

```
topic, title, message, priority, tags
```

* `message` is assembled from the project folder name, one short sanitised detail per event type, and a clock time. The per-type details are: the **name** of the tool for a permission prompt (for example `Bash`), the reset time of a session limit, the exit code of a crashed process, or a short scrubbed error line for an API error.
* Prompts, code, file contents, transcripts, tokens and credentials are never read, so they cannot be sent.
* The conversation-derived **session title** is **not** sent unless you opt in (`includeSessionTitle` in `ntfy.json`, with `configVersion` 2). Configurations written before this default existed are treated as opted out.
* The test message is generic ("not a Claude event") and contains no project or session name.

### The ntfy topic is a shared secret

The topic is the only thing that protects who can read your notifications. It is generated on your PC (about 79 bits of randomness, no look-alike characters), unique per installation, never shipped, never written to a log, and never shown in a notification or a window title. The setup window shows it only on the subscribe page and removes it from the clipboard again after a minute. Remember:

* **Anyone who knows your topic can read your notifications**, and could also post fake ones to your phone.
* If you use the public **ntfy.sh** service, its operators can technically see the messages that pass through it. For maximum privacy use your own server (`server` in `ntfy.json`, `https` required, optional `token`).
* If the topic leaks, use *Create a new topic…* in the setup window.

## Security measures in the build and installer

* **No secrets in the source or the release.** The release builder scans every staged file for protected strings (your topic, token, user name, host name and paths; read in memory, never printed) and for personal paths, and fails the build on a hit.
* **No development controls in production.** Options such as `--data-dir`, `--no-lock` or `--system-theme` exist only in `devhooks.js`; the release carries an inert stub, and the scanner fails the build if any control name appears. `verify-stage.js` starts the production build with every control at once and checks that none has an effect.
* **Pinned runtime.** The bundled Node.js version, Authenticode signature and SHA-256 are verified at build time.
* **No `PATH` dependence.** System programs are launched by full path; a gate rejects code that launches them by bare name.
* **Per-user installation.** No administrator rights, no services, no drivers, no scheduled tasks, one optional `HKCU\...\Run` value.
* **The uninstaller never deletes user data.**

## Limits and honest caveats

* **The installer is not code-signed** (v1.0.0). Windows may warn or block it. Always verify the SHA-256. Signing requires a code-signing certificate; the private key of such a certificate must never be stored in this repository, the application folder or the installer source (the `.gitignore` excludes common key and credential file types).
* The application's PowerShell scripts are started with `-ExecutionPolicy Bypass` for that process only (they are local files shipped in the package). Package integrity is protected by the manifest, not by script signatures.
* This is an **unofficial** tool that depends on files Claude Desktop writes. Those are not a supported interface; a Claude Desktop update could change what is visible.
* There has been **no independent security audit**.

## Reporting a security problem

*Before publishing the repository, add a private contact method here (for example GitHub's "Report a vulnerability" feature or an e-mail address chosen by the maintainer).* Please do not post secrets, your `ntfy.json` or logs in public issues.
