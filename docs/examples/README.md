# Configuration templates

These two files are **templates with placeholder values**. They are the only `*.json` configuration files that may be committed to this repository (see the exceptions in `.gitignore`).

| Template | Real file (created by the app) | Notes |
|---|---|---|
| [`settings.example.json`](settings.example.json) | `%USERPROFILE%\.claude-notifier\settings.json` | `appearance` is `system`, `light` or `dark`. `phoneEnabled` is switched on by the app only after you confirm a test message. `phoneSetup.state` is managed by the setup window. |
| [`ntfy.example.json`](ntfy.example.json) | `%USERPROFILE%\.claude-notifier\ntfy.json` | `topic` is **generated on your PC** at first run; the value here is only a placeholder, deliberately written with characters that the app rejects, so it can **never** work as a topic by accident. Field meanings: [`../phone-setup.md`](../phone-setup.md). |

**Do not copy your real files into this repository, an issue or a forum post.** `ntfy.json` contains your private topic and possibly an access token.

You normally never edit these files by hand; the tray menu and the setup window manage them. JSON does not allow comments, so the explanations live in the documentation.
