# Licensing: decision pending

**No license has been chosen for this project, and no `LICENSE` file is included.** This page explains the consequences of the available choices so that the maintainer can decide before (or after) publishing. It is general information, **not legal advice**.

## 1. Publishing without a license

If the source is public on GitHub and there is no `LICENSE` file, the default copyright rules apply:

* The author keeps **all rights**. Nobody else is granted permission to **copy, modify, redistribute or build on** the code, even though they can read it.
* GitHub's Terms of Service still allow others to **view and fork** public repositories on GitHub, but a fork or a copy elsewhere is not a licensed use.
* Contributors cannot safely send pull requests (unclear terms for their contributions), and companies will usually avoid the code entirely.
* It is a valid choice for a personal or commercial project whose source is only *visible*, not reusable.

## 2. Choosing an open-source license

An open-source license grants everyone defined permissions in exchange for conditions. Common choices:

| License | In short | Consequences |
|---|---|---|
| **MIT** | Very permissive. Anyone may use, modify, sell and relicense, if the copyright and license notice are kept. | Maximum reuse, no patent grant, no guarantee. Compatible with almost everything. Others (including companies) may build closed products from your code. |
| **Apache-2.0** | Permissive, like MIT, plus an **explicit patent grant** and a notice/changes requirement. | A little more text to carry (a `NOTICE` convention). A good default when patents matter. |
| **GPL-3.0** | **Copyleft.** Derivative works that are distributed must be released under the GPL with source. | Keeps derivatives open; many companies cannot use it in closed products. |
| **AGPL-3.0** | GPL plus the network-use clause. | Rarely relevant for a desktop tool. |
| **MPL-2.0** | File-level copyleft. | Middle ground: changes to *your files* stay open, but they can be combined with closed code. |

Things to consider:

* **Irrevocable in practice.** Anyone who received the code under a license keeps those rights even if you change the license later for new versions.
* **Dual licensing / commercial plans.** If you might sell this software or want a different commercial licence later, say so *before* accepting outside contributions (a contributor agreement or a copyleft choice affects that).
* **Trademarks are separate.** A license does not grant rights to names or logos. "Claude" and "Claude Code" belong to Anthropic; this project is unofficial and must not suggest endorsement.
* **Third-party code.** The release bundles the **Node.js** runtime (MIT licence; its text is in `src/tools/licenses/NODE-LICENSE.txt` and installed as `THIRD-PARTY-NOTICES.txt` and `LICENSES\NODE-LICENSE.txt`). The application itself has **no npm dependencies**. Using Inno Setup to build the installer does not place any Inno Setup code under your project's licence.
* **Code signing services may require an open-source license.** Some free or discounted signing offers are only for OSI-approved open-source projects (for example SignPath Foundation's free signing, and Certum's "Open Source Code Signing" certificate, which must not be used for commercially distributed software). If you plan to use one of these, the license decision comes first. Standard commercial code-signing certificates do not require open source.

## 3. What to do next

1. Decide: *all rights reserved (no license)* or an *open-source license*.
2. If open source: add the full, unmodified license text as `LICENSE` in the repository root, put your name and the year in the copyright line where the license asks for it, and update the "License" section of [`../README.md`](../README.md).
3. Make sure every contributor of code you merge agrees to the license.

Until you decide, the README states that no license has been chosen.
