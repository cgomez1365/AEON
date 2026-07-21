# 🧬 Master — the canonical block

Every new block starts as a copy of this folder. This README is written so a
new block builder — human or automated — can read **only this file** and
correctly build a working block. If something here disagrees with the code,
the code wins and this file is out of date; fix the file.

## Anatomy of a block

| File | Purpose |
|---|---|
| `block.manifest.json` | Identity + contract. The kernel knows nothing about your block that isn't written here — see field reference below. |
| `index.jsx` | The UI. Default-export one React component. Use the aurora primitives (`Card`, `StatCard`, `Button`, …) from `src/components/aurora` so the block matches the rest of the app for free. |
| `api/<id>.cjs` | Optional backend. `module.exports = (deps) => router` (see "Router pattern" below). Only needed if your block has server-side logic; a pure-UI block can omit `api/` entirely (set `api_routes: false`, `provides.api: false`). |
| `README.md` | This file. What the block owns, what it reads, what it writes, and why. |

## To create a block

1. Copy `src/blocks/master/` → `src/blocks/<your_block_name>/`
   (the folder name IS the displayed name: `deal_finder` → "Deal Finder").
2. Edit `block.manifest.json`: set `id` to match the new folder name exactly,
   `route`, `description`, `nav.group`/`nav.order`, and — most importantly —
   `contract.permissions` to the *minimum* your block actually needs (see
   Permissions below; the sandbox silently strips anything you didn't ask for).
3. Replace `index.jsx` with your UI (keep using the aurora primitives and the
   accessibility patterns demonstrated below).
4. If you need a backend, rename `api/master.cjs` → `api/<your_block_name>.cjs`
   and change the routes inside it; the kernel auto-mounts anything in `api/`.
5. Restart the server. The block appears in nav, in `/blocks/registry`, and
   (if it declares AI usage) in Settings' AI Model Assignments panel.
6. Before shipping: run `node tools/aeon-cli.cjs lint <your_block_name>` and
   fix everything it flags. See "Self-test before you ship" below.

## block.manifest.json — every field, explained

The manifest is normalized on boot by `src/kernel/blockStandard.cjs`
(`normalizeManifest`), which fills in defaults for anything you omit and
heals a few legacy shapes. The frozen JSON-Schema is
`src/kernel/schema.json` (manifestVersion `1.0.0`) — see
`src/kernel/MIGRATION_POLICY.md` before adding a field that isn't in it.

### Identity

| Field | Meaning |
|---|---|
| `manifestVersion` | Schema version this manifest conforms to. Leave at `"1.0.0"` — absent is grandfathered to the same thing. |
| `id` | **Must equal the folder name** (`^[a-z0-9_]+$`). This is how the kernel finds your API file, your `.aeon.runtime.json`, and your entry in `_blockRegistry`. |
| `label` | Display name. Convention: derived from the folder (`my_block` → "My Block") — see Rule 1 below. Set explicitly here so the derivation and the manifest agree. |
| `icon` | A single emoji, shown in nav and the block registry. No image files — emoji only, so it renders identically everywhere with zero asset pipeline. |
| `route` | The URL path the block mounts at in the SPA. Leading slash, matches the folder (`/master`). |
| `description` | One sentence. Shown on the block's registry/store card and read by the AI model when it reasons about what a block does — write it for a reader who has never opened the folder. |
| `category` | Loose grouping tag (`system`, `tools`, `core`, `intelligence`, …). Informational only today. |
| `tier` | Trust level. Must be one of `core \| plugin \| experimental \| unknown` (enforced by `schema.json`'s enum — anything else, e.g. the old `"block"` value this file used to ship with, is invalid). `core` = ships with AEON and is assumed always installed; `plugin` = optional; `experimental` = may break. |
| `version` | **Your block's own semver**, bumped by you on every change that matters. Independent of `manifestVersion` (the schema version) and independent of AEON's own release version. |

### Navigation

| Field | Meaning |
|---|---|
| `nav.group` | Sidebar section this block's nav link lives under (`system`, `tools`, …). |
| `nav.order` | Sort position within the group, lowest first. |
| `nav.label` / `nav.icon` | Usually identical to the top-level `label`/`icon` — kept as a sibling because the normalizer may pin a canonical nav entry that differs from a stale manifest. |
| `nav.hidden` | `true` keeps the block mounted (routes/API still work) but out of the sidebar — used by `_template` and `_blank`, not typically by a real block. |

### Widget — the dashboard quick-view card

```json
"widget": {
  "endpoint": "/api/master/widget",
  "label": "Master",
  "refresh_ms": 30000
}
```

| Field | Meaning |
|---|---|
| `widget.endpoint` | A `GET` route (mounted under `/api/…` — see Routing below) that returns a small JSON payload. Must exist in your `api/<id>.cjs` — nothing calls a widget endpoint that isn't real. |
| `widget.label` | Fallback title for the card if the endpoint response doesn't include its own `label`. |
| `widget.refresh_ms` | How often the dashboard polls the endpoint, in milliseconds. Pick something proportional to how often the underlying data actually changes — don't poll a value that updates once a day every 5 seconds. |

The endpoint itself returns one of a small set of shapes the dashboard knows
how to render (the "weather-app-widget" model):

```json
{ "label": "Blocks", "kind": "stat", "value": 14, "sub": "installed cartridges" }
```

`kind` is `"stat"` (a single number/label), `"list"` (with an `items: []`
array), or `"sparkline"` (with a `series: []` array of numbers). This block's
`GET /api/master/widget` (in `api/master.cjs`) is a live, working example of
the `stat` shape — copy it verbatim and swap the value you're reporting.

**A block does not have to declare a widget.** Omit the whole `widget` key
if there's nothing worth a quick-view card; the dashboard simply skips you.

### Requires / Provides — readiness and discovery

| Field | Meaning |
|---|---|
| `requires.apis` | External provider ids this block needs configured (`"supabase"`, `"groq"`, …) before it's "ready". Drives `checkReadiness()` — missing ones show the block as not-ready in the registry, they don't block it from mounting. |
| `requires.env` | Env var names needed. If you list `requires.apis`, common vars are auto-derived; list here only what's block-specific. |
| `requires.local` | Local files/desktop artifacts the block expects (rare — mostly legacy integrations). |
| `requires.blocks` | Other block ids this one depends on. Mirrored into top-level `dependencies`. |
| `provides.routes` | Always `true` if the block mounts routes (it does, by having a `route`). |
| `provides.api` | `true` if `api/` exists and is auto-mounted. Matches `api_routes`. |
| `provides.models` | Data model/shape names this block exposes for other blocks to consume, if any. Usually `[]`. |
| `api_routes` | Top-level convenience flag mirroring `provides.api` — `true` means the loader mounts everything under `api/`. |

### contract — the intelligence layer (v3 shape, kept for compatibility)

This whole `contract` object is the original v2/v3 block contract. It's
still the one Settings, the sandbox, and the Neural Terminal read for
permissions/storage/AI metadata — don't treat it as deprecated even though
newer sibling fields (`ai`, `storage` at the top level — see below) also
exist.

- **`contract.inputs` / `contract.outputs` / `contract.events`** — data
  types this block accepts, produces, and emits for other blocks to
  subscribe to. Usually `[]` unless you're building real cross-block wiring.

- **`contract.permissions`** — THE security declaration. In `mountBlocks()`,
  every block gets a *scoped copy* of the shared server deps
  (`createScopedDeps` in `server.cjs`) — permissions here decide what's in
  that copy:

  | Key | Values | What happens if false/none |
  |---|---|---|
  | `filesystem` | `none \| read \| write` | `"none"` strips `deps.WORKSPACE` and `deps.ALLOWED_ROOTS` — your API can't touch the filesystem at all. |
  | `network` | `none \| internal \| external` | Informational today; `"external"` documents that the block calls out to third-party APIs. |
  | `secrets` | boolean | `false` strips `deps.GEMINI_KEY_POOL` — no vault key access. |
  | `shell` | boolean | `false` strips `deps.requireShellAuth`, `deps.SAFE_EXEC_PREFIXES`, `deps.INSTANT_PATTERNS` — no shell execution path. |
  | `ai` | boolean | `false` strips `deps.kernelLLM`, `deps.geminiRequest`, `deps.groqRequest`, `deps.ollamaRequest` — your API literally cannot call an LLM. |

  The sandbox is **warn-only** (a denied access logs `[SANDBOX] Block "<id>"
  accessed denied dep: <name>` instead of crashing), so a wrong permission
  fails loud in the console, not in production. Still: **ask for nothing
  extra** (Rule 4) — set every permission to the minimum this block needs.
  Master itself asks for nothing: `filesystem: "none"`, `secrets: false`,
  `shell: false`, `ai: false` — it only reads the in-memory block registry.

- **`contract.storage`** — `{ type: "json"|"sqlite"|"supabase"|"firebase"|"none", scope: "block"|"shared"|"global" }`.
  `type` is *how* you persist data, `scope` is *who else can see it*
  (`"block"` = only you, `"shared"`/`"global"` = other blocks can read it too).

- **`contract.ai`** — what this block does with AI. The base shape:

  ```json
  "ai": {
    "canGenerate": false,
    "canAnalyze": false,
    "canAutomate": false,
    "roles": []
  }
  ```

  `canGenerate`/`canAnalyze`/`canAutomate` are capability flags (documentation
  only today — nothing in the kernel gates on them yet). `roles` (plural) is
  a free-form list of which `kernelLLM` role strings this block's code calls
  with (`["chat", "research"]`, etc.) — also documentation.

  **`role` (singular) and `blurb` are a separate, *live* convention** — not
  part of the base shape above, but added as siblings by six real blocks
  (`aeon_matrix`, `ats_engine`, `council`, `dashboard`, `deep_research`,
  `memory_core`) and genuinely read by Settings:

  ```json
  "ai": {
    "canGenerate": false, "canAnalyze": false, "canAutomate": false, "roles": [],
    "role": "chat",
    "blurb": "Reference block — demonstrates the role/blurb shape; makes no live AI calls"
  }
  ```

  - `role` must be one of the role keys configured in Settings → Models
    (`chat`, `grading`, `research`, `creative`, `agent_*`, …) — whichever
    role your block's `kernelLLM(..., { role })` calls actually use.
  - `blurb` is a one-line, user-facing description of *what the AI does for
    this block* (not a restatement of `description`) — shown directly under
    the block's name in Settings.
  - **Consumer**: `src/blocks/settings/index.jsx`'s `BlocksNeedsPanel`
    (search `contract?.ai?.role` and `contract.ai.blurb`) filters the block
    registry to `blocks.filter(b => b.contract?.ai?.role)` and renders one
    row per match — a live "which model powers this block" panel with an
    SCI (Settings Confidence Index) readiness badge. `GET
    /api/settings/export-bundle` also reads `contract.ai.role` to compute
    which provider keys a client deployment needs.
  - **Only declare a real `role` if your block actually calls `kernelLLM`
    with it.** Declaring one registers the block as an AI consumer in a
    live UI panel (and in the export bundle) — a block that doesn't call
    `kernelLLM` but declares a role will show up there anyway, misleadingly.
    Master's own value above is a deliberate exception: it exists so this
    reference manifest shows the exact live shape a copier should use, and
    the `blurb` says so in plain text. **If you copy this folder and your
    block does not call `kernelLLM`, delete the `role` and `blurb` keys
    entirely** (keep the base `canGenerate`/`canAnalyze`/`canAutomate`/`roles`
    shape). If it does call `kernelLLM`, keep the two keys and write a real
    `blurb`.

- **`contract.targets`** — `{ local, vercel, docker, cloudflare }` booleans,
  which deployment targets this block functions on. Set `vercel: false` (etc.)
  if the block needs something (a persistent filesystem, a long-lived
  process) that target can't provide.

- **`contract.commands`** — slash-commands this block registers in the
  Neural Terminal:

  ```json
  { "cmd": "/blocks", "desc": "List every installed block and its readiness",
    "method": "GET", "route": "/api/master/registry", "mode": "instant", "display": "text" }
  ```

  `route` must be a real endpoint your `api/<id>.cjs` serves. `mode:
  "instant"` means the terminal calls it directly without going through an
  LLM turn; `display` tells the terminal how to render the response
  (`"text"`, or other renderers the terminal supports).

- **`contract.settings_keys`** — flat list of settings keys this block reads
  from `aeon-settings.json` (for the Neural Terminal / AI to know what's
  configurable). Usually redundant with `contract.settings` below; kept
  separate for blocks with settings that predate the declarative form.

- **`contract.settings`** — declarative settings controls, auto-rendered by
  the Settings block's **Blocks** tab (install the block → controls appear;
  remove it → controls vanish):

  ```json
  { "key": "widget_enabled", "label": "Dashboard widget",
    "desc": "Show this block's quick-view card on the dashboard",
    "type": "toggle", "default": true }
  ```

  `type` is one of `toggle | text | secret | select | number`. Values persist
  at `aeon-settings.json → blockSettings.<id>.<key>`. Read them:
  - **Server**: `deps.loadSettings().blockSettings?.<id>` or
    `GET /api/settings/block/<id>` (defaults merged in).
  - **UI**: `fetch('/api/settings/block/<id>')` → `{ values }`.

### Routing

```json
"routes": [ { "method": "ALL", "path": "/master/*", "auth": true } ]
```

Declares the route table for the block's mounted API, mainly for
documentation/audit — the actual mount happens because `api/<id>.cjs`
exists (see "Router pattern" below). `auth: true` means requests need a
valid session/bearer token (the normal case for anything not explicitly
public).

### env

Flat list of environment variable names this block needs present. If
`requires.apis` already implies some (via the kernel's known API → env-var
map), you don't need to repeat them here; list block-specific ones only.

### ai / storage (top-level) — the v4 sibling fields

```json
"ai": { "capabilities": [], "canGenerate": false, "canAnalyze": false, "canAutomate": false },
"storage": { "provider": "json", "tables": [], "scope": "block" }
```

These look like duplicates of `contract.ai` / `contract.storage` because
they are, historically: `contract.*` is the frozen v2/v3 shape, and `ai` /
`storage` at the manifest's top level are v4 "diagram-spec enrichment"
fields added as **siblings**, not replacements, when the manifest schema
grew (see `blockStandard.cjs`'s `normalizeManifest`). The normalizer
derives these top-level ones from the `contract.*` versions if you don't
set them explicitly. In practice: **set the real values inside
`contract.ai`/`contract.storage`** (that's what the sandbox and Settings
actually read); the top-level siblings mostly exist for tooling that wants
a flatter shape and will inherit correct values automatically.

### dependencies / deployment

| Field | Meaning |
|---|---|
| `dependencies` | Other block ids this one needs installed. Mirrors `requires.blocks` if you don't set it separately. |
| `deployment.target` | Where this block is meant to run: `"any"` (works everywhere — master's value), `"universal"`, `"local_required"` (needs the desktop/local filesystem — Vercel deploys will show it not-ready), `"local"`. |
| `deployment.runtime` | Execution runtime hint. Common values in this codebase: `"any"` (most blocks), `"nodejs"` (this block, `_template`, `memory_core`, `aeon_matrix`, `host_os` — signals real Node-only API usage), `"edge"`. **Always an object** — never the legacy bare-string `deployment: "universal"` form some very old manifests used; the normalizer coerces that, but new manifests should always use the object form. |

## Router pattern — this block's API

`api/master.cjs` demonstrates the standard factory signature every block's
backend uses:

```js
module.exports = (deps) => {
  const router = express.Router();
  router.get('/master/widget', (req, res) => { /* ... */ });
  return router;
};
```

The kernel calls this factory with a scoped `deps` object (see Permissions
above) and dual-mounts the returned router at both `/block/<folder>` and
`/api` — so a route registered as `/master/widget` inside the router answers
at `/api/master/widget` (and `/block/master/master/widget`, the less-used
alias). Always prefix your own routes with your block id
(`/master/widget`, not `/widget`) so they don't collide with another
block's routes once both are mounted under the shared `/api` prefix.

## Fetching from your UI — relative paths only

Every `fetch()` call in `index.jsx` must be a relative path
(`fetch('/blocks/registry')`, never `fetch('http://localhost:3001/...')`).
Vite's dev server proxies `/api`, `/core`, `/blocks`, `/events`, `/ws` to the
kernel; every deployed target (Vercel, Docker, a bare `node server.cjs`)
serves the frontend and the API from the same origin. A hardcoded host or
port only works on one developer's machine and silently breaks everywhere
else — this is why "delete this folder, clone fresh, `npm install`, it just
works" is a real requirement, not an aspiration.

The same rule applies to any *display text* that mentions where the app is
running — read `window.location.host` at render time instead of writing a
literal `"localhost:3001"` string (this block's `index.jsx` does exactly
that for its "Kernel: ONLINE — <host>" stat card).

Before calling an endpoint from your block's UI, confirm it's one of:
- a route your own `api/<id>.cjs` defines,
- or a kernel-guaranteed route: `/core/state`, `/core/health`, `/core/scan`,
  `/core/telemetry`, `/api/ai`, `/blocks/registry`, `/events`, `/ws`,
  `/api/settings/*`, `/api/prefs/*`, `/api/chat`, `/api/audit`.

Never fetch an endpoint that doesn't exist in either list — "never call what
does not exist" is Rule 2 below, and it's the single most common way a
copied block silently breaks in production while looking fine in dev.

## Accessibility patterns demonstrated in index.jsx

This block's UI is read-only "living docs" (no forms, but it does have one
icon-only control), so it's a compact demonstration of the four checks every
block's UI should pass:

- **Icon-only buttons** get `aria-label` (the refresh control next to
  "INSTALLED CARTRIDGES") — the accessible name comes entirely from the
  label since there's no visible text next to the icon.
- **Decorative icons next to visible text** (the header icons, the rule
  numbers) get `aria-hidden="true"` so a screen reader doesn't announce the
  glyph a second time after the adjacent text.
- **Section headers are real `<h3>` elements**, not styled `<div>`s, so
  screen-reader heading-navigation can jump straight to a section.
- **Repeated groups render as `<ul role="list">`/`<li>`** — `role="list"` is
  required because `list-style: none` strips implicit list semantics in
  Safari/VoiceOver.
- **Async-loaded values sit in an `aria-live="polite"` region** (the two
  stat cards) so a screen reader announces the kernel-status/registry-count
  update instead of staying silent forever after the first paint.
- **No `outline: none` without a replacement.** The refresh button keeps the
  browser's default focus ring — WCAG 2.4.7. If you ever do need a custom
  focus style, replace it with an equally visible one; never just delete it.
- Text inputs need an associated `<label>` or `aria-label` and images need
  `alt` text — this block has neither (no inputs, no `<img>`), but see
  `src/blocks/ats_engine/index.jsx` or `src/blocks/deep_research/index.jsx`
  for live examples of both if your block adds a form.

## Using kernelLLM in your block API

Every block gets `deps.kernelLLM` injected (unless `contract.permissions.ai`
is `false`, in which case it's stripped — see Permissions above). The engine
is provider-agnostic — your block works the same on Ollama, Groq, Gemini,
OpenRouter, or Claude without any code changes.

```js
// Simple (backward compatible) — flat string prompt
const answer = await kernelLLM('Summarize this report', { role: 'research' });

// Multi-turn conversation — messages array
const answer = await kernelLLM(null, {
  role: 'grading',
  system: 'You are an expert recruiter. Grade only on job-relevant criteria.',
  messages: [
    { role: 'user', content: 'Here is the resume: ...' },
    { role: 'assistant', content: 'I need the job description to grade against.' },
    { role: 'user', content: 'Here is the JD: ...' },
  ],
});

// Provider transparency — know what actually answered
const { text, provider, model, fallback } = await kernelLLM('...', {
  role: 'chat',
  returnMeta: true,  // returns {text, provider, model, fallback} instead of string
});
if (fallback) console.warn(`Downgraded from configured provider to ${provider}/${model}`);
```

### opts reference

| Key | Type | What it does |
|-----|------|-------------|
| `role` | string | Routes to the model assigned in Settings (chat/grading/research/creative/agent_*). This is the *same* role vocabulary as `contract.ai.role` above — if you call `kernelLLM` with `role: 'chat'` somewhere in your API, declare `contract.ai.role: "chat"` in the manifest so Settings shows it. |
| `system` | string | System prompt — injected as system message. Overrides the default AEON identity. |
| `messages` | array | Multi-turn `[{role,content},...]` — replaces the flat prompt string |
| `returnMeta` | bool | Returns `{text, provider, model, fallback}` instead of plain string |
| `background` | bool | Skips the /allow-local gate (for autonomous/background tasks) |
| `max_tokens` | number | Cap output length (default 4096) |
| `provider` | string | Force a specific provider (bypasses role assignment) |
| `model` | string | Force a specific model |
| `advisorModel` | string | Claude-only: attach a stronger advisor model |

## Self-test before you ship

Run all three before opening a PR / before `aeon promote`:

```bash
node --check src/blocks/<id>/api/<id>.cjs        # syntax check the backend
node -e "JSON.parse(require('fs').readFileSync('src/blocks/<id>/block.manifest.json','utf8'))"  # manifest parses
node tools/aeon-cli.cjs lint <id>                # deterministic schema + code gate
```

`aeon lint` (see `tools/aeon-cli.cjs` and `src/kernel/staging.cjs`) resolves
`<id>` by checking `staging/<id>`, then `src/blocks/<id>`, then a literal
path — it reports a `score`, any hard `errors` (fail the gate), and softer
`findings` with a severity (`HIGH` also fails the gate). `aeon pack` refuses
to bundle a block that doesn't pass lint first — nothing reaches the store
without a clean gate.

## The four rules

1. **Folder is truth** — the displayed name is derived from the folder name
   (`my_block` → "My Block"). To rename a block, rename its folder.
2. **Never call what does not exist** — fetch only endpoints your own `api/`
   provides, or the kernel-guaranteed routes listed above.
3. **Declare a widget** — expose `GET /api/<id>/widget` + a manifest
   `widget` section, and the dashboard shows your quick-view automatically.
4. **Ask for nothing extra** — set `contract.permissions` minimally; the
   sandbox strips deps you didn't declare.

## Contracts this folder demonstrates

- **Manifest v4** — full schema with `nav`, `contract`, `commands`,
  `widget`, and the v4 sibling `ai`/`storage` enrichment fields.
- **Widget** — `GET /api/master/widget` + manifest `widget` section: the
  dashboard renders a quick-view card for any block that declares one.
- **`contract.ai.role`/`blurb`** — the live convention six real blocks use
  to appear in Settings' AI Model Assignments panel (see the dedicated
  section above for the exact shape and when to use it).
- **Router pattern** — `module.exports = (deps) => router` (factory, 1 arg).
- **Folder-is-truth naming** — display label derives from the folder name.
- **Relative-fetch-only networking** — no environment ever bakes in a host
  or port.
- **Accessible-by-default UI** — icon-only controls, decorative icons,
  heading structure, list semantics, live regions, and focus visibility all
  handled correctly in `index.jsx`.
