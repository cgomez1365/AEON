# AEON — Backup and recovery

For anyone running AEON on their own computer. Until 2026-09-30 this file was an
internal operations runbook (recovery-time targets, a quarterly drill, decisions for
the project owner); that version is in the git history. It described a hosted
deployment, not the AEON you install.

## What to back up

Everything AEON keeps for you is in one folder, the **AEON home**: `~/AEON`
(`C:\Users\<you>\AEON` on Windows), or wherever `AEON_HOME` points. If you put the AEON
folder itself at `~/AEON`, the home is `~/AEON Data` instead. On a carried drive it is
the `AEON-Data` folder beside the app.

| In the home | What it is |
|---|---|
| `Vault/` | your documents and memories |
| `.env` | the vault master key and AEON's configuration |
| `secrets/` | the keyslots and the endpoint registry |
| `data/` | indexes, local models (re-downloadable), block state, crash log (`data/logs/uncaught.log`) |
| `db/` | chat and audit logs, retrieval indexes, run state |
| `aeon-settings.json` | everything set in Settings |

Two things live in the AEON folder instead, not in the home: **packs you installed**
(each a folder in `src/blocks/`) and **builds waiting for your approval** (`staging/`).
Back those up too, or keep the `.aeon` files you installed the packs from.

**How:** quit AEON (close its terminal window), then copy the whole home folder to
another disk. Copying while AEON is stopped means no file is caught half-written.

## The key has two halves

`.env` holds the vault master key and `secrets/aeon-keyslots.json` holds the keyslots.
Together they unlock your API keys; neither works alone. Back them up together and
restore them together. A copy of the home without its `.env` is a copy whose keys you
cannot open.

- **Settings → Keys → Export backup** downloads `.env`, the keyslots and the provider
  credentials file in one file (it asks for your password first, if you have an
  account). The banner appears once the vault holds a key.
- **Recovery code.** When the vault is first created, AEON prints a recovery code once,
  in its terminal window. Write it down. If `.env` is later lost or replaced, start AEON
  with its launcher (`LAUNCH.bat`, `launch.command` or `launch.sh`): when the key in
  `.env` is missing or does not open the vault, the launcher asks for the code. The code
  reopens the vault and writes a new key to `.env`; your stored keys come back. It opens
  the recovery slot inside `secrets/aeon-keyslots.json`, so it helps when `.env` is lost,
  not when the `secrets/` folder is. A carried drive's launchers start AEON directly and
  do not ask for it. The `.env` + keyslots backup above stays the first way back, and the
  only one if you did not keep the code.

If AEON starts and says the vault is **SEALED**, it found keyslots with no master key
— usually a `.env` that was not restored with them. AEON does not mint a new key over
an existing vault (that would lock it for good). Restore the matching `.env` from your
backup and start AEON again, or start it with its launcher and paste your recovery code
when it asks.

## Restoring

- **Same or new computer:** install AEON (see the README), but **before the first
  launch** copy your backed-up home back to `~/AEON` (or set `AEON_HOME` to it).
  Launching first creates a new, empty home with a new key; your copy then has to
  replace it by hand.
- **Packs:** copy their folders back into `src/blocks/`, then run `npm run build` (or
  let the launcher build a fresh folder on its first launch).
- **One AEON per home.** A second AEON started on the same home refuses to run, so a
  restored copy cannot be written by two servers at once.

## If AEON stops

The launcher keeps AEON running only across **Settings → RESTART**. Any other exit ends
it: start it again from the Desktop icon or the launcher. A fault inside one request is
logged and survived; a fault that leaves the process unsound (for example out of memory,
or a missing module) stops it. Both are written to `data/logs/uncaught.log` in the home, which is
capped so a repeating fault cannot fill the disk.

## If you connected your own Supabase

AEON runs with no cloud. If you connected a Supabase project of your own, its backups
are that project's: AEON keeps no other copy of what it stores there. Supabase's
point-in-time recovery is a feature of their paid plans. Two checks ship with AEON:

- `npm run migrate -- --status` — which migrations are applied.
- `npm run canary` — reports each table LOCKED or EXPOSED. If any table is EXPOSED,
  re-apply `db/migrations/001_enable_rls.sql`, then find out what removed the policy.

Earlier revisions of this page described a daily Google Apps Script backup on a Vercel
cron; neither the cron nor the route ever existed in this repository.

## If a provider key leaks

Revoke it at the provider first, then remove it in **Settings → Keys** and add the new
one. Removing a connection removes its keys from the vault.
