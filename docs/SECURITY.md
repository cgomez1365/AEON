# AEON — Security Guide

Operational security model and procedures. For the incident history see
[AEON-SECURITY-HANDOFF.md](AEON-SECURITY-HANDOFF.md).

## Model in one paragraph

The browser never touches sensitive Supabase tables directly. RLS denies the anon
key (default deny-all). All privileged DB access goes through the server, which holds
`service_role` (bypasses RLS) in server-only env. External API + every OS shell
endpoint requires `AEON_MOBILE_SECRET` (bearer); shell endpoints fail **closed** if the
secret is unset. Secrets at rest are AES-256-GCM encrypted in the vault, keyed by
`AEON_VAULT_MASTER_KEY` which lives only in env.

## Controls in place

| Control | Where | Notes |
|---------|-------|-------|
| RLS deny-all on sensitive tables | `db/migrations/001_enable_rls.sql` | anon gets nothing |
| Server boundary (service_role) | `server/server.js`, `src/kernel/vault.cjs` | key server-only |
| CORS allowlist (no wildcard) | `server/server.js` | fail-closed on bad origin |
| Bearer auth on `/api` (external) | `server/server.js` | local requests identified by socket address, never the `Host:` header |
| Session required on privileged OS endpoints | `requireShellAuth` | operator session from every origin, loopback included; `AEON_MOBILE_SECRET` for headless callers; fail-closed when neither is present |
| No shell execution surface | `src/blocks/host_os/api/os.cjs` | named actions with argument arrays; no client string ever reaches a shell |
| Session gate on the Operator Console | `requireOperator` | independent of global guard state; pre-account access is loopback-only so a fresh install can reach setup |
| Security headers (helmet) | `server/server.js` | HSTS, X-Frame-Options, etc. |
| Rate limiting | `server/server.js` | 120/min/IP default, tunable |
| Encrypted vault | `src/kernel/vault.cjs` | AES-256-GCM, atomic writes, mode 0600 |
| Crash guards | `server/server.js` | uncaught/unhandled → log + restart |
| Log redaction | `src/kernel/logger.cjs` | secrets censored in logs |
| Anon canary | `tools/rls-canary.cjs` | alerts if a table goes public |
| Dependency audit | `.github/workflows/ci.yml`, dependabot | weekly |

## Key rotation procedure

Run this whenever a key may be exposed (and once now — keys have been on disk):

1. **Generate new key** at the provider dashboard (Groq, Gemini, Supabase, etc.).
2. **Update env** in every deployment target (Vercel dashboard,
   self-host `.env`). Never commit.
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

Internal project — route findings to the CEO directly. For anything touching
candidate PII, escalate before acting (notification obligations may apply).

## Standing orders (non-negotiable)

- Never add `USING (true)` for `anon`/`public` on a sensitive table.
- Never put `service_role` or `AEON_VAULT_MASTER_KEY` anywhere the browser loads.
- Prefer breaking the app temporarily over leaving data exposed.
