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

1. **Status cards** — AEON server (ONLINE / SIGNED OUT / UNREACHABLE — it said
   "CLOUD MODE · Supabase relay" for every non-200 before 2026-09-23), LLM
   calls since the server started (with failures), configured providers
   healthy (unconfigured ones are not counted), and the video autopilot.
2. **Provider health & key pools** — one row per provider: *Healthy*,
   *Cooling down — retry in Ns* with the reason, or greyed *Not configured*
   (unconfigured providers used to be drawn red "cooling down"). Configured
   endpoints from `/api/connections` that the kernel's health map has not
   seen fail yet are merged in as healthy (the kernel lists only
   groq/gemini/local/openrouter plus providers with a failure).
3. **LLM engine telemetry** — per-model breakdown (engine, requests, tokens,
   average latency, error count) sourced from the kernel's in-memory
   telemetry counters.
4. **This machine — model fit** — CPU/RAM/GPU and how many of the hwfit
   catalogue models fit at Q4 (GPU / offload / CPU / too large), from
   `/api/hwfit/models` — the same routes Cookbook uses.
5. **VP missions — recent** — the last N Mission Runner (`/vp`) runs, read
   directly from the Vault filesystem. Click a row (or focus it and press
   Enter/Space) to expand the mission's full markdown log.

## Data sources (frontend fetches)

| Fetch | Owner | Notes |
|---|---|---|
| `GET /api/llm-telemetry` | kernel (`src/kernel/routers/telemetry.cjs`, aliased from `/core/telemetry`) | LLM call counts, tokens, per-model stats, server uptime |
| `GET /core/provider-health` | kernel (`src/kernel/routers/core.cjs`) | per-provider healthy/cooldown state + key pool sizes |
| `GET /api/autopilot/status` | `tools/autopilot-daemon.cjs` | video autopilot status (YouTube producer/uploader; start/stop routes exist but no UI calls them) |
| `GET /api/connections` | `settings` block | configured endpoints, merged into provider rows (optional) |
| `GET /api/hwfit/models` | this block (`api/hwfit.cjs`) | hardware + model fit for the "This machine" panel |
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
  `GET /hwfit/fit` (become `/api/hwfit/*`). Fits are ranked against total
  RAM (`ranking_basis_gb`); until 2026-09-23 they used os.freemem() whenever
  it was non-zero, so the verdict flipped minute to minute on macOS.
  Cookbook declares `requires.blocks: ["fleet_control"]` for these routes.
- **`api/local-status.js`** — reports whether the bundled local runtime and a
  ready model are available. (An earlier status probe for a system-wide model
  daemon was deleted with that dependency, but this file kept documenting it —
  docs/ sat outside every scanner until 2026-08-01.)
- **`api/telemetry.js`** — **retired 2026-09-23** (Bible §21). It registered
  `ALL /api/telemetry`, a path the `activity` block owns for GET, so it only
  ever answered POST/PUT/DELETE — with a zeroed placeholder roster
  (`qwen`/`zenith`/…) fetched from a GAS Hub nothing configures. Nothing
  called those methods. `tests/route-collisions.test.js` keeps it out.

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
- `network: "external"` — no file in this block makes an outbound call since
  `api/telemetry.js` (GAS Hub) was retired; kept until the manifest pass
  re-derives it.
- `shell: true` — `api/hwfit.cjs` runs `nvidia-smi` via `execFile` with an
  argument array for GPU detection.
- `ai: false` — no file in this block calls `kernelLLM`/`geminiRequest`/
  `groqRequest`; it only *displays* telemetry that other parts of the kernel
  produce.

This block does **not** use Supabase — mission history is read from the
Vault filesystem, not a database. `contract.requires.apis`/`env` were
previously left over from an older Supabase-backed design and made the
block report `ready: false` for a dependency it never actually calls; both
are now empty. No env var is read by this block's code since `api/telemetry.js` (the only
reader of `VITE_GAS_URL`) was retired.

## Files

- `index.jsx` — main UI (status cards, provider health, engine telemetry, hardware fit, VP missions)
- `health.js` — pure wording for the server card, provider rows/card and hardware summary
- `api/missions.cjs` — VP mission history reader (Vault-backed)
- `api/hwfit.cjs` — hardware detection + model fit ranking
- `api/local-status.js` — local runtime readiness probe
- `block.manifest.json` — kernel metadata, auto-normalized on every boot

## Activation

Auto-detected by the AEON kernel's block host on boot/rescan — no manual
registration needed. Drop this folder into `src/blocks/` and it mounts
itself.
