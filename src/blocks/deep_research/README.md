# Deep Research

Multi-step web research block. Given a plain-language query, it runs an LLM-in-the-loop
agent pipeline that plans sub-queries, searches the web across multiple rounds, extracts
and synthesizes findings, pulls out any real chartable data points, and writes a
citation-linked, academic-style report — all without ever inventing a source or a number.

Route: `/research` (nav id `deep_research`, category `intelligence`).

## What it does

1. **Query cleanup** — repairs a raw/typo'd or unpunctuated query with an LLM pass before
   it ever hits a search engine (does not add topics that weren't implied by the input).
2. **Planning** — asks the LLM to expand the query into 3–6 targeted sub-queries.
3. **Orion seed pass** — one extra search round (`{query}` and `{query} contact email phone`)
   to front-load structured findings before the main loop.
4. **Search + read rounds** — up to `max_rounds` (default 8, capped at 20) rounds of
   web search → source extraction → LLM analysis, bounded by `max_time` (default 300s,
   capped at 1800s) as well as round count.
5. **Data extraction** — a dedicated LLM pass looks for real, explicitly-stated numbers in
   the findings and turns them into up to 3 chartable series (bar/line). It returns an empty
   array rather than inventing data when nothing in the findings is genuinely chartable.
6. **Report write** — a long-form Markdown report (Abstract → Introduction → Methodology →
   Findings → Discussion → Limitations → Conclusion → References) with mandatory inline
   `[N]` citations tied to an exact numbered source list, and `[CHART:i]` placeholders for
   extracted data. Falls back to a compressed retry prompt, then a raw-findings dump, if the
   provider errors out (some free-tier models cap total context well under what the full
   findings dump needs).
7. **Persistence + vault sync** — the finished report is written to disk as JSON and a
   summary is pushed to the vault (`vaultSync('research', ...)`) for dashboard visibility.

Progress streams to the frontend over SSE (`/api/research/stream/:sessionId`) through phases:
`cleaning_query → planning → searching → reading → analyzing → extracting_data → writing → done`.

Two report renderers exist and are kept structurally/visually in sync:
- **Server-rendered** — `GET /api/research/report/:sessionId` (`buildReportHTML` in
  `api/index.cjs`), used as the fallback when a client-side result isn't already in memory.
- **Client-rendered** — `openReport()` in `index.jsx`, used when the finished job/library item
  is already loaded, so it can render instantly in a popup window without a round trip.

Both convert `[N]` citations into linked chips against the numbered source list and swap
`[CHART:i]` placeholders for a dependency-free inline-SVG chart (bar or line), built from
`chartToSVG` (server) / `chartToSvgStr` (client) — same rendering logic, duplicated
intentionally so the popup can render without waiting on the server.

## Local-only pipeline (Vercel constraint)

`POST /api/research/start` returns `503` on Vercel — the multi-round LLM pipeline routinely
exceeds serverless function timeouts, so a new research run must be started from the local
AEON server. The frontend has a browser-direct fallback path (`startResearch()` in
`index.jsx`) that runs a lighter 3-phase Groq+Gemini pipeline straight from the client when
`/api/research/start` isn't reachable, so research is still possible when only deployed to
Vercel — it just uses a shorter pipeline and writes its result straight to the Supabase
`research_library` mirror instead of local disk.

Reading is *not* Vercel-blocked: `GET /api/research/library` switches source automatically —
local JSON files under `WORKSPACE/deep_research/reports/` when running locally, the Supabase
mirror (`aeon_blocks` table, `block_tag = 'research_library'`) when `process.env.VERCEL` is set.

### The read-only-FS gotcha

The repo filesystem is read-only on Vercel and block data directories are vercelignored.
An unguarded `fs.mkdirSync` for the reports directory previously crashed the whole router
factory at boot, 404ing every `/research` route on the web. The fix (still in place, verified
during this pass — do not remove):

```js
const isVercel = !!process.env.VERCEL;
const RESEARCH_DIR = getDataFile
  ? getDataFile('deep_research/reports')
  : (isVercel ? path.join('/tmp', 'deep_research') : path.join(__dirname, '../../data'));
try { if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true }); } catch {}
```

`getDataFile` (kernel-provided) resolves from the repo root and namespaces by block id, so the
directory-depth miscalculation that originally caused this (a hardcoded `../../data` from
`src/blocks/deep_research/api/` resolves to `src/blocks/data/`, a sibling block folder, not
`src/blocks/deep_research/data/`) can't recur. The raw `path.join(__dirname, '../../data')` and
`/tmp` branches only fire if `getDataFile` is ever absent from `deps`.

## LLM provider timeout gotcha

Every provider path in `services/ai.js` defaults to a 4096-token output cap and a shared
default fetch timeout when no override is passed. This block passes `max_tokens` explicitly
on every `llm()` call (default 4096, `8192` for the report write) and `timeout_ms: 300000` on
the report-write call specifically — the multi-section report plus references routinely runs
past the defaults and would otherwise throw mid-generation instead of truncating. If you add a
new LLM call in this block, pass explicit `max_tokens` (and `timeout_ms` if it's a long-form
generation) rather than relying on the provider defaults.

## API routes (mounted under `/api/research/*` and `/api/research-adjacent` paths)

| Method | Path | Purpose |
|---|---|---|
| GET | `/research/active` | List currently-running in-memory jobs |
| GET | `/research/status/:sessionId` | Poll status/progress for a job |
| POST | `/research/cancel/:sessionId` | Cancel a running job |
| POST | `/research/result/:sessionId` | Get result and clear it from memory |
| POST | `/research/result-peek/:sessionId` | Get result without clearing it |
| GET | `/research/report/:sessionId` | Server-rendered HTML report |
| GET | `/research/library` | List completed research (disk locally, Supabase mirror on Vercel) |
| GET | `/research/detail/:sessionId` | Raw JSON for one saved research run |
| POST | `/research/:sessionId/archive` | Archive/unarchive a saved run (`?archived=true\|false`) |
| DELETE | `/research/:sessionId` | Delete a saved run from disk |
| POST | `/research/:sessionId/hide-image` | Hide an image URL from a report |
| POST | `/research/:sessionId/unhide-images` | Clear all hidden images for a report |
| POST | `/research/start` | Launch a new research job (503 on Vercel, see above) |
| GET | `/research/stream/:sessionId` | SSE progress stream |
| GET | `/research/search/providers` | List available web-search providers + key status |
| POST | `/research/search` | Standalone one-off web search (no report generation) |

`session_id` is validated against `^[a-zA-Z0-9-]{1,128}$` on every route that takes one.

### `/scrape` command (contract.commands)

```json
{ "cmd": "/scrape", "desc": "Scrape a URL via Orion", "method": "POST", "route": "/api/orion-scrape", "param": "url", "mode": "instant" }
```

This delegates to the **Orion Search** block's own route (`src/blocks/orion_search/api/orion.cjs`),
not a route owned by Deep Research — it's exposed here as a terminal command shortcut only.

### Frontend calls into other blocks/kernel routes (not owned by this block)

`index.jsx`'s browser-direct fallback pipeline calls `/api/search-web` (Vercel Edge Function,
routed via `vercel.json` → `api/search-web.js`), `/api/orion-scrape` (Orion Search block), and
`/api/ai` (kernel LLM route) — all confirmed live elsewhere in the repo, not orphaned calls.

## Config keys / dependencies

Declared in `block.manifest.json`:

- **APIs**: `groq` (primary research-role LLM, via `kernelLLM({ role: 'research' })`),
  `gemini` (fallback when `kernelLLM` isn't wired, via `geminiRequest`), `supabase`
  (Vercel-side library mirror read).
- **Env vars**: `GROQ_API_KEY`, `GEMINI_FREE_KEY_1`, `GEMINI_PAID_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`.
- **Optional search-provider keys** (checked at runtime, not required — DuckDuckGo is the
  free no-key fallback): `BRAVE_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`.

`contract.permissions`: `filesystem: write` (persists/reads/deletes JSON report files under
the block's data dir), `network: external` (web search + scraping), `secrets: true` (reads the
above API keys), `shell: true` (the router imports `child_process.spawn`; currently unused in
the active LLM-driven pipeline — see note in `api/index.cjs` about the prior Python-subprocess
design this replaced), `ai: true`.

## Data model

Each completed run is stored as `{RESEARCH_DIR}/{sessionId}.json`:

```
{ query, original_query?, query_corrected, category, result, sources[], raw_findings[],
  charts[], status, started_at, completed_at, stats: { Duration, Rounds, Sources },
  archived?, hidden_images? }
```
