# AEON 3.1.0 — release notes
**Released:** 2026-10-01. Free core: the AEON app itself. The
block store is a pilot and **nothing in it is for sale.**

## What AEON is

A local-first AI workspace that runs on your own computer. Your documents, notes and
API keys are kept on it, in one folder (`~/AEON`); nothing syncs to a cloud unless you
connect your own. A cloud model you add a key for is sent what it needs to answer you —
and, with no local embedding model installed, your Vault's text to index it; Settings →
Models → **Local only** keeps all of that on your machine. The
[Privacy notice](PRIVACY.md) lists everything AEON sends. You talk to it in a terminal,
it indexes your files and answers from them with sources, and it runs AI either through
cloud providers you add a key for (Gemini and Groq offer free keys) or through local
models it downloads for you. Everything is built from
blocks — Terminal, Aeon Matrix, Cookbook, Writer, Council, Deep Research and more — and
you can write your own.

## Who it is for

People who want an AI workspace that keeps their files and keys on their own machine,
and who are comfortable installing Node.js and double-clicking a launcher. Developers
who want to build blocks. It is not a hosted service: there is no account with us, and
AEON listens only on this computer (`127.0.0.1`) unless you set `AEON_BIND` or turn on
Remote Access.

## What is new since 3.0.0

The full list, with commits, is in [CHANGELOG.md](CHANGELOG.md). In short:

- **Security fixes.** An auth-guard bypass by letter case (`/API/...`), `/blocks/*` and
  `/ws` reachable without a session, `.env` (the vault master key) not written
  owner-only, a tunnel that could start with no login protecting it, and a "Require login"
  switch that switched nothing. AEON now answers only to its own names and its own page:
  a rebinding site or a page on another localhost port is refused. **Do not keep running
  3.0.0.**
- **Opening AEON contacts nothing but AEON** (fonts and icons ship with it), and a
  **Local only** switch keeps every model call, Vault indexing included, on this computer
  or your own network.
- **Your data moved out of the install folder** into `~/AEON`, so replacing AEON no
  longer replaces your data.
- **Data-safety fixes.** A file AEON cannot read is no longer treated as empty and
  written over — vault, memories, indexes, Writer, settings.
- **Settings decides each role's model**, a connection can hold several keys with
  failover between them, and fallback uses every provider you added.
- **Failover reads the failure:** a paid OpenRouter model out of credits hands the turn to a free OpenRouter model, a request too large for a model is retried once with less context, and each notice appears above the answer it explains.
- **Blocks can be stopped, removed and restored** while AEON runs.
- **Store install (pilot):** install and update packs from a store by id, checked
  against the store's SHA-256.
- **Carry AEON on a drive** (macOS launcher run; Windows and Linux not yet).
- **First run:** the launcher finds a free port (3001–3020), a second launch opens the
  AEON already running, an interrupted install is redone, and the vault recovery code
  works (`node launch.js --recover-vault`).
- **Licence, terms and a privacy notice** that promise only what exists; Cookbook shows
  each model's licence before you install it.

## Requirements

Full table in the [README](README.md#requirements). The short version:

- **Node.js 22.13 or newer.**
- **macOS 13.5 or newer** with the current Node LTS; **macOS 11 to 13.4** with Node 22
  LTS. Local models need macOS 13.3 or newer.
- **Windows 10 or 11, 64-bit.** Windows on ARM is not supported.
- **Linux x64** (other architectures untested).
- **About 1 GB of disk** for AEON and its dependencies, plus 0.15–4.9 GB per local model.
- **Internet** to install, and for cloud AI and downloads.

## Installing

1. Install Node.js from [nodejs.org](https://nodejs.org) (on macOS 11 to 13.4, Node 22).
2. Download this release's source ZIP and unzip it anywhere.
3. Double-click `LAUNCH.bat` (Windows) or `launch.command` (macOS), or run `./launch.sh`
   (Linux). The first launch installs dependencies and builds the interface, which takes
   a few minutes.

**On macOS** the launcher is not signed by Apple, so the first double-click is blocked.
On macOS 15 and newer: dismiss the warning, then **System Settings → Privacy & Security →
Open Anyway**. On macOS 14 and older: Control-click `launch.command` → **Open**. Or run
`xattr -dr com.apple.quarantine` on the unzipped folder. `chmod +x` does not help.

This release is source code: there are no signed installers.

## Upgrading from 3.0.0 safely

3.0.0 kept your Vault, keys and settings **inside its own folder**. 3.1.0 moves them into
`~/AEON` the first time it starts — but only out of **its own** folder.

- **If you installed with `git clone`:** quit AEON, then in the AEON folder run
  `git pull`, `npm ci` and `npm run build`, and launch. The launcher moves your data into
  `~/AEON` and lists what it moved.
- **If you installed from a ZIP:**
  1. Quit AEON and rename the old folder, for example to `AEON-old`.
  2. Unzip 3.1.0 next to it. **Do not launch it yet.**
  3. Copy each of these that exists from `AEON-old` into the same place in the new folder:
     `.env`, `secrets`, `data`, `db`, `src/aeon-settings.json`,
     `src/blocks/aeon_matrix/data` (your Vault), and any block folder in
     `AEON-old/src/blocks/` that the new `src/blocks/` does not have (packs you
     installed). `.env` is hidden in Finder; press Cmd+Shift+. to show it.
  4. Launch. The launcher moves your data into `~/AEON` and lists what it moved.
  5. Check your Vault and your keys (Settings → Keys) before deleting `AEON-old`.

**If you launch 3.1.0 from a fresh folder first,** it creates a new, empty `~/AEON` with
a new vault key, and moving your 3.0.0 data in afterwards is refused rather than merged.
If that happened: quit AEON, move the new `~/AEON` aside, copy your 3.0.0 data in as in
step 3, and launch again.

Going back from 3.1.0 to 3.0.0 is not supported: 3.0.0 does not read `~/AEON`.

## Updating after 3.1.0

See *Updating AEON* in the [README](README.md#updating-aeon). Two things to know: packs
you installed live in the AEON folder (`src/blocks/`), not in `~/AEON`, so carry them
across when you replace the folder; and after a `git pull` run `npm ci` and
`npm run build` yourself — the launcher installs dependencies only when they are missing
or an install did not finish, and builds the interface only when no build exists, so a
pull's new dependencies and interface are not picked up.

## Known limits

- **The store is a pilot. Nothing is for sale**, and prices, checkout and licensing are
  not decided yet. AEON installs from a store only when you point `AEON_STORE` at one.
- **macOS:** the launcher is unsigned (Gatekeeper steps above). The browser-ZIP path has
  not yet been run end to end on a real Mac; the `git clone` path has.
- **Windows:** the 3.1.0 launcher has not been run on real Windows hardware (the last
  recorded real run, 2026-09-06, used an earlier launcher). CI runs Windows on every
  push. Windows on ARM is not supported.
- **Linux:** not verified on real hardware — run under WSL2 (2026-08-08) and in CI only.
- **Carried drive:** its Windows and Linux launchers have never run on real hardware.
- **No automatic updates** and no in-app notice of a new version.
- **Installed packs live in the install folder**, so replacing the folder without
  copying them removes them.
- **Vault recovery code:** AEON prints one when the vault is created. On any layout, a
  carried drive included, `node launch.js --recover-vault` in the AEON app folder asks
  for it; the desktop `LAUNCH.bat`, `launch.command` and `launch.sh` also ask on their
  own when the key in `.env` is missing or does not open the vault. It reopens the vault
  only while `secrets/aeon-keyslots.json` is still there. Back up `~/AEON` (or at least
  `.env` together with `secrets/`): see [Backup and recovery](docs/DISASTER_RECOVERY.md).
- **Blocks share one Node process.** A block's manifest governs what the kernel gives it;
  it is not a sandbox against hostile code. Install blocks you trust.
- **Before you create a login, the global guard is off by design.** Create one if anyone
  else can use this computer. Remote Access refuses to start until one exists.
- **Several keys per provider** are for failover across accounts or projects you are
  entitled to use, not a way around a provider's limits. Check each provider's terms.
- **Local only is off by default.** With it off and a cloud key added, a local model that
  cannot answer hands the prompt to that cloud provider (the chat says so in one line),
  and with no local embedding model installed, adding a cloud key can send your Vault's
  text to that provider for indexing. Turn it on in Settings → Models.
- **Text in images and scanned PDFs is not read out of the box.** OCR needs English
  language data on disk; AEON downloads it only with `AEON_OCR_DOWNLOAD=1` in `.env`, and
  otherwise reports the file as not read, with that remedy.
- **Dependency advisories still open.** `npm audit` on 2026-09-30 reports six, to be
  measured again at tagging:
  - **vite 5 and its esbuild:** one high, three moderate. All are in the Vite
    *development server*, which the installed app does not run: it serves the built
    interface through Express. Fixing them needs a major Vite upgrade.
  - **@grpc/grpc-js:** one high, one low. It arrives through `firebase`. AEON uses
    firebase only in the browser interface, whose build does not include grpc-js, and
    no server code loads firebase. `npm audit` offers no fix yet.

  Reasons and review dates: [docs/DEPENDENCY_DECISIONS.md](docs/DEPENDENCY_DECISIONS.md).

## Reporting problems

Bugs: [GitHub issues](https://github.com/cgomez1365/AEON/issues). Security problems:
report privately, as the [security policy](.github/SECURITY.md) describes — not in a
public issue.

## License

[AEON Community License](LICENSE) — free to use and modify; no resale or redistribution.
See [Terms of Use](TERMS_OF_USE.md).
