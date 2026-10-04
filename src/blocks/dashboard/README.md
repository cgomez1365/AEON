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
  hit), and a Gemini → Groq → offline-failsafe fallback chain. With Memory
  Core's **Write a handoff when you save a chat** on, an explicit save of a chat
  with an agent (not an automatic one) also has that agent write a handoff
  (`src/kernel/agentWorkspace.cjs`), in the background and logged.
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

  **3.3.0 — the agent turn.** The single `kernelLLM.stream` call is now
  `runAgentTurn` (`src/kernel/agentTurn.cjs`): a bounded loop of model calls
  ("rounds"), with the agent's `callOptions` (Local only included) on every call.
  Later rounds resolve the chat role exactly as the first did (registry address, key
  pool, rpm pacing); when a fallback served the first round, later rounds are pinned
  to that provider and model, still through its registry connection when it has one. Two things make a new round:
  - **A tool call.** The system prompt gains a `## TOOLS` section
    (`src/kernel/toolProtocol.cjs`) listing only the tools this caller may use. The
    model asks for one with a fenced `aeon-tool` block — plain text, so no provider
    function-calling is needed (local llama.cpp included; how reliably a model writes
    the block depends on the model). The stream scanner stops the round at
    the block's closing fence (no character of the block reaches the screen), the
    toolbox (`src/kernel/agentTools.cjs`) runs it between rounds, and the result goes
    back as a `user` message wrapped as data (`<<<AEON-TOOL-RESULT <nonce> …>>>`, with
    a random nonce per turn that the system prompt names; fences and markers inside it
    neutralised in any case). At most 6 tool calls per turn, 3 of them writes; result
    and time caps per tool; off when the chat role's model window is under 4,096 tokens, for
    non-chat roles, or with Memory Core's `agent_tools` off. Every outcome is also
    written to the OS audit log (`AGENT_TOOL`).
  - **The output limit.** A round the kernel reports as `truncated` (the provider's
    own finish reason: `length`, `MAX_TOKENS`, `max_tokens`) is continued with
    `CONTINUE_PROMPT` (`src/kernel/continuation.cjs`), up to Memory Core's
    `auto_continue_parts` (default 4, at most 8); the start of each continuation is
    held until the seam is decided (200 characters, longer while it still repeats
    shown text; past 1,000 it is followed through the previous part, and a restart
    that runs on to that part's end is dropped however long it is), so a repeated
    overlap (12 characters or more), a restarted sentence or line (4 or more) or a
    "Continuing:" style preamble is dropped. A part that ended at a line break and
    starts again with that line keeps it (a checklist can repeat a line), and an
    overlap that is a short repeating pattern ("0 0 0 0") is kept (repetitive data
    can rightly go on with more of the same). A tool-call opener the limit cut in
    half (a fence of three and the start of `aeon-tool`, or a one-line call) is
    carried into the next part and completed there; any other held text is shown.
    A provider that sends no finish reason is never continued. A later part is sent
    with `noTrimRetry` and `continuation`: when the provider says it is too large, or
    a reasoning model returns nothing at the limit, the turn ends with the parts
    already shown, `truncated: true` and a `continue-stopped` notice — it is never
    retried with the answer and the question trimmed away. A round after a tool
    result is sent with `noTrimRetry` only: it is never retried trimmed (the trim
    keeps the system head and the wrapped tool result, and drops the tool rules),
    but it still falls back to the next provider with the full request; when no
    provider can take it, the answer so far stays with a `tool-round-stopped` notice
    (with nothing shown yet, it is an error).

  The agent's scratchpad and the newest handoff's first 1,500 characters are
  injected before the tools section (`src/kernel/agentWorkspace.cjs`), on every
  turn until a newer handoff exists,
  labelled as its own notes and neutralised like a tool result; memory rules stay
  last. After the turn a claim check looks for common first-person phrasings ("I
  searched your Vault", "I read the file", "I saved it to my memory", "I asked
  <agent>" — any agent the operator has, not only those the caller may ask) and
  emits a `notice` when no tool of that kind succeeded in the turn (a
  Vault search does not back a web claim, nor the reverse); other wordings are not
  caught. Recalled Second Brain passages and memories are neutralised like tool
  results, so a block quoted from them never runs. No shell, no code execution, no arbitrary HTTP: apart from the
  model calls a chat already makes (and `vault_search`'s query embedding through the
  retriever), the only outside service a tool contacts is `fetchWebSearch`;
  `memory_save` and `vault_search` call AEON's own routes over loopback, and a save
  (`memory_save`, `artifact_save`) starts the usual Vault indexing, which embeds the
  saved text with the Embedding role's model (a cloud one when no local embedding
  model is installed).

  SSE events of `POST /api/chat/stream` (the terminal renders each; unknown events
  are ignored):

  | Event | Fields | When |
  |---|---|---|
  | `meta` | as before; the first one of a turn also has `tools` (names), `toolsOff` (reason or null), `autoContinue` `{on, maxParts}`, `scratchpadChars`, `handoffAt` | start of the turn, and on a provider fallback |
  | `token` | `t` | visible text, all rounds and parts |
  | `tool_call` | `id`, `n`, `tool`, `args` (long strings cut, `content` replaced by its length), `write`, `label` | a tool block was parsed (malformed and unknown ones too) |
  | `tool_result` | `id`, `n`, `tool`, `ok`, `status` (`ok`/`error`/`refused`), `code`, `summary`, `preview` (≤ 4,000 chars), `chars`, `truncated`, `ms`, `notice` (always set for a successful write) | after the tool ran or was refused |
  | `continue` | `part`, `max`, `reason: 'max_tokens'` | before a continuation round |
  | `notice` | `level` (`info`/`warn`), `code` (`tool-limit`, `write-limit`, `unbacked-claim`, `tools-off`, `results-budget`), `message` | engine notices |
  | `warning` | `message` | as before |
  | `done` | as before, plus `parts`, `continued`, `toolCalls`, `toolWrites`; `text` is the whole visible answer; `truncated` only if the last part still hit the limit | end of the turn |
  | `error` | `error` | as before (`partialText` when text had already streamed) |
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
| POST | `/api/chat/stream` | `api/chat-stream.cjs` | SSE token-by-token chat completion with provider fallback, the agent tool loop and automatic continuation (events above). |
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
