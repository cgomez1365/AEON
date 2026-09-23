# 📊 AEON Block: Activity

**ID:** `activity`
**Route:** `/activity`
**Tier:** `core`
**Status:** `ACTIVE`

GitHub-style 365-day heatmap of AEON's own token/request usage, with a stats
row (total requests/tokens, current/longest streak, active days, last-7-days),
a click-through day detail panel, and a per-model usage breakdown. This is
AEON looking at its own activity log, not a user-facing content feature.

## Files
- `index.jsx` — the heatmap UI. Fetches `/api/token-analytics/heatmap` +
  `/api/token-analytics/summary` in parallel on load; clicking a day cell
  fetches `/api/token-analytics/daily/:date` for the detail panel.
- `api/token-analytics.cjs` — the block's actual API. **Counts come from the
  kernel's per-call ledger** (`<db>/llm_calls.jsonl`, written by
  `services/ai.js` for every provider call, failures included, with status and
  error). `activity_heatmap.json` is still written and is read only for days
  that predate the ledger. Until 2026-09-23 counts came from the heatmap file
  and cost from the ledger, so the two could disagree.
- `api/_ledgerView.cjs` — pure day-wise helpers (calendar walks at local noon,
  merge, streaks, 1/7/30/90-day windows). `_`-prefixed: never mounted.
- `api/analytics.cjs` — an older, broader router that predates the
  heatmap-focused rebuild (see *Known limitations*). Not called by this
  block's own UI; it's a legacy grab-bag of kernel-adjacent endpoints
  (search fallback, telemetry proxy, pipeline metrics, audit log) still
  consumed by other blocks (Dashboard, Fleet Control).
- `db/activity_heatmap.json` — the daily ledger (`{ "YYYY-MM-DD": { requests, tokens, models: {...} } }`), pruned to the trailing ~365 days.
- `block.manifest.json` — kernel contract (permissions, requires, routes).
- `.aeon.runtime.json` — **auto-generated on every boot** by the kernel
  (`src/kernel/blockStandard.cjs`). Do not hand-edit; it's overwritten.

## API routes

### `api/token-analytics.cjs` (mounted at `/api`) — this block's real surface
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/token-analytics/heatmap` | 365 calendar days ending **today** of `{date, requests, tokens, errors, weekday}` + `maxRequests`/`totalRequests`/`totalTokens`/`activeDays`. Backs the grid. |
| GET | `/api/token-analytics/summary` | Totals + `errors`, `today`/`last7`/`last30`/`last90` (calendar days, today included), current streak (run reaching today, or yesterday before today's first call) and longest streak, per-model breakdown with provider/errors/avgLatency, `dailyCost` (the kernel's `getDailyCost()` when injected), `pricedProviders`, `firstDay`, `source`. |
| GET | `/api/token-analytics/calls` | Newest ledger records; `?failed=1` for failures only, each with the HTTP `status` and `error` the kernel kept. `?limit=` (max 200). |
| GET | `/api/token-analytics/daily/:date` | Full detail for one day, including per-model request/token counts and `errors`. |
| POST | `/api/token-analytics/record` | Records one usage event `{tokens, model, engine}` for today. HTTP entry point for external callers. |

Internally, `router._recordActivity` is also exposed as a **plain function**
(not an HTTP route) and wired up directly in `server.js` via
`ai.setActivityRecorder(tokenAnalyticsRouter._recordActivity)` — every LLM
call anywhere in AEON records into this block's ledger without an HTTP
round trip.

### `api/analytics.cjs` (mounted at `/api`) — legacy, not activity-specific
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/search` | Second Brain matrix keyword search fallback: Supabase-backed (`aeon_notes`/`documents`/`aeon_blocks`) on Vercel; local filesystem walk + keyword scoring over `Data/Second_Brain/*` (including PDF text via `pdf-parse`) otherwise. |
| GET | `/api/telemetry/live` | Proxies the kernel's live telemetry (`/api/llm-telemetry`, backed by `src/kernel/routers/telemetry.cjs`). |
| GET | `/api/telemetry` | All-time usage per provider from the call ledger (`staffUsage[provider] = {requests, tokens, errors}`), plus today's derived cost (`totalCost`, `costScope: 'today'`). `TelemetryContext` falls back to it after every restart. Until 2026-09-23 it counted chat-log messages at 150 tokens each, so a fresh install showed 1 request / 150 tokens. |
| GET | `/api/pipeline-metrics` | Reads `clients.json` (BGI Store client pipeline) and buckets dollar value by status into `drafted`/`ready`/`identified`. |
| GET / POST | `/api/audit` | Read/append the audit log — Supabase-backed with a local-file cache/fallback. |

None of these five are called by `index.jsx`; they're consumed elsewhere
(the retired hand-written block matrix listed Dashboard and Fleet Control as
readers of `/api/llm-telemetry`, `/api/pipeline-metrics`,
`/api/token-analytics/*`; the generated `docs/BLOCKS.md` replaced it 2026-09-14).
They're real, mounted, working routes — not dead code — just misfiled under
this block from an earlier iteration.

## Config / settings / env keys
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — server-side, injected via
  `deps.supabase`. Used opportunistically (Second Brain search, telemetry/
  audit persistence on Vercel); the block degrades to local-file storage
  without them, so `requires.apis` lists `supabase` but nothing here hard-fails
  if it's absent.
- `AEON_KERNEL_URL` / `PORT` — used to build the base URL for the
  `/api/telemetry/live` → `/api/llm-telemetry` proxy call (see fix below).
  Defaults to `http://localhost:${PORT || 3001}` when unset.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — read directly in the
  browser (`index.jsx`) as a fallback path when the primary
  `/api/token-analytics/*` fetches fail, querying `aeon_blocks` for a
  block-tag `activity` payload. This is the Supabase **anon** key (RLS-
  protected, meant to be public), not a privileged secret — different from
  the "never expose provider keys via `VITE_`" rule. Neither var is declared
  in `block.manifest.json`'s `env`; if unset, this fallback path just no-ops.

## Storage
- `src/blocks/activity/db/activity_heatmap.json` — path resolved via
  `deps.getDataFile('activity/activity_heatmap.json')`, which redirects to
  `/tmp` on Vercel (read-only FS outside `/tmp`) and to this `db/` folder
  locally. Auto-pruned to ~365 days once it exceeds ~400.
- `AUDIT_FILE` / `LOG_FILE` / `TOKEN_LEDGER_FILE` — shared kernel-level log
  files, not owned by this block; `api/analytics.cjs`'s legacy routes read/
  write them via `deps`, with the actual paths resolved by the kernel
  storage service (outside this block's folder).

## Dependencies (injected via the `deps` factory argument)
- `api/token-analytics.cjs`: `getLocalFile`, `getDataFile`, `AUDIT_FILE`, `LOG_FILE`, `TOKEN_LEDGER_FILE`.
- `api/analytics.cjs`: `isVercel`, `supabase`, `getLocalFile`, `AUDIT_FILE`, `LOG_FILE`, `TOKEN_LEDGER_FILE`, `GEMINI_PRICE_PER_TOKEN`, `GROQ_PRICE_PER_TOKEN`, `validateSDI`.
- npm: `pdf-parse` (local Second Brain search fallback only, lazily `require`d inside the `/search` handler).

## Fixed in this pass
- **Hardcoded `http://localhost:3001`** in `GET /api/telemetry/live` — now
  built from `process.env.AEON_KERNEL_URL || \`http://localhost:${process.env.PORT || 3001}\`` (matches the pattern in `tools/autopilot-daemon.cjs`). Considered
  calling the kernel telemetry handler in-process instead of an HTTP hop, but
  blocks are mounted in isolation by `src/kernel/blockHost.cjs` with no
  shared handler references passed into `deps` — reaching into
  `src/kernel/routers/telemetry.cjs` directly from a block would break that
  isolation, so the env-based URL was the right fix at this scope.
- **`contract.permissions.filesystem`** was `"none"` in the manifest despite
  this block reading and writing `db/activity_heatmap.json`, `AUDIT_FILE`,
  and `clients.json` — corrected to `"write"`.
- **`contract.permissions.ai`** was `true` despite nothing in this block ever
  calling `kernelLLM`/`geminiRequest`/Groq — corrected to `false` (now
  consistent with `contract.ai.canGenerate/canAnalyze/canAutomate: false`,
  which were already accurate).
- **`routes`** declared a single fictional `\`/token_heatmap/*\`` catch-all
  that matched nothing real — replaced with the 10 routes this block
  actually serves (verified against `src/kernel/blockHost.cjs`, which mounts
  every `api/*.cjs` file's router at `/api`).
- Accessibility pass on `index.jsx`: the icon-only refresh button got an
  `aria-label`; decorative icons that sit beside visible text labels got
  `aria-hidden="true"`; the heatmap day cells (previously bare `<div onClick>`
  with no keyboard path and `outline: none`) are now `role="button"`,
  `tabIndex={0}`, `aria-label`/`aria-pressed`, handle Enter/Space, and use
  `boxShadow` instead of `outline` for the "selected" indicator so a real
  `:focus-visible` outline (added via an injected `<style>` rule) still shows
  for keyboard users; the loading state got `role="status"`/`aria-live`.

## Known limitations (judgment calls, not fixed here)
- `GROQ_PRICE_PER_TOKEN` and `getLocalFile` are destructured from `deps` in
  `api/analytics.cjs` but never used in the file — dead bindings, left alone
  (not a hardcoded path or a dead route, just unused locals; out of this
  pass's scope).
- `api/analytics.cjs`'s five routes (`/search`, `/telemetry`, `/telemetry/
  live`, `/pipeline-metrics`, `/audit`) are not activity-specific and arguably
  belong under Dashboard or a shared kernel router instead of this block.
  Relocating them would mean touching `server/server.js`'s mount list and
  every other block that calls them — out of scope for an activity-only
  pass, so they're documented here instead of moved.
