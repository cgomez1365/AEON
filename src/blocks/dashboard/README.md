# AEON Block: Dashboard

**ID:** `dashboard`
**Route:** `/`
**Tier:** `core`
**Status:** `ACTIVE`

AEON's main command-center landing screen (mounted at `/`, the app's root
route). Shows API spend, live LLM engine telemetry, a GitHub-style 365-day
activity heatmap / bar-chart / per-model breakdown, and a live audit feed.
It also owns the backend for the Neural Terminal chat (`contract.ai.role:
"chat"`) — request/response chat, SSE token streaming, and terminal history
persistence all live in this block's `api/` folder.

This block was recently stripped of a treasury/deficit panel; the current
UI only covers telemetry, spend, activity, and the audit feed described
below.

## Files
- `index.jsx` — the main dashboard UI: KPI row (API spend, LLM engines,
  server status, autopilot), LLM engine telemetry panel, a tabbed
  Heatmap/Activity/Models analytics card, and the live activity feed.
  Polls `/api/llm-telemetry` and `/api/autopilot/status` every 5s; loads
  `/api/token-analytics/heatmap` + `/api/token-analytics/summary` once on
  mount (falling back to a direct Supabase read of the `aeon_blocks` table
  if those kernel routes are unreachable).
- `api/chat.cjs` — REST chat: `GET/POST/DELETE /api/chat`, plus
  `/api/terminal-history` (get/save) and the legacy `/api/terminal-stream`
  SSE bridge. Handles in-chat command interception (`/link`, `/scrape`,
  `/web`, `/matrix` + implicit Second Brain recall), the daily-cost kill
  switch (forces the local model once `KILL_SWITCH_THRESHOLD` is
  hit), and a Gemini → Groq → offline-failsafe fallback chain.
- `api/chat-stream.cjs` — SSE token-by-token streaming chat:
  `POST /api/chat/stream`, `POST /api/chat/stop`. Reads role→provider→model
  from `aeon-settings.json`, injects VP's persistent memory + approved
  skills into the system prompt, and falls back configured provider → Groq
  → local runtime if a provider errors mid-stream. Also fires a non-blocking
  auto-memory-extraction call after each turn when `brain_settings.auto_memory`
  is on.
- `api/audit.js` — `GET/POST/PUT/DELETE/OPTIONS /api/audit`: Supabase-backed
  audit log (`aeon_audit_log` table), used by the live activity feed here
  and by other blocks that write audit entries.
- `api/health.js` — `GET/POST/PUT/DELETE/OPTIONS /api/health`: pure
  liveness check, no auth, no dependencies.
- `api/pipeline-metrics.js` — `GET/POST/PUT/DELETE/OPTIONS /api/pipeline-metrics`:
  reads `clients.json` and buckets pipeline dollar value by status
  (`drafted`/`ready`/`identified`). **Not called by this block's own UI or
  by any other `.jsx` in the app** — see *Known limitations* below; almost
  certainly a leftover from the treasury/deficit panel that was removed.
- `components/MobileCommandDashboard.jsx` — **removed 2026-09-14** with its
  duplicate `src/components/MobileCommandDashboard.jsx`. Neither was imported;
  the mobile shell (`MobileLayout.jsx`) renders this block's `index.jsx` for
  every route, including `/`.
- `block.manifest.json` — kernel contract (permissions, requires, routes,
  Neural Terminal `/note`, `/push`, `/pull` command registrations).
- `.aeon.runtime.json` — **auto-generated on every boot** by the kernel
  (`src/kernel/blockStandard.cjs`). Do not hand-edit; it's overwritten.

## API routes

| Method | Path | File | Purpose |
|---|---|---|---|
| GET/POST/DELETE | `/api/chat` | `api/chat.cjs` | Chat history + message post (with AI generation, command interception, cost tracking). |
| GET | `/api/terminal-stream` | `api/chat.cjs` | SSE bridge for `aeonTerminalStream` log events. |
| GET/POST | `/api/terminal-history` | `api/chat.cjs` | Read/save Neural Terminal conversation history. |
| POST | `/api/chat/stream` | `api/chat-stream.cjs` | SSE token-by-token chat completion with provider fallback. |
| POST | `/api/chat/stop` | `api/chat-stream.cjs` | Cancels a generation server-side. `{streamId}` stops that stream; no body stops every stream this process is running. Aborts the upstream request, so llama-server actually stops generating. |
| GET/POST | `/api/audit` | `api/audit.js` | Read/append the Supabase-backed audit log. |
| GET | `/api/health` | `api/health.js` | Liveness probe. |
| GET | `/api/pipeline-metrics` | `api/pipeline-metrics.js` | Client pipeline $ by status — **orphaned, no frontend caller** (see below). |

The frontend (`index.jsx`) additionally reads three routes owned by other
blocks — all legitimate kernel/block aliases, not dead calls:
`/api/llm-telemetry` and `/api/autopilot/status` (kernel telemetry +
`tools/autopilot-daemon.cjs`), and `/api/token-analytics/heatmap` +
`/api/token-analytics/summary` (the `activity` block).

`chat.cjs`/`chat-stream.cjs` are router-pattern files, so they're
dual-mounted at `/block/dashboard/*` as well as `/api`; `audit.js`,
`health.js`, and `pipeline-metrics.js` use the plugin pattern and register
directly on `/api` only (see `src/kernel/blockHost.cjs`).

## Config / settings / env keys
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or the `VITE_`/anon-key
  fallbacks) — used by `api/audit.js` and `api/chat.cjs` for the
  Supabase-backed chat log / audit log / terminal history, with local-file
  fallback when Supabase is unset.
- `AEON_KERNEL_URL` / `PORT` — used to build the base URL for in-process
  kernel loopback calls (`/api/orion-scrape`, `/api/crn/second-brain/retrieve`,
  `/api/ai`, `/api/memory/add`). Defaults to
  `` `http://localhost:${process.env.PORT || 3001}` `` when unset — same
  pattern as `tools/autopilot-daemon.cjs`.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — read directly in the
  browser (`index.jsx`, via `src/config.js`) as the fallback path when the
  primary `/api/token-analytics/*` fetches fail.
- Provider keys for Groq/Gemini are resolved by the kernel's shared
  `geminiRequest`/`groqRequest` helpers (local inference needs no key) and, in
  `chat-stream.cjs`, directly from the vault (`GROQ_API_KEY`,
  `GEMINI_PAID_KEY`/`GEMINI_FREE_KEY_1`, `OPENROUTER_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) — this is why
  `contract.permissions.secrets` is `true`.

## Storage
- `LOG_FILE`, `TERMINAL_HISTORY_FILE`, `AUDIT_FILE` — shared kernel-level
  log files (paths resolved outside this block), read **and written** by
  `api/chat.cjs` — this is why `contract.permissions.filesystem` is
  `"write"`, not `"read"`.
- `quick-links.json` (via `getLocalFile('quick-links.json')`) — written by
  the `/link <url>` chat command interceptor.

## Fixed in this pass
- **Hardcoded `http://127.0.0.1:3001`** in `api/chat.cjs` (`/scrape` and
  Second Brain recall loopback calls, 2 sites) and in `api/chat-stream.cjs`
  (auto-memory-extraction loopback, 2 sites) — all four now built from
  `process.env.AEON_KERNEL_URL || \`http://localhost:${process.env.PORT || 3001}\``,
  matching the pattern already used in `tools/autopilot-daemon.cjs`.
- **`index.jsx`** had no hardcoded fetch URLs (every fetch was already
  relative `/api/...`), but the "Server" KPI card's status text hardcoded
  the display string `"localhost:3001"` — changed to the port-agnostic
  `"Local kernel"` / `"Connect to the local kernel for live data"` so it
  doesn't lie when `PORT` is overridden.
- **`contract.permissions.filesystem`** was `"read"` despite `api/chat.cjs`
  writing `LOG_FILE`, `TERMINAL_HISTORY_FILE`, and `quick-links.json` —
  corrected to `"write"`.
- **`description`** referenced a "treasury" panel that no longer exists in
  `index.jsx` — rewritten to describe what's actually rendered (telemetry,
  spend, heatmap, audit feed).
- **`routes`** declared a single fictional `/dashboard/*` catch-all that
  matched nothing real — replaced with the 12 routes this block actually
  serves (verified against `src/kernel/blockHost.cjs`'s two mount
  patterns).
- Accessibility pass on `index.jsx` (the primary landing screen): decorative
  icons that sit beside visible text labels got `aria-hidden="true"`; the
  Heatmap/Activity/Models tab buttons and the 7d/30d/90d range buttons
  (state conveyed only by border/background color before this pass) got
  `aria-pressed` + a wrapping `role="group"`/`aria-label`; the 365 heatmap
  day cells (info previously available only via mouse-hover `title`, so
  invisible to screen reader / keyboard-only users) got
  `role="img" aria-label="<date>: N requests, N tokens"`; the Less→More
  legend swatches got `aria-hidden="true"` since they're decorative next to
  their own "Less"/"More" text. No icon-only buttons, `<img>` tags, or bare
  text inputs exist in `index.jsx`, and no `outline: none` was found.

## Known limitations (judgment calls, not fixed here — flagged for the operator)
- **`api/pipeline-metrics.js` is dead API surface.** It's mounted (both via
  `api/static-includes.js`'s static require and `api/index.js`'s Vercel
  route list — both outside this block's scope to edit) and responds
  correctly, but grepping every `.jsx` file in the repo turns up zero
  callers. The retired hand-written block matrix (replaced by the generated
  `docs/BLOCKS.md`, 2026-09-14) listed Dashboard as a reader of
  `/api/pipeline-metrics` — that was stale; the caller was almost certainly the treasury/deficit panel this
  block had stripped out. Deleting the file would leave a dangling
  `require()` in `api/static-includes.js` and `api/index.js` (root-level,
  out of this pass's scope) that would log a caught error on every boot.
  Recommend either wiring it into a real UI panel or removing it together
  with its two require sites in one cross-scope pass.
- **Closed 2026-09-14: `components/MobileCommandDashboard.jsx` and its
  duplicate `src/components/MobileCommandDashboard.jsx` were removed** in the
  stale-file sweep, together — the two-copies concern above was the reason an
  earlier pass left them. Neither was imported, `blockRegistry.js` never globs
  `components/*`, and several of their fetch targets (`/api/gas/sync`,
  `/api/gas/notes-push`, `/api/gas/crm`) were implemented nowhere.
  `tests/retired-files.test.js` keeps them from coming back.
