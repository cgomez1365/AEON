# AEON — Production Deployment Runbook

Three supported targets. Pick by client requirement.

| Target | Use when | Effort |
|--------|----------|--------|
| **Vercel** | Default cloud mirror, fast iteration | Lowest |
| **Docker** | Client wants AEON on their own infra (AWS/DO/Fly/bare metal) | Medium |
| **Self-hosted (bare Node)** | Single box, full control, local models | Medium |

---

## 0. Pre-flight (all targets)

- [ ] `npm test` passes
- [ ] `node --check server.cjs` passes
- [ ] RLS migration applied: `npm run migrate -- --status` shows `001_enable_rls.sql` applied
- [ ] Canary green: `npm run canary` → all tables LOCKED
- [ ] All secrets set in the target's env store (never in code) — see [SECURITY.md](SECURITY.md)
- [ ] `NODE_ENV=production` set in the target

### Required env vars
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY      # server DB access (service_role bypasses RLS)
SUPABASE_ANON_KEY                            # canary + client
AEON_VAULT_MASTER_KEY                        # 32-byte hex; decrypts secret vault
AEON_MOBILE_SECRET                           # bearer for external API + shell endpoints
GROQ_API_KEY / GEMINI_FREE_KEY_*             # LLM providers
NODE_ENV=production
AEON_ALLOWED_ORIGINS                         # comma-separated extra CORS origins
```

---

## 1. Vercel

```bash
# Set env in Vercel dashboard → Project → Settings → Environment Variables
# (NOT in vercel.json — keep secrets out of the repo)
vercel --prod
```
- Crons (`vercel.json`): `/api/sync/gas-backup` daily, `/api/cron/sweep` 02:00. Ensure both routes exist in `server.cjs`.
- Serverless FS is read-only → vault pulls the encrypted blob from Supabase. Confirm `AEON_VAULT_MASTER_KEY` is set in Vercel env.
- Logs are ephemeral: ship to an aggregator or rely on Pino JSON in the Vercel log drain.

## 2. Docker

```bash
docker build -t aeon:latest .
docker run -d --name aeon -p 3001:3001 --env-file .env.production aeon:latest
docker logs -f aeon          # structured JSON via Pino
curl localhost:3001/         # {"status":"ok",...}
```
- Image runs as non-root (`aeon`), has a HEALTHCHECK on `/`.
- Mount a volume for persistence if you want local JSON stores to survive restarts:
  `-v aeon-data:/app/db`.

## 3. Self-hosted (bare Node)

```bash
npm ci --omit=dev
npm run build
NODE_ENV=production node server.cjs        # or under pm2/systemd
```
Recommended process manager (auto-restart picks up the new `uncaughtException` exit):
```bash
pm2 start server.cjs --name aeon --time
pm2 save && pm2 startup
```

---

## 4. Post-deploy verification

- [ ] `curl https://<host>/` → `{"status":"ok"}`
- [ ] `curl https://<host>/core/health` → kernel health + orphaned routes
- [ ] Rate limit active: 121 rapid requests → a `429`
- [ ] Security headers present: `curl -I https://<host>/` shows `x-content-type-options`, `x-frame-options`
- [ ] Canary from outside: `npm run canary` → all LOCKED
- [ ] Error responses in prod contain NO stack/`message` field

## 5. Rollback

- **Vercel:** `vercel rollback` or promote the previous deployment in the dashboard.
- **Docker:** `docker stop aeon && docker run ... aeon:<previous-tag>`.
- **DB:** migrations are additive (RLS enable). To roll back a policy, write a new
  `00X_*.sql` — never edit an applied migration. See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).
