# Host OS

The block that touches the computer AEON runs on: its files (for the Files
block and the `/read` / `/writefile` terminal commands), a short table of named
OS actions, the audit trail of what the machine was asked to do, and the
**Host OS screen** (`/host`) — this machine's health and a truthful Restart.

Local-only (`contract.targets.vercel: false`). Every `/api/fs/*` route refuses
with 403 on Vercel.

## The screen (`index.jsx`, route `/host`)

- **This computer** — name, OS, processor, load average (not on Windows),
  memory (with the macOS note: unused memory is kept as cache and counted as
  used, so "free" reads low and that is normal), free disk on the drive holding
  the Vault, machine uptime.
- **AEON** — pid, Node version, how long it has run, memory, and the File
  Manager's lock state.
- **Restart AEON** — enabled only when the server says a restart can work (see
  below); otherwise disabled with the reason and what to do instead. After a
  restart it waits for a *new* process to answer before saying AEON is back.
- **What this machine was asked to do** — the last entries of the OS audit log.

Refreshes every 15 s. Until 2026-09-23 there was no screen: the kernel's NAV map
listed `/host`, but the build-time registry only finds blocks with an
`index.jsx`.

## Restart — only when something brings AEON back

`POST /api/system/restart` exits the process only after proving a relauncher:
`scripts/restart.bat` on Windows (if the file exists — it currently does not
ship), or a supervisor that restarts AEON on exit (`AEON_SUPERVISED`, pm2's
`PM2_HOME`, `NODEMON` — the same signals Settings' restart reads). Otherwise it
answers **501** `{ ok:false, restarting:false, error, remedy }` and stays up.
`GET /api/system/health` carries the same answer in `restart`, so a screen can
offer or explain the button without trying it.

Launched from `LAUNCH.bat`, `launch.command`, `launch.sh` or `npm start`, AEON has
no supervisor (`launch.js` exits when its server exits), so on a normal install
**Restart is unavailable and says so**: stop AEON and start it again with the
launcher. Until 2026-09-23 this route answered success, ran `cmd.exe` (on every
platform) against a script that does not exist, and exited — leaving no AEON.

The header's RESTART buttons (`src/components/DesktopLayout.jsx`) still call
this route without reading the answer and reload the page when `/api/health`
responds; with the 501 the server stays up, so the page simply reloads. They
should read the answer and show `error`/`remedy` (kernel-side change, reported).

## Files on this computer (`api/fs.cjs`)

| Route | Method | What |
|---|---|---|
| `/api/fs/list` | POST | List a folder (`{dirPath}`); no path = the Vault. Answers `path`, the absolute folder listed. |
| `/api/fs/read` | POST | A document's text (PDF/HTML/text via the kernel extractor), summarized when a chat model is assigned. |
| `/api/fs/write` | POST | Write a file. Overwriting an existing file needs the hub unlocked (423). |
| `/api/fs/mkdir` | POST | Create a folder (allowed while locked — adding is not editing). |
| `/api/fs/rename` | POST | Rename or move (`{from, to}`); needs unlocked; never overwrites. |
| `/api/fs/delete` | POST | Delete a file or folder; needs unlocked. |
| `/api/fs/upload` | POST | Multipart, up to 20 files × 50 MB, into `targetDir` (no folder = the Vault). Replacing an existing file needs unlocked (423). |
| `/api/fs/serve` | GET | Stream a file (`?path=`, `&download=1`); only known-safe types render inline. |
| `/api/fs/lock` | GET/POST | The add-only lock (default locked, persisted under the block's data folder). |

**One boundary for all of them** (`safePath`): the path must resolve inside the
operator's home, the workspace, or the Vault, and no segment may be a credential
or shell-config location — `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, shell
profiles and histories, `Library/Keychains`, `Library/LaunchAgents`,
`Library/LaunchDaemons`, the Windows Start Menu, AEON's own `secrets`, `.env`
and `.git`. The roots themselves can be listed but not written or removed.
Uploads go through the same check for the folder **and** each file name (until
2026-09-23 they used a shared uploader that checked only the roots, so an upload
could land in `~/.ssh` or replace a file in add-only mode).

## Named OS actions and the Operator Console (`api/os.cjs`)

There is no raw shell. `POST /api/os/action` runs one of a fixed table of
actions (`getStatus` → `uname -a` / `ver`; `runTest` → `npm test`) with a fixed
executable and an argument array. `POST /api/os/open` opens a path under the
allowed roots with a fixed launcher. Both need a shell-tier session
(`requireShellAuth`). **Safe mode** (`POST /api/host_os/safe-mode`, in memory,
cleared by a restart) refuses every `/api/os/action` while on — it does not
cover `/api/os/open`. `GET /api/os/actions`, `/api/host_os/widget` (the
Operator Console widget in Settings) and `/api/host_os/audit` are reads behind
`requireOperator`.

## System (`api/system.cjs`)

| Route | Method | What |
|---|---|---|
| `/api/health` | GET | Liveness ping `{status, environment, time, uptime}` — what the header polls. Meant to be pre-auth; see "Known" below. |
| `/api/system/health` | GET | The Host screen's data: machine, disk, AEON process, restart capability. |
| `/api/system/restart` | POST | See Restart above. Shell-tier session. |
| `/api/system/scan` | POST | Pulls Supabase notes/terminal history to disk (if Supabase is set) and, with "Auto-sync to cloud" on, pushes blocks back. No indexing (the Vault indexes on boot and from Matrix ▸ Index). |
| `/api/force-sync` | POST | Pushes recent chat and audit logs to Supabase; `{success:false, reason:'ignored'}` without it. |
| `/api/desktop-tasks` | GET/POST | An in-memory queue (POST needs a shell-tier session). |
| `/api/sdi/*`, `/api/gas/status` | | SDI schema validation and a GAS polling stub. |

## Known, not fixed here (kernel)

- `/api/health` answers 401 once an account exists: the pre-auth check compares
  `req.path` (`/health` under the `/api` mount) with `/api/health`, and the
  generated manifest marks it `auth: true` because `PRE_AUTH_ROUTES` does not
  list it. The header's restart poll and any uptime monitor are refused.
- `server/server.js` passes `runReaper` (services/system.js) into this block; no
  route calls it.
