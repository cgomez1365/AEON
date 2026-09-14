# AEON — Deployment

AEON is built to run on the operator's own machine. That is the only target that is
exercised: the launchers on Windows, macOS and Linux, and five CI legs on every push.

| Target | Status | Use when |
|--------|--------|----------|
| **Local install** (launcher or Desktop icon) | Verified continuously | The normal way to run AEON |
| **Self-hosted (bare Node)** | Supported, same code path as local | One always-on box you control |
| **Vercel** (stateless cloud mirror) | **Never deployed — unverified** | See §2 before relying on it |

---

## 0. Pre-flight (any target)

- [ ] `npm test` passes
- [ ] `npm run scan:release-gate` and `npm run scan:audit` pass
- [ ] `node --check server.cjs` passes
- [ ] If you use Supabase: `npm run migrate -- --status` shows `001_enable_rls.sql` applied, and `npm run canary` reports all tables LOCKED
- [ ] Secrets live in the target's environment store, never in code — see [SECURITY.md](SECURITY.md)
- [ ] `NODE_ENV=production` is set on any shared host

---

## 1. Self-hosted (bare Node)

```bash
npm ci
npm run build
NODE_ENV=production node server.cjs        # or under pm2 / systemd
```

The kernel serves the built frontend from `dist/` on port 3001. With a process manager,
an uncaught exception exits non-zero and the manager restarts it:

```bash
pm2 start server.cjs --name aeon --time
pm2 save && pm2 startup
```

Every writable root can live outside the install directory — see the storage table in
[ARCHITECTURE.md](ARCHITECTURE.md).

## 2. Vercel — unverified

`vercel.json`, `.vercelignore` and `api/` describe a stateless cloud mirror, and the code
carries cloud branches for it. **It has never been deployed from this repository:** every
Vercel project on the account showed zero deployments from the repository's creation
(2026-07-21) to 2026-09-14. Until a deployment has run and passed §3, treat this section
as design, not a supported path.

What is known to be required:

- Vercel runs `npm run build`, which executes `scripts/gen-*.cjs` and writes
  `docs/BLOCKS.md`. `.vercelignore` must therefore upload `scripts/` and `docs/` (fixed
  2026-09-14; both were excluded before).
- Set environment variables in the Vercel dashboard, never in `vercel.json`.
- The serverless filesystem is read-only: the vault, local models, the Second Brain index
  and the launcher do not exist there. Keys come from the environment
  (`AEON_VAULT_MASTER_KEY`, provider keys) and data from Supabase.
- `vercel.json` defines rewrites only — no cron jobs. Earlier revisions of this page listed
  two crons that the file never contained.

```bash
vercel --prod
```

## 3. Post-deploy verification

- [ ] `curl https://<host>/api/ping` answers — it is mounted before the auth gate, so it
      distinguishes "server locked" from "no server"
- [ ] `curl https://<host>/core/health` returns kernel health
- [ ] Rate limit active: 121 rapid requests to `/api/*` produce a `429`
- [ ] Security headers present: `curl -I https://<host>/` shows `x-content-type-options` and `x-frame-options`
- [ ] Error responses in production carry no stack trace
- [ ] If you use Supabase: `npm run canary` from outside reports all tables LOCKED

## 4. Rollback

- **Local / self-hosted:** check out the previous release tag and rebuild.
- **Vercel:** `vercel rollback`, or promote the previous deployment in the dashboard.
- **Database:** migrations are additive. To roll back a policy, write a new `00X_*.sql` —
  never edit an applied migration. See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
