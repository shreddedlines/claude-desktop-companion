# Release information

This folder holds **information about the releases**, not the installer binary.

| File | Purpose |
|---|---|
| [`RELEASE-INFO.txt`](RELEASE-INFO.txt) | Installer size, SHA-256, build facts, signature status for **v1.0.0**. |
| [`SHA256SUMS.txt`](SHA256SUMS.txt) | The installer's checksum in the standard `hash *file` format. |

## The installer belongs in a GitHub Release, not in the repository

`ClaudeNotifierSetup.exe` is about **23.5 MB**. GitHub blocks files over 100 MiB in a repository and warns above 50 MiB (check GitHub's current documentation), so this installer *would* technically fit, but it should still **not** be committed:

* every version stays in the Git history **forever** and every clone downloads all of them;
* a binary in the source tree cannot be tied to the commit that produced it as clearly as a Release asset can;
* GitHub **Releases** allow assets up to 2 GiB each, are attached to a tag, and are what users expect to download.

So: the repository contains the source and the checksum; the `.exe` is attached to the **v1.0.0 GitHub Release** (the `.gitignore` excludes `release/*.exe`).

## Publishing v1.0.0 (manual steps for the maintainer)

1. Decide the licence ([`../docs/licensing.md`](../docs/licensing.md)), add a private security contact to [`../docs/privacy-and-security.md`](../docs/privacy-and-security.md#reporting-a-security-problem), and add (or knowingly leave out) screenshots ([`../docs/images/README.md`](../docs/images/README.md)).
2. Push the repository, then create a **tag** `v1.0.0` and a **Release**.
3. Attach these files **unchanged** as Release assets: `ClaudeNotifierSetup.exe` and `SHA256SUMS.txt`.
4. Use [`../RELEASE-NOTES.md`](../RELEASE-NOTES.md) as the Release description. Keep the **unsigned installer** warning at the top.
5. After uploading, download the asset once and check its hash against `SHA256SUMS.txt`:
   ```powershell
   Get-FileHash .\ClaudeNotifierSetup.exe -Algorithm SHA256
   ```

The installer must be the verified v1.0.0 build (SHA-256 in `SHA256SUMS.txt`). **If you ever rebuild it, the hash changes**: update `SHA256SUMS.txt` and `RELEASE-INFO.txt` and re-run the installer tests.
