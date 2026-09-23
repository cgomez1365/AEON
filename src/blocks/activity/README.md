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
- `api/analytics.cjs` — shared, non-heatmap routes other surfaces call:
  `GET /api/telemetry` (TelemetryContext's post-restart fallback) and
  `GET/POST /api/audit` (App.jsx → the Dashboard's live feed). Three dead
  routes were retired from it 2026-09-23 (see below).
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

### `api/analytics.cjs` (mounted at `/api`) — shared routes, not activity-specific
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/telemetry` | All-time usage per provider from the call ledger (`staffUsage[provider] = {requests, tokens, errors}`), plus today's derived cost (`totalCost`, `costScope: 'today'`). `TelemetryContext` falls back to it after every restart. Until 2026-09-23 it counted chat-log messages at 150 tokens each, so a fresh install showed 1 request / 150 tokens. |
| GET / POST | `/api/audit` | Read/append the audit log — local file (`AUDIT_FILE`), mirrored to Supabase only when a client is configured. The Dashboard's live feed reads it through `App.jsx`. |

**Retired 2026-09-23** (Bible §21, gate `tests/activity-retired-routes.test.js`),
each proved dead by `git grep` (no caller) and broken on a running install:
`GET /api/telemetry/live` (answered HTTP 200 with the kernel's 401 body — the
loopback never forwarded the session), `POST /api/activity/search` (walked
`<install>/Data/Second_Brain/*`, which no install has, with a keyword regex
whose `\b` had become a backspace; also loaded `pdf-parse`), and
`GET /api/pipeline-metrics` (read `src/blocks/activity/clients.json`, which
exists nowhere, so it always said `$0/mo`).

## Config / settings / env keys
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — server-side, injected via
  `deps.supabase`. Used only to mirror the audit log when configured; the
  block runs entirely on local files without them.
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
- `api/token-analytics.cjs`: `getDataFile`, `TOKEN_LEDGER_FILE` (the ledger is its sibling `llm_calls.jsonl`), optional `getDailyCost`.
- `api/analytics.cjs`: `supabase`, `AUDIT_FILE`, `TOKEN_LEDGER_FILE`, `GEMINI_PRICE_PER_TOKEN`, `GROQ_PRICE_PER_TOKEN`, `validateSDI`, optional `getDailyCost`.
- Kernel module: `src/kernel/llm-ledger.cjs` (read-only use).

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
- `api/analytics.cjs`'s two surviving routes (`/telemetry`, `/audit`) are not
  activity-specific. The Dashboard's live feed and every restart's telemetry
  fallback therefore depend on this block; the Dashboard manifest declares
  `requires.blocks: ["activity"]` so that dependency is visible.
- `server/server.js` mounts `api/token-analytics.cjs` a second time, directly,
  to wire `_recordActivity` into `services/ai.js`. With the ledger as the
  source that hook only feeds the legacy heatmap file.
