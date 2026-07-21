# Fleet Control

**ID:** `fleet_control`
**Route:** `/fleet`
**Tier:** `core`
**Nav group:** `agent`

Read-only ops dashboard for everything that runs in AEON: LLM engine telemetry,
provider health + key pool status, autopilot state, and VP mission history.
It reports what exists and never calls what doesn't — no writes, no mutating
API calls, nothing autonomous.

## What it shows

The UI (`index.jsx`) polls every 8 seconds and renders four panels:

1. **Status cards** — AEON server reachability (online vs. cloud/relay mode),
   total LLM calls + tokens this session, provider health ratio, and
   autopilot status.
2. **Provider health & key pools** — one row per LLM provider (groq, gemini,
   ollama, ...) showing healthy/unhealthy state and, when available, how many
   API keys are in that provider's rotation pool and which slot is active.
3. **LLM engine telemetry** — per-model breakdown (engine, requests, tokens,
   average latency, error count) sourced from the kernel's in-memory
   telemetry counters.
4. **VP missions — recent** — the last N Mission Runner (`/vp`) runs, read
   directly from the Vault filesystem. Click a row (or focus it and press
   Enter/Space) to expand the mission's full markdown log.

## Data sources (frontend fetches)

| Fetch | Owner | Notes |
|---|---|---|
| `GET /api/llm-telemetry` | kernel (`src/kernel/routers/telemetry.cjs`, aliased from `/core/telemetry`) | LLM call counts, tokens, per-model stats, server uptime |
| `GET /core/provider-health` | kernel (`src/kernel/routers/core.cjs`) | per-provider healthy/cooldown state + key pool sizes |
| `GET /api/autopilot/status` | `tools/autopilot-daemon.cjs` | autopilot producer status |
| `GET /api/fleet/missions?limit=12` | this block (`api/missions.cjs`) | recent VP mission summaries |
| `GET /api/fleet/mission/:id` | this block (`api/missions.cjs`) | full markdown for one mission |

All four are wrapped in independent try/catch blocks in `index.jsx`, so a
down/missing endpoint degrades that one panel instead of breaking the page.

## API routes (this block)

Everything under `api/` is auto-mounted by the block host
(`src/kernel/blockHost.cjs`) and dual-mounted at both `/block/fleet_control/*`
and `/api/*` unless noted otherwise.

- **`api/missions.cjs`** — `(deps) => router` factory (arity-1 pattern).
  Exposes `GET /fleet/missions` and `GET /fleet/mission/:id`, which land at
  `/api/fleet/missions` and `/api/fleet/mission/:id` once mounted. Reads
  mission markdown files straight from `Vault/Agents/vp/missions` (via
  `deps.VAULT_ROOT`, falling back to a relative path under
  `aeon_matrix/data/Vault` if `VAULT_ROOT` isn't provided). The `agent_core`
  block that used to own `/api/agent/missions` was removed; this block reads
  the Vault files directly so the ops view survives that removal.
- **`api/hwfit.cjs`** — `createHwfitRouter(deps) => router`, same arity-1
  dual-mount pattern. Hardware Fitness: detects local CPU/RAM/GPU (via `os`
  and `nvidia-smi` through `child_process`), ranks a built-in model catalog
  against detected VRAM, and computes Quality/Balanced/Speed serve profiles.
  Routes: `GET /hwfit/system`, `GET /hwfit/models`, `GET /hwfit/profiles`,
  `GET /hwfit/fit` (become `/api/hwfit/*`). Not currently wired into the
  `index.jsx` UI — available for a future hardware panel.
- **`api/ollama-status.js`** — plugin pattern (`(app, deps) => {...}`,
  registers verbs directly, not dual-mounted). `GET/POST/PUT/DELETE/OPTIONS
  /api/ollama-status` — pings `OLLAMA_HOST` (default
  `http://localhost:11434`) for `/api/tags` and reports online state +
  available models, with `fallback: 'gemini'` when Ollama is unreachable.
- **`api/telemetry.js`** — plugin pattern, same as above. `GET/POST/PUT/
  DELETE/OPTIONS /api/telemetry` — fetches aggregate usage stats from the GAS
  Hub (`VITE_GAS_URL`) when configured, otherwise returns small placeholder
  numbers so the UI never crashes on an empty response.

### Mounting note

`api/missions.cjs` and `api/hwfit.cjs` both export a single-argument factory
`(deps) => router`. `blockHost.cjs`'s signature detection treats any
one-argument factory whose return value is a real Express router (its
`.name === 'router'`) as router-pattern and dual-mounts it — this is
correct and has been verified against the current `blockHost.cjs` (it is
**not** silently discarded; only zero/two-argument factories fall through to
the plugin-registration path).

## Permissions (contract.permissions)

- `filesystem: "read"` — `api/missions.cjs` reads Vault mission files only,
  never writes.
- `network: "external"` — `api/ollama-status.js` and `api/telemetry.js` both
  make outbound `fetch()` calls (Ollama host, GAS Hub).
- `secrets: true` — `api/ollama-status.js` reads `OLLAMA_SSH_KEY` from the
  environment and forwards it as a request header.
- `shell: true` — `api/hwfit.cjs` uses `child_process.exec`/`execSync`
  (`nvidia-smi`) for GPU detection.
- `ai: false` — no file in this block calls `kernelLLM`/`geminiRequest`/
  `groqRequest`/`ollamaRequest`; it only *displays* telemetry that other
  parts of the kernel produce.

This block does **not** use Supabase — mission history is read from the
Vault filesystem, not a database. `contract.requires.apis`/`env` were
previously left over from an older Supabase-backed design and made the
block report `ready: false` for a dependency it never actually calls; both
are now empty. The env vars actually referenced by this block's code
(`OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_SSH_KEY`, `VITE_GAS_URL`) are all
optional — every one of them has a safe in-code fallback, so none of them
gate readiness.

## Files

- `index.jsx` — main UI (status cards, provider health, engine telemetry, VP missions)
- `components/AgentTelemetry.jsx` — placeholder stub, not currently imported anywhere
- `api/missions.cjs` — VP mission history reader (Vault-backed)
- `api/hwfit.cjs` — hardware detection + model fit ranking (not yet wired into the UI)
- `api/ollama-status.js` — Ollama reachability probe
- `api/telemetry.js` — GAS Hub usage telemetry (Vercel-side fallback)
- `block.manifest.json` — kernel metadata, auto-normalized on every boot

## Activation

Auto-detected by the AEON kernel's block host on boot/rescan — no manual
registration needed. Drop this folder into `src/blocks/` and it mounts
itself.
