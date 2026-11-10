# Phone notification setup

Phone notifications use **[ntfy](https://ntfy.sh)**, a simple open-source push service. They are **optional** and stay **off** until you confirm a test message.

## How it works

* On first start, the app creates a **private topic** (a random name, for example `claude-xxxxxxxxxxxxxxxx`) **on your PC**. It is unique per installation and is never part of the installer.
* The ntfy app on your phone *subscribes* to that topic. The app on your PC then *posts* short messages to it through the ntfy server, which delivers them to your phone.
* The topic acts like a password: **anyone who knows it can read your notifications**. Do not share it.

Tested with the **Android** ntfy app. The ntfy project also provides an iOS app, but the setup window here only links to the Android stores and iOS has not been tested.

## Step by step (first run)

The window **Set up phone notifications** opens by itself on first run. Later, open it from the tray menu: *Set up phone notifications…*.

1. **Checklist page.** It shows plain-language checks (Claude Desktop running, sessions visible, usage numbers readable). They never block the setup. Press *Next: connect your phone* (or *Skip for now*).
2. **Install ntfy.** Install the free **ntfy** app from Google Play or F-Droid (the window has buttons that open both pages in your browser, and a QR code for Google Play).
3. **Subscribe to your topic.** In the ntfy app, subscribe to your topic by **scanning the QR code** shown in the window, or press **Copy** and paste it into the app. The window can hide the code (*Hide the code*).
   * *Copy* puts the topic on the clipboard and **removes it again after one minute**, but only if the clipboard still holds exactly that text (anything else you copied later is left alone). If the clipboard is busy, the removal is retried briefly; if it still fails, the window tells you to copy something else to replace it.
4. **Send a test.** Press *Send test notification*. A generic test message is sent (it contains no project or session name).
5. **Confirm.** When the message arrives on your phone, press *I got it*. Only then are phone notifications **turned on**. If it does not arrive, press *I didn't get it* for a checklist.

> An accepted request ("HTTP 200") from the server only means the server took the message. It is **not** proof that it reached your phone, which is why the app waits for your confirmation.

### If the test does not arrive

The window's help page lists these checks:

1. In the ntfy app, check that you tapped **Subscribe** for your topic.
2. If you typed the topic, check every letter. It is safer to use Copy and paste.
3. On Android 13 or newer, allow ntfy to show notifications (*Settings → Apps → ntfy → Notifications*).
4. Make sure the phone is online.
5. Phone notifications stay **off** until a test arrives and you confirm it.

## What phone messages contain

Messages are built from a fixed allow-list: the **project folder name**, the event type (*finished*, *needs input*, *needs permission*, *API error*, *session limit*, *process exited*, *usage warning/critical*), one short whitelisted detail (for example the **name** of the tool that needs permission, the time a session limit resets, an exit code, or a short scrubbed error line) and a clock time. Prompts, code, file contents, transcripts, tokens and credentials are never read or sent. The conversation-derived **session title** is **not** sent unless you opt in in `ntfy.json`. See [`privacy-and-security.md`](privacy-and-security.md).

## Managing phone notifications

* **Turn off / on:** tray menu → the phone entry, or the setup window's status page.
* **Create a new topic:** on the status page of the setup window (*Create a new topic…*). This turns phone notifications **off**, and the old subscription **stops working**; subscribe again with the new topic and confirm a new test. A confirmation dialog explains this.
* **Damaged configuration:** if `ntfy.json` is damaged, it is **never silently overwritten**. The window explains the problem and offers an explicit recovery (the *Start over* button) that keeps a backup of the damaged file.

## Configuration file (`ntfy.json`)

The file lives in `%USERPROFILE%\.claude-notifier\ntfy.json`. A template with placeholder values is in [`examples/ntfy.example.json`](examples/ntfy.example.json). Never post your real file.

| Key | Meaning |
|---|---|
| `server` | ntfy server URL. Default `https://ntfy.sh`. Must be `https` (plain `http` is only accepted for `localhost`, or if `allowInsecure` is `true`). |
| `topic` | Your private topic (letters, digits, `-`, `_`). Generated for you. |
| `token` | Optional bearer token for a protected or self-hosted server. Never logged. |
| `configVersion` | `2` means the privacy default below is in force. |
| `includeSessionTitle` | `false` by default. `true` (with `configVersion` 2) adds the conversation-derived session title next to the project name. |
| `allowInsecure` | Allow plain `http` to a non-loopback server (not recommended). |
| `priorities` | ntfy priority per event type (1 to 5). |
| `holdSeconds` | Seconds to wait before pushing; cancelled if the session resumes in the meantime. For example `WAITING_FOR_PERMISSION: 20` pings the phone only if you are away. |
| `types` | Switch individual event types on or off for the phone. |

## Using your own ntfy server

Set `server` to your server's `https://` URL and, if it is access-protected, add a `token`. Phone messages then travel only between your PC, your server and your phone.

## Command-line helpers

From the program folder (`%LOCALAPPDATA%\Programs\Claude Notifier`):

```powershell
.\ClaudeNotifier.exe notifier.js --ntfy-status     # shows the state; never prints the topic
.\ClaudeNotifier.exe notifier.js --ntfy-test       # sends a test message
.\ClaudeNotifier.exe notifier.js --ntfy-disable    # turns phone push off
```
