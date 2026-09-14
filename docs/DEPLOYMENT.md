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

## 2. Vercel — removed

A stateless Vercel mirror was described in this repository from its creation
(2026-07-21) and never deployed once. On 2026-09-14 the mirror's files were removed:
the rewrite config, the ignore file, the generated serverless entry and its generator,
and the cloud-only web-search function. The local `/api/search-web` route in
`services/search.js` is unaffected.

What remains is the code's own cloud awareness: the `isVercel` branches that every
cloud-aware module carries (95 sites across 22 files, counted and ratcheted by
`scripts/scan-cloud-surface.cjs`). They are subtractive — each one skips something
the cloud could not do — and inert on every supported target. They are being removed
under the ratchet, which only ever allows the count to fall.

If a cloud deployment is ever wanted again, it starts from a design, not from these
remnants: a read-only filesystem, no vault, no local models, no Second Brain index,
keys from the environment and data from Supabase.

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
