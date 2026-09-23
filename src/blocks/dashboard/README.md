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
- `index.jsx` — the main dashboard UI: KPI row, installed-blocks grid,
  LLM engines since server start, a tabbed Heatmap/Activity/Models card, and
  the live feed with recent failed calls.
  - **Spend today** — the kernel's own `getDailyCost()` over the call ledger
    (via `/api/token-analytics/summary`), labelled with which providers have a
    list price (gemini, groq); others count $0 and the card says so.
  - **LLM calls today** — requests, tokens and failures from the ledger.
  - **Server** — ONLINE / SIGNED OUT (401) / UNREACHABLE / HTTP n.
  - **Video autopilot** — `tools/autopilot-daemon.cjs` status (a YouTube
    video producer mounted by the kernel; nothing here starts it).
  - Heatmap, 7d/30d/90d chart, Models tab (all-time ledger mix) and the
    failed-call list all read the activity block's ledger-derived routes, so
    they agree with each other and with `<db>/llm_calls.jsonl`.
  Polls `/api/llm-telemetry` + `/api/autopilot/status` every 5 s and the
  analytics every 30 s. When the activity block is missing, each panel says
  so instead of "Loading…" (the Supabase fallback only runs when
  `VITE_SUPABASE_URL` is set).
- `kpis.js` — the KPI/feed wording as pure functions
  (`tests/home-blocks-ui-logic.test.js`).
- `api/chat.cjs` — REST chat: `GET/POST/DELETE /api/chat`, plus
  `/api/terminal-history` (get/save) and the legacy `/api/terminal-stream`
  SSE bridge. Handles in-chat command interception (`/link`, `/scrape`,
  `/web`, `/matrix` + implicit Second Brain recall), the daily-cost kill
  switch (forces the local model once `KILL_SWITCH_THRESHOLD` is
  hit), and a Gemini → Groq → offline-failsafe fallback chain.
- `api/chat-stream.cjs` — SSE token-by-token streaming chat:
  `POST /api/chat/stream`, `POST /api/chat/stop`. Asks the kernel which
  provider/model serves the role (`kernelLLM.describeRole`), injects the
  operator's persistent memory + approved skills + Second Brain recall into
  the turn, then streams it through `kernelLLM.stream` — the same LLM layer
  every other AI call uses. Provider routing (endpoint registry, then
  `aeon-settings.json`), key resolution, pacing, cooldowns and the fallback
  chain (configured provider → `prefs.provider_priority` → local runtime)
  all happen in the kernel; the block relays tokens and emits a `warning` +
  corrected `meta` when the kernel falls back. `/chat/stop` aborts the
  in-flight stream and asks the kernel (`kernelLLM.cancelAll`) to reclaim
  local generations. Also fires a non-blocking auto-memory-extraction call
  after each turn when `brain_settings.auto_memory` is on.
- `api/audit.js`, `api/health.js`, `api/pipeline-metrics.js` — **retired
  2026-09-23** (Bible §21). Each registered `ALL` on a path another block
  already owned, so it only ever answered the methods the owner did not:
  `/api/audit` is activity's (dashboard's Supabase-only copy hung PUT/DELETE
  forever, and hung GET on every UI load once activity was removed);
  `/api/health` is host_os's (dashboard's mounted first and shadowed it);
  `/api/pipeline-metrics` had no caller and its POST seeded "$2,500/mo".
  `tests/route-collisions.test.js` ("an ALL route collides…") keeps them out.
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

The frontend (`index.jsx`) additionally reads routes owned by other
blocks — all legitimate kernel/block aliases, not dead calls:
`/api/llm-telemetry` and `/api/autopilot/status` (kernel telemetry +
`tools/autopilot-daemon.cjs`), and `/api/token-analytics/heatmap` +
`/api/token-analytics/summary` (the `activity` block). The live feed's
`auditLogs` prop comes from `GET /api/audit`, fetched by `src/App.jsx` and
served by the `activity` block.

`chat.cjs`/`chat-stream.cjs` are router-pattern files, so they're
dual-mounted at `/block/dashboard/*` as well as `/api` (see
`src/kernel/blockHost.cjs`).

## Config / settings / env keys
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or the `VITE_`/anon-key
  fallbacks) — used by `api/chat.cjs` for the
  Supabase-backed chat log / terminal history, with local-file
  fallback when Supabase is unset.
- `AEON_KERNEL_URL` / `PORT` — used to build the base URL for in-process
  kernel loopback calls (`/api/orion-scrape`, `/api/crn/second-brain/retrieve`,
  `/api/ai`, `/api/memory/add`). Defaults to
  `` `http://localhost:${process.env.PORT || 3001}` `` when unset — same
  pattern as `tools/autopilot-daemon.cjs`.
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — read directly in the
  browser (`index.jsx`, via `src/config.js`) as the fallback path when the
  primary `/api/token-analytics/*` fetches fail.
- Provider keys are never read by this block. `chat.cjs` calls the kernel's
  shared `geminiRequest`/`groqRequest` helpers and `chat-stream.cjs` streams
  through `kernelLLM.stream`; the kernel resolves each provider's key from
  the endpoint registry / vault (or `.env`) itself. `contract.permissions.secrets`
  stays `true` for the kernel-mediated provider access the terminal depends on.

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
- **Removing this block removes the terminal's chat.** `POST /api/chat/stream`,
  `/api/chat/*` and `/api/terminal/sessions*` live here; with the folder
  parked they answer 404 (measured 2026-09-23) and `/` renders an empty
  viewport. The chat backend belongs in the kernel or a `terminal` block.
- **The `$15` daily kill switch** (`KILL_SWITCH_THRESHOLD`) is enforced only
  by the legacy `POST /api/chat` in `api/chat.cjs`; the streaming terminal
  (`chat-stream.cjs`) does not check it. The Spend card no longer claims a
  limit.
- **INSTALLED BLOCKS** is the build-time registry (`import.meta.glob`), so a
  block removed from `src/blocks/` still appears until the UI is rebuilt, and
  headless blocks (host_os) are not counted.
- **Closed 2026-09-23: `api/pipeline-metrics.js` was deleted** (no caller;
  its non-GET methods answered invented dollar figures). See *Files*.
- **Closed 2026-09-14: `components/MobileCommandDashboard.jsx` and its
  duplicate `src/components/MobileCommandDashboard.jsx` were removed** in the
  stale-file sweep, together — the two-copies concern above was the reason an
  earlier pass left them. Neither was imported, `blockRegistry.js` never globs
  `components/*`, and several of their fetch targets (`/api/gas/sync`,
  `/api/gas/notes-push`, `/api/gas/crm`) were implemented nowhere.
  `tests/retired-files.test.js` keeps them from coming back.
