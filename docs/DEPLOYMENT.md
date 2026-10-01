# AEON — Deployment

AEON is built to run on the operator's own machine. That is the only target that is
exercised: five CI legs on every push, and the launcher runs on real hardware listed
(with dates, and with what has not been run) in the README's platform table.

| Target | Status | Use when |
|--------|--------|----------|
| **Local install** (launcher or Desktop icon) | CI on every push; real-hardware runs dated in the README | The normal way to run AEON |
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

The kernel serves the built frontend from `dist/` on port 3001. A fault inside one request
is logged and survived; a fault that leaves the process unsound (out of memory, a missing
module) exits non-zero, and a process manager restarts it. Both are written to
`data/logs/uncaught.log` in the AEON home. AEON's own launcher restarts only after
Settings → RESTART. Under pm2:

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
cloud-aware module carries (90 sites across 21 files on 2026-09-30, counted and ratcheted
by `scripts/scan-cloud-surface.cjs`). They are subtractive — each one skips something
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

- **Local / self-hosted:** check out the previous release tag, then `npm ci` and
  `npm run build`. Going back from 3.1.0 to **3.0.0 is not supported**: 3.0.0 keeps its
  data inside the install and does not read the AEON home, so it would start empty
  (your data in `~/AEON` is left as it is).
- **Database:** migrations are additive. To roll back a policy, write a new `00X_*.sql` —
  never edit an applied migration. See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
