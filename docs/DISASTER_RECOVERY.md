# AEON — Disaster Recovery

Objectives: **RTO ≤ 1 hour**, **RPO ≤ 24 hours** (last daily sync).

## What can fail and how to recover

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Server crash loop | Healthcheck red / `pm2` restarts | `uncaughtException` exits non-zero → process manager restarts. Check Pino logs for the fatal line. |
| Supabase data loss/corruption | Canary errors, app read failures | Restore from Supabase PITR (Pro plan). There is no other automated copy. |
| RLS regression (data exposed) | `npm run canary` → EXPOSED | Re-run `db/migrations/001_enable_rls.sql` immediately. Then investigate what dropped the policy. |
| Vault unreadable (lost master key) | `[VAULT] decrypt failed` | The key is unrecoverable by design. Restore `AEON_VAULT_MASTER_KEY` from your password manager, OR re-enter every secret via the Settings → Account panel. **Back up this key offline.** |
| Compromised API key | Provider alert / unexpected spend | Rotate at provider, update env, redeploy. See [SECURITY.md](SECURITY.md) §rotation. |

## Backups — what exists

- **Supabase** (if you connected one): enable Point-in-Time Recovery (Pro) — without
  it there is no automated copy. Earlier revisions of this page described a daily
  Google Apps Script backup on a Vercel cron; neither the cron nor the route ever
  existed in this repository.
- **The AEON home**: copy `~/AEON` (or `AEON_HOME`) — that one folder holds the
  Vault, the master key (`.env`), the keyslots and endpoint registry (`secrets`),
  the local models and indexes (`data`), runtime state and logs (`db`) and the
  settings file. A copy of it restored to a fresh install is a full local
  restore; nothing AEON keeps for you lives in the install directory.
- **Vault master key**: store `AEON_VAULT_MASTER_KEY` in a password manager as
  well. It is NOT regenerable to decrypt existing data — a copy of `~/AEON`
  without its `.env` is a copy you cannot open.
- **Local JSON stores** (`~/AEON/db`): per-box, not authoritative. Back up the
  home or rely on Supabase sync.

## Recovery drill (run quarterly)

1. Spin a fresh box / container from the image.
2. Set env from the password manager (incl. `AEON_VAULT_MASTER_KEY`).
3. `npm run migrate -- --status` → confirm schema current.
4. `npm run canary` → confirm tables locked.
5. Log in, confirm reads/writes work.
6. Time it. If > 1 hour, fix the slow step.

## Decisions that need the CEO

- Whether to pay for Supabase PITR (turns RPO from 24h → minutes).
- Candidate PII (`aeon_candidates`) breach-notification judgment — flag to legal.
