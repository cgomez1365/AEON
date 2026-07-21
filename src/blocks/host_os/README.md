# Host OS

Kernel-level access to the host machine: shell execution, the local
filesystem, and OS/process metrics. This is AEON's "hands" — the block that
lets the Neural Terminal, the VP agent, and other blocks actually *do* things
on the machine AEON is running on, instead of only reading/writing app state.

Backend-only block: there is no `index.jsx`, no widget, and no dashboard tile.
Everything here is consumed via `/api/*` — by Terminal 2.0 (the `>` shell
verb and the command palette), by other blocks (`aeon_matrix`'s scan/sync
step, the `files` block's file browser), and by the VP/agent tooling that
calls routes dynamically off the live API catalog rather than through a
hardcoded frontend `fetch()`.

## Why local-only

`contract.targets.vercel` is `false` and every route in `api/os.cjs` and
`api/fs.cjs` starts with `if (isVercel) return res.status(403)...`. This is
intentional, not an oversight: `child_process.exec`/`spawn` and raw
filesystem access have no meaning in a stateless serverless function — there
is no "host" to reach. On Vercel these endpoints exist (so callers get a
clean 403 instead of a 500/timeout) but always refuse. `api/system.cjs`
is the exception — its Supabase-sync and `/health` routes are harmless in
the cloud and stay live there.

## Security posture

This block intentionally declares `contract.permissions.shell: true` and
`filesystem: "write"` — the strongest permission pair a block can hold in
AEON. That's correct for what it does, not an oversight to "fix down." The
gating that makes it safe to hold that power lives in several layers:

1. **Global operator gate** (`src/kernel/authGate.cjs`, mounted in
   `server/server.js` ahead of the block router) — dormant on local dev
   unless `AEON_OPERATOR_PASSWORD` is set, always-on in cloud/tunnel
   deployments. Applies to every `/api`, `/block`, `/core`, `/events`
   request except an explicit allowlist (`/api/auth/*`, `/api/health`).
2. **Shell-tier gate** (`requireShellAuth` in `security/security.js`) —
   fails **closed**: if `AEON_MOBILE_SECRET` isn't configured, every route
   guarded by it (`/os/execute`, `/exec`, `/os/open`, `/os-bridge`,
   `/desktop-tasks` POST, `/system/restart`, `/system/scan`) returns 503
   rather than silently allowing localhost. When the secret *is* set,
   localhost is trusted and remote/tunnel callers need a matching
   `Authorization: Bearer <AEON_MOBILE_SECRET>` header.
3. **Allowlisted exec** (`POST /api/exec`) — the one exec route meant for
   lower-trust callers. Commands must start with one of
   `SAFE_EXEC_PREFIXES` (python/node/npm/git-readonly/ffmpeg/etc, see
   `security/security.js`) and are rejected outright if they contain
   `& | ; < >` (no chaining/redirection). `/os/execute` and
   `/os/agent-shell` are the higher-trust, no-allowlist siblings for the
   operator and the VP agent respectively.
4. **Path allowlist** (`POST /api/os/open`) — the resolved launch path must
   start with one of `ALLOWED_ROOTS` (user home, workspace, Desktop,
   `C:\Program Files`) or the request is blocked.
5. **Tamper-evident audit trail** (`writeOSAudit`, also in
   `security/security.js`) — every shell/exec/open call (including blocked
   attempts) is appended to a rolling 100-entry `AUDIT_FILE` and, when
   Supabase is configured, mirrored to the `aeon_audit_log` table. Query it
   via `GET /api/sdi/violations` for SDI-specific entries or read
   `AUDIT_FILE` directly for the full shell audit log.
6. **`/os/shell`** (the Terminal 2.0 `>` verb) is the one shell route that
   trusts bare localhost without a secret — it's the operator's own
   terminal, run on their own machine. Anything not from `127.0.0.1`/`::1`
   still needs the `AEON_MOBILE_SECRET` bearer token.

`contract.permissions.ai` is `false` — despite the powerful shell/filesystem
grant, this block makes no LLM calls itself (no `geminiRequest`/
`groqRequest`/`ollamaRequest`/`kernelLLM` usage anywhere in `api/`).

## API routes

Every file under `api/` is mounted twice by the block host
(`src/kernel/blockHost.cjs`): once at `/block/host_os/<path>` and once at
bare `/api/<path>` (the form used everywhere else in the app and below).

### `api/os.cjs` — shell execution & process launch

| Route | Method | Gate | Notes |
|---|---|---|---|
| `/api/os/agent-shell` | POST | `AEON_MOBILE_SECRET` bearer (own check, not `requireShellAuth`) | Trusted, no-allowlist shell for the VP/agent tier. `cwd` shortcuts: `aeon` (repo root), `vault` (`WORKSPACE`), `workshop`. |
| `/api/os/shell` | POST | localhost trusted; remote needs bearer | Terminal 2.0's `>` verb. Runs via PowerShell on Windows. |
| `/api/os/execute` | POST | `requireShellAuth` | Raw exec, no allowlist, for the operator. |
| `/api/exec` | POST | `requireShellAuth` | Allowlisted exec (`SAFE_EXEC_PREFIXES`), rejects shell metacharacters. |
| `/api/os/open` | POST | `requireShellAuth` | Launches a file/app (`vscode`/`notepad`/`explorer`/`chrome`/default `start`) if the path is under `ALLOWED_ROOTS`. |
| `/api/os-bridge` | POST | `requireShellAuth` | Legacy smart command router from Terminal 1.0. Not called by the current frontend (Terminal 2.0 uses `/api/exec` + `/api/commands/dispatch` instead) — kept for any external caller, matches patterns in `INSTANT_PATTERNS`. Its old `research:` keyword branch shelled out to a Python script (`tools/research_agent.py`) that no longer exists in this repo; it now returns a redirect message pointing at the `deep_research` block (`POST /api/research/start`) instead of failing. |

### `api/system.cjs` — SDI, health, restart, scan/sync

| Route | Method | Gate | Notes |
|---|---|---|---|
| `/api/sdi/violations` | GET | none | Reads `SDI_VIOLATION_LOG`. |
| `/api/sdi/validate` | POST | none | Validates a payload against a named SDI schema. |
| `/api/sdi/schemas` | GET | none | Lists registered SDI schemas. |
| `/api/gas/status` | GET | none | Stub (`{configured:false}`) so frontend GAS polling doesn't 404. |
| `/api/health` | GET | none (in the auth allowlist too) | `{status, environment, time, uptime}`. |
| `/api/desktop-tasks` | GET | none | Drains the in-memory desktop task queue. |
| `/api/desktop-tasks` | POST | `requireShellAuth` | Enqueues a command for the queue. |
| `/api/force-sync` | POST | none (no-ops without Supabase/local) | Pushes recent chat + audit logs to Supabase. |
| `/api/system/restart` | POST | `requireShellAuth` | Spawns `scripts/restart.bat` and exits the process 500ms later. |
| `/api/system/scan` | POST | `requireShellAuth` | Pulls Supabase notes/terminal-history down to local files, then (local only) triggers a same-process bulk-push of all blocks to Supabase via `POST /api/sync/bulk-push` (owned by `aeon_matrix`). Second Brain/matrix indexing is **not** done here — see note below. |

Second Brain indexing note: `/system/scan` used to shell out to a
`tools/index-brain.js` script directly. That script was archived when Second
Brain ingestion moved into the `aeon_matrix` block
(`POST /api/crn/second-brain/ingest/scan-docs`, SSE). `server/server.js` now
runs an incremental Second Brain sync automatically on every boot, so a
manual full reindex is rarely needed; trigger one via the Neural Terminal's
`/index-brain` command (owned by `aeon_matrix`) if a hard rescan is ever
required. `/system/scan` logs an informational line instead of attempting
the old (broken) subprocess call.

### `api/fs.cjs` — filesystem access

| Route | Method | Gate | Notes |
|---|---|---|---|
| `/api/fs/list` | POST | none beyond `isVercel` | Lists a directory (`{dirPath}`, defaults to `WORKSPACE`). |
| `/api/fs/read` | POST | none beyond `isVercel` | Reads a file as UTF-8 text. |
| `/api/fs/write` | POST | none beyond `isVercel` | Writes a file, creating parent dirs as needed. |
| `/api/fs/mkdir` | POST | none beyond `isVercel` | Recursive mkdir. |
| `/api/fs/delete` | POST | none beyond `isVercel` | Deletes a file or recursively deletes a directory. |
| `/api/fs/upload` | POST | none beyond `isVercel` | Multer upload (up to 20 files). If any land under `WORKSPACE/Data/Second_Brain`, kicks off `tools/incremental-index.mjs` in the background to keep the Second Brain index current. |
| `/api/fs/serve` | GET | none | Streams a file back with a guessed `Content-Type` (`?path=`). |

`fs.cjs` routes rely on the global operator auth gate (`authGate.cjs`) plus
the block permission sandbox (`filesystem: "write"`) rather than
`requireShellAuth` — they're filesystem operations, not shell execution.
Callers can read/write/delete anywhere the process's OS user can reach; there
is no `ALLOWED_ROOTS` check on these routes today (unlike `/api/os/open`).
Worth knowing if you're reasoning about blast radius: this is direct,
unscoped host filesystem access gated only by the operator/tunnel auth
layer above it.

## Terminal commands (`contract.commands`)

| Command | Route | Notes |
|---|---|---|
| `/scan` | `POST /api/system/scan` | Implemented in this block (`system.cjs`). |
| `/autopilot-status` | `GET /api/autopilot/status` | Implemented in `tools/autopilot-daemon.cjs`, mounted directly by `server/server.js` (`setupAutopilot(app)`) — **not** a file under this block's own `api/` folder. Declared here because command ownership/naming was migrated into manifests block-by-block; the runtime route itself lives outside `src/blocks/host_os/`. |
| `/autopilot-start` | `POST /api/autopilot/start` | Same as above. Marked `dangerous: true`. |
| `/autopilot-stop` | `POST /api/autopilot/stop` | Same as above. |
| `/upload` | `POST /api/autopilot/upload-now` | Same as above. |

## Deployment targets

`contract.targets`: `local: true`, `vercel: false`, `docker: true`,
`cloudflare: true`. Local-only for the reasons above; Docker/Cloudflare
targets assume a persistent container with real shell/filesystem access
(unlike Vercel's serverless functions), so they're left enabled.
