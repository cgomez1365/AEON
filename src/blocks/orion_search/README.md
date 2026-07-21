# 🔭 AEON Block: Orion Search

**ID:** `orion_search`
**Route:** `/orion`
**Tier:** `core`
**Status:** `ACTIVE`

Unified search: one query fans out **in parallel** to the web, the Second
Brain (RAG vault), and the live block registry, and comes back as a single
ranked list where every hit is tagged with its source. No new search
provider of its own — it's a thin fan-out/merge layer over engines that
already exist elsewhere in AEON.

## Files
- `index.jsx` — the search UI. A single input + Enter/click to run; a
  per-source filter row (`WEB` / `BRAIN` / `BLOCK` toggle chips) that hides
  results client-side without re-querying; a depth selector (`8` / `16` /
  `24`, sent to the API as `k`); a "recent searches" chip list (client-only,
  see *Storage*); and a results list with color-coded source badges
  (cyan/green/amber) and per-result excerpts.
- `api/orion.cjs` — the block's only route. `POST /orion/search` (dual-
  mounted by the block host, so the real reachable path is
  `POST /api/orion/search`) takes `{ query, k? }`, fires the three lookups
  below with `Promise.all`, normalizes each engine's own response shape into
  one flat `{ title, url, excerpt, source, score? }[]`, and returns
  `{ ok, query, counts: { web, brain, block }, results }`.
- `block.manifest.json` — kernel contract (permissions, requires, routes,
  the `/orion` terminal command).
- `.aeon.runtime.json` — **auto-generated on every boot** by the kernel
  (`src/kernel/blockStandard.cjs`). Do not hand-edit; it's overwritten.

## API routes

### This block
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/orion/search` | Body `{ query, k? }` (`k` defaults to 5, UI sends 8/16/24). Returns `{ ok, query, counts, results }`. `results[].source` is `"web"`, `"brain"`, or `"block"`. |

### What it calls (not this block's own code — verified live/reachable)
| Call | Defined in | Notes |
|---|---|---|
| `GET /api/search-web?q=` | `services/search.js`, mounted at `app.use('/api', search.router)` in `server/server.js` | Provider chain `Tavily → Serper → Brave → DuckDuckGo` (first configured API key wins; DuckDuckGo needs none). Response `.results` is a **markdown string** (`"- **Title**\n  snippet\n  Source: [x](url)"` blocks); `orion.cjs` regex-parses it back into `{title,url,excerpt}`. Also has a Vercel Edge Function mirror at `/api/search-web.js` (see `vercel.json` rewrites) — same path, different runtime, both land in the same shape. |
| `POST /api/crn/second-brain/retrieve` | `src/blocks/aeon_matrix/api/retrieve.cjs` (dual-mounted like this block, so it resolves under `/api` too) | Body `{ query, k }` → `{ documents: [{ id, content, similarity, metadata: { source, ... } }], count }`. `orion.cjs` maps `metadata.source → title`, `id → url` (a vault-relative file path, not a URL), `content → excerpt`, `similarity → score` — this is the field mapping that broke once before; **verified correct against retrieve.cjs's actual output shape** in this pass. No LLM call, no recall-intent gate on this path (the block-namespaced route is ungated by design; the gate lives in `dashboard/api/chat.cjs`'s separate `/api/search` caller). |
| `getBlockBriefs()` | `src/kernel/blockAwareness.cjs`, required directly (`../../../kernel/blockAwareness.cjs`) | In-process, synchronous, no HTTP hop. Reads every `block.manifest.json` under `src/blocks/*` and substring-matches `id`/`label`/`brief` against the lowercased query. |

### Terminal / agent entry point
`block.manifest.json`'s `contract.commands` declares `/orion` (`method: POST`,
`route: /api/orion/search`, `param: query`). Verified live: `NeuralTerminal.jsx`
builds a `blockCmdMap` from every block's `contract.commands` and dispatches
any typed `/cmd` that isn't a built-in against it (see its "BLOCK-DECLARED
COMMANDS" section) — no other block declares `/orion`, so there's no
collision, and the built-ins above it in the dispatch chain don't intercept
it either. Typing `/orion <query>` in the terminal reaches this block's API
exactly the way the manifest claims.

Note: `/api/orion-scrape` (used by `dashboard/api/chat.cjs`'s `/scrape`
command and several `NeuralTerminal.jsx` research-agent flows) is a
**different, older feature** — a client-research web scraper, unrelated to
this block despite the shared "Orion" name. It does not call, and is not
called by, anything in this folder.

## Config / settings / env keys
None of this block's own. `requires.apis: []` / `requires.env: []` in the
manifest are accurate — `orion.cjs` holds no API keys and fails soft (empty
`results`, not an error) if a downstream engine has nothing configured. The
optional keys that make the web leg richer (`TAVILY_API_KEY`,
`SERPER_API_KEY`, `BRAVE_API_KEY`) belong to `services/search.js`, outside
this block; with none set, that leg still works via DuckDuckGo.

## Storage
`contract.storage.type` is `"none"`, which is accurate for the server side —
this block reads and writes nothing under its own folder. Search **history**
(last 12 queries, chip list shown when there are no active results) lives
**client-side only**, in the browser's `localStorage` under
`aeon_orion_history`. It is per-browser, not synced to any account, vault,
or server, and is wiped by clearing site data.

## Dependencies (injected via the `deps` factory argument)
- `api/orion.cjs`: `deps.isVercel` (added in this pass — see *Fixed in this
  pass*). Nothing else is read from `deps`; no `fs`, no `kernelLLM`, no
  secrets. The Second Brain and block-registry reads happen through their
  own HTTP call / direct `require`, not through injected deps.
- npm: only `express`, already a repo-wide dependency (not listed under
  manifest `dependencies`, matching the convention in every other block's
  manifest).

## Fixed in this pass
- **README** — didn't exist; this is it.
- **Hardcoded loopback host in `api/orion.cjs`** — the two self-fetch calls
  (`/api/search-web`, `/api/crn/second-brain/retrieve`) unconditionally
  built their base URL as `http://127.0.0.1:${PORT}`. That's correct for
  local dev (a long-lived Express listener on `PORT`), but the manifest also
  claims `contract.targets.vercel: true` / `deployment.target: "universal"`,
  and on Vercel each request is its own serverless invocation with **no**
  persistent loopback server to hit — that call would have failed outright
  in production. Fixed by computing the base URL per-request:
  `deps.isVercel && req.headers.host ? \`https://${req.headers.host}\` : \`http://127.0.0.1:${PORT}\``,
  the same host-swap pattern already used by `src/blocks/dashboard/api/chat.cjs`
  for its own `/api/orion-scrape` and `/api/crn/second-brain/retrieve` calls.
  `deps.isVercel` is populated from `server/server.js`'s `baseDeps` and
  survives the block sandbox (`createScopedDeps` in `server/block-loader.js`
  only strips deps tied to `contract.permissions`; `isVercel` isn't one of
  them), so no manifest change was needed to unblock this.
- **Route/response-shape audit** — confirmed `/api/search-web`,
  `/api/crn/second-brain/retrieve`, and `blockAwareness.cjs`'s
  `getBlockBriefs()` are all real, live, reachable, and that the Second
  Brain field mapping (`documents[].{id,content,similarity,metadata.source}`)
  still matches what `retrieve.cjs` actually returns — see the API table
  above. No dead calls found.
- Accessibility pass on `index.jsx`:
  - Search input now has an associated (visually-hidden, `.sr-only`)
    `<label htmlFor>`; it previously relied on `placeholder` text alone,
    which isn't a real accessible name.
  - The icon-only search-submit button, the per-source filter chips, the
    depth-selector buttons, and the "clear history" button all got explicit
    `aria-label`s — none of them had a text alternative for their icon
    before.
  - Per-source filter chips and depth buttons are toggle/selection controls
    but exposed no state to assistive tech; both now carry `aria-pressed`,
    and each row is wrapped in `role="group"` with a group label.
  - Decorative icons that sit beside a visible text label (source chip
    icons, the result-row source icon, the "RECENT" history icon) now carry
    `aria-hidden="true"` so screen readers don't announce a redundant icon
    name next to text that already says the same thing.
  - `outline: none` on the input/buttons removed the default focus ring with
    nothing standing in for it. Added a shared `.orion-focusable` class and
    an injected `:focus-visible` rule (2px outline, `var(--accent)`) —
    same pattern used in `src/blocks/activity/index.jsx`'s heatmap cells —
    so keyboard users still get a visible focus indicator.
  - The error message now has `role="alert"`; a visually-hidden
    `aria-live="polite"` region announces "Searching…" / "N results shown."
    so screen reader users get the same loading/done signal sighted users
    get from the spinner and the results-count line.
  - The web-result `<a target="_blank">` now has an `aria-label` noting it
    opens in a new tab (it already visually opens one; screen reader users
    had no warning).

## Manifest honesty (verified, no changes needed)
- `contract.permissions`: `filesystem: "read"` (accurate —
  `getBlockBriefs()` reads every block manifest via `fs.readFileSync`),
  `network: "external"` (accurate — the web leg transitively reaches
  Tavily/Serper/Brave/DuckDuckGo), `secrets: false` / `shell: false` /
  `ai: false` (accurate — `orion.cjs` never touches `GEMINI_KEY_POOL`, shell
  exec, or `kernelLLM` directly). `requires.apis` / `requires.env` are
  correctly empty for the reason above. `dependencies: []` matches the
  house convention of not listing `express`.

## Known limitations (judgment calls, not fixed here)
- **Brain and block results aren't clickable links**, even though this
  block's own description and on-screen copy both say "every result carries
  a real link." Only `source: "web"` renders an `<a href>`; brain results
  show a vault-relative file path and block results show an in-app route
  (`b.route`) as plain text. Making either truly navigable (open the vault
  file, jump to that block) would mean wiring into this app's SPA
  navigation / file viewer, which lives outside `src/blocks/orion_search`
  — out of scope for a single-block pass, flagged instead of built.
- **Second Brain results will legitimately be empty on Vercel** — not a bug
  introduced or left here; `aeon_matrix/api/retrieve.cjs` documents that
  vault data is gitignored and not deployed to Vercel. This pass's host-swap
  fix makes the HTTP call itself succeed (reach the right host instead of
  failing to connect), but the response will still be `{ documents: [] }`
  there for that unrelated, pre-existing reason.
- **Source-badge color contrast** (`#00f2ff` / `#39ff14` / `#f59e0b` against
  theme background variables) wasn't measured against WCAG AA's 4.5:1 text
  ratio — doing that properly needs the live, resolved theme values, which
  a static code read can't give. Flagging for a follow-up if strict AA
  contrast sign-off is required.
- `/api/search-web` internally asks `kernelLLM` to synthesize a `.answer`
  field from the raw results (see `services/search.js`); `orion.cjs` never
  reads that field — it only parses the raw `.results` markdown. So no
  AI-generated text currently reaches this block's output, which is
  consistent with the manifest's `ai: false` / `canGenerate: false`, but
  worth knowing if a future change starts consuming `.answer`.
