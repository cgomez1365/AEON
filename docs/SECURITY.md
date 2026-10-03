# AEON — Security Guide

Operational security model and procedures. For the incident history see the
[lessons paid for](ENGINEERING_STANDARD.md#4-lessons-paid-for) in the engineering standard.

## Model in one paragraph

The browser never touches sensitive Supabase tables directly. RLS denies the anon
key (default deny-all). All privileged DB access goes through the server, which holds
`service_role` (bypasses RLS) in server-only env. There is no shell endpoint: the
one OS execution route, `POST /api/os/action`, runs named actions with fixed
executables and argument arrays, and requires an operator session from every
origin, loopback included — or `AEON_MOBILE_SECRET` (bearer) for headless and
tunnel callers. It fails **closed** when neither is present. `/api` traffic that
reaches AEON's port from another machine (possible only when you set `AEON_BIND`)
also requires the mobile secret. Traffic a program on this machine relays, such as
the Remote Access tunnel, arrives from this machine and does not (see below).
Secrets at rest are AES-256-GCM encrypted
in the vault, keyed by `AEON_VAULT_MASTER_KEY` which lives only in env.

## Controls in place

| Control | Where | Notes |
|---------|-------|-------|
| RLS deny-all on sensitive tables | `db/migrations/001_enable_rls.sql` | anon gets nothing |
| Server boundary (service_role) | `server/server.js`, `src/kernel/vault.cjs` | key server-only |
| Host check (DNS rebinding) | `server/earlyware.cjs`, `src/kernel/ws.cjs` | every request and every `/ws` upgrade; a name AEON does not answer to is refused with 421 (see below) |
| Origin check + CORS | `server/earlyware.cjs`, `src/kernel/ws.cjs` | a browser page from anywhere but AEON's own origin, the Vite dev server (`http://localhost:3000`) or `AEON_ALLOWED_ORIGINS` is refused with 403; CORS headers (with credentials) only for an origin that passed |
| Bearer auth on `/api` from off-machine | `security/security.js` | applies only when `AEON_BIND` exposes the port; "local" is decided by socket address, and the `Host:` header is only ever used to refuse, never to trust |
| Session required on privileged OS endpoints | `requireShellAuth` | operator session from every origin, loopback included; `AEON_MOBILE_SECRET` for headless callers; fail-closed when neither is present |
| No shell execution surface | `src/blocks/host_os/api/os.cjs` | named actions with argument arrays; no client string ever reaches a shell |
| Session gate on the Operator Console | `requireOperator` | independent of global guard state; pre-account access is loopback-only so a fresh install can reach setup |
| Security headers (helmet) | `server/server.js` | HSTS, X-Frame-Options, etc. |
| Rate limiting | `server/server.js` | 120/min/IP default, tunable; requests from this machine are not limited, and that includes Remote Access traffic |
| File Manager deny-list | `src/blocks/host_os/api/fs.cjs` | `.ssh`, `.env`, `secrets`, `Library/LaunchAgents` and the rest are refused in any spelling the disk would open (case, `ß`/`ſ` folding, a Windows trailing dot), and checked again against the path the filesystem resolves |
| Encrypted vault | `src/kernel/vault.cjs` | AES-256-GCM, atomic writes, mode 0600 |
| Crash guards | `server/server.js`, `src/kernel/processGuards.cjs` | a fault inside one request is logged and survived; one that leaves the process unsound (out of memory, a missing module) is logged and stops AEON. Nothing restarts it except **Settings → RESTART**; start it again from the Desktop icon or the launcher. The crash log is capped |
| Log redaction | `src/kernel/logger.cjs` | secrets censored in logs |
| Anon canary | `tools/rls-canary.cjs` | alerts if a table goes public |
| Dependency audit | `.github/workflows/ci.yml` (`npm run scan:audit`) | every push to `main`, every `v*` release tag, every pull request to `main`, a weekly scheduled run (Mondays), and a run started by hand; Dependabot opens version-update pull requests (npm weekly, GitHub Actions monthly), and each runs the same gate |

## Which requests AEON answers

**Host.** AEON answers to `localhost`, `*.localhost`, `127.x.x.x`, `[::1]` or an IP
address, on the port it is listening on; to the name of the Remote Access tunnel while
it runs; and to the hostnames in `AEON_ALLOWED_ORIGINS`. Anything else is refused with
421 before any route runs. This is what stops DNS rebinding (a site re-pointing its own
name at 127.0.0.1 to read AEON as if it were that site). To reach AEON under another
name, a LAN name or a reverse proxy, list that origin in `AEON_ALLOWED_ORIGINS`.

**Origin.** A request with no `Origin` header (curl, the `aeon` CLI, a same-origin
`GET`) is not a cross-site request and goes on. A browser page is answered only when it
is AEON's own page, the Vite dev server (`http://localhost:3000` or
`http://127.0.0.1:3000`, used by `npm start`), or listed in `AEON_ALLOWED_ORIGINS`. A
page another program serves on another localhost port is refused with 403. So is the
page `npm run preview` serves (`vite preview`, port 4173 by default) until its origin
is listed in `AEON_ALLOWED_ORIGINS`.

What this does not cover:

- **Port 3000 is trusted as the Vite dev server whether or not it is one.** A different
  program serving pages on `localhost:3000` gets the same access as AEON's dev UI.
- **Programs running on this computer are not browsers.** They send whatever `Host` and
  `Origin` they like, and before an account exists they can use every route (they can
  also read `~/AEON` from disk directly).
- **A proxy on this machine that adds no forwarding headers is this machine.** The
  Vite dev server's proxy (`npm start`, `vite.config.js`) is one: it forwards to AEON
  from 127.0.0.1 under AEON's own Host, so AEON cannot tell who is on the far side.
  The dev server therefore listens on 127.0.0.1 only. Start it with `--host` (or change
  `server.host`) and every device that can reach it gets this machine's access through
  it; before an account exists, that includes the credential export.
  The launcher (`node launch.js`), the desktop icon and the drive's launchers do not
  start the dev server.

## Before you create an account

The login guard turns on when an account is created (Security → Set up). AEON does
not make you create one: until you do, the app opens without a login, and:

- every route answers requests from this machine, within the Host and Origin rules
  above;
- requests that reach AEON's port from another machine (only possible with
  `AEON_BIND`) are refused on kernel and block routes, except liveness and "is this
  set up yet";
- OS actions (`POST /api/os/action`) still need a session or `AEON_MOBILE_SECRET`, so
  without an account they need the mobile secret;
- the credential backup (Settings) can be exported without a password from AEON's own
  page on this machine, the dev server's page, or a program on this machine. It
  contains the vault master key. It is refused to the tunnel, to a page from any other
  origin, and to a request that carries a proxy's forwarding headers
  (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `Via`, `CF-Connecting-IP`). A proxy on
  this machine that sends none of them is not told apart (see above).

Creating an account is the protection; nothing else stands in for it. Whether AEON
should require one at first launch is not decided yet.

## Remote Access (Cloudflare tunnel)

`cloudflared` connects to AEON on this machine, so tunnel requests arrive from
127.0.0.1. AEON tells them apart by their `Host`, the tunnel's own name:

- Starting the tunnel is refused unless an account exists and login is on.
- While the tunnel runs, every tunnel request is refused if login is off (no account,
  or "Require login" switched off).
- The `AEON_MOBILE_SECRET` bearer gate and the rate limiter do not apply to tunnel
  requests (both decide by socket address). Sign-in itself locks for 15 minutes after
  5 wrong passwords.

## Installing blocks

The build pipeline (`/api/build`) and the store install (`/api/store/install`, which
takes a catalog name, an uploaded cartridge or any `https://` URL) run every cartridge
through the same steps: a gate that scores it, staging, lint, and a boot proof that
loads the staged block and runs its code inside the AEON process. A **LOW** score is
promoted with no approval click and lands stopped: it serves nothing until you start
it. **MEDIUM** and **HIGH** wait in the approval queue. These routes have no gate of
their own: with login on they need a session like every other route; with no account,
or login switched off, they answer this machine. Blocks share one Node.js process, so
installing a block is trusting its code. Whether LOW-score builds should also wait for
a click is not decided yet.

## Key rotation procedure

Run this whenever a key may be exposed:

1. **Generate new key** at the provider dashboard (Groq, Gemini, Supabase, etc.).
2. **Replace it** on every machine that runs AEON (Settings → Keys, or `.env`).
   Never commit.
3. **Supabase service_role**: Settings → API → roll. Then redeploy with new key in
   server env ONLY. Grep first: `grep -rI service_role src/` must only hit `kernel/`.
4. **Vault master key** (`AEON_VAULT_MASTER_KEY`): rotating it requires re-encrypting.
   Decrypt with old key → set new key → re-save each secret. Do NOT lose the old key
   mid-rotation or the vault is unrecoverable.
5. **Verify**: `npm run canary` + a smoke login.

## Legacy → new Supabase keys

Migrate `eyJ...` legacy keys to `sb_publishable_...` + secret scheme. Migrate and
verify the app FIRST; only then disable legacy keys, or AEON breaks instantly.

## Reporting a vulnerability

Report privately, never in a public issue: see the
[security policy](../.github/SECURITY.md).

## Standing orders (non-negotiable)

- Never add `USING (true)` for `anon`/`public` on a sensitive table.
- Never put `service_role` or `AEON_VAULT_MASTER_KEY` anywhere the browser loads.
- Prefer breaking the app temporarily over leaving data exposed.
