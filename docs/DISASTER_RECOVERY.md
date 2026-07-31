# AEON — Disaster Recovery

Objectives: **RTO ≤ 1 hour**, **RPO ≤ 24 hours** (last daily sync).

## What can fail and how to recover

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Server crash loop | Healthcheck red / `pm2` restarts | `uncaughtException` exits non-zero → process manager restarts. Check Pino logs for the fatal line. |
| Supabase data loss/corruption | Canary errors, app read failures | Restore from Supabase PITR (Pro plan) or the daily GAS backup (`/api/sync/gas-backup`). |
| RLS regression (data exposed) | `npm run canary` → EXPOSED | Re-run `db/migrations/001_enable_rls.sql` immediately. Then investigate what dropped the policy. |
| Vault unreadable (lost master key) | `[VAULT] decrypt failed` | The key is unrecoverable by design. Restore `AEON_VAULT_MASTER_KEY` from your password manager, OR re-enter every secret via the Settings → Account panel. **Back up this key offline.** |
| Vercel outage | Site down | Desktop/Electron build keeps working locally (split-brain design). |
| Compromised API key | Provider alert / unexpected spend | Rotate at provider, update env, redeploy. See [SECURITY.md](SECURITY.md) §rotation. |

## Backups — what exists

- **Supabase**: source of truth. Enable Point-in-Time Recovery (Pro) — this is the
  single most important backup. Without it, RPO = the daily GAS sync.
- **GAS daily backup**: `vercel.json` cron `/api/sync/gas-backup` (00:00). Failsafe, not primary (R-08).
- **Vault master key**: store `AEON_VAULT_MASTER_KEY` in a password manager. It is
  NOT in any backup and cannot be regenerated to decrypt existing data.
- **Local JSON stores** (`db/*.json`): per-box, not authoritative. Mount a
  volume or rely on Supabase sync.

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
