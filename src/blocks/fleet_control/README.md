# Fleet Control

**ID:** `fleet_control`
**Route:** `/fleet`
**Tier:** `core`
**Nav group:** `finance`, set by the kernel's nav map in `src/kernel/blockStandard.cjs`
(the sidebar labels that group Home, `src/kernel/blockRegistry.js`)

Read-only ops dashboard for everything that runs in AEON: LLM engine telemetry,
provider health, the video autopilot, this machine's model fit, and your agents
with what each was last asked. It reports what exists and never calls what
doesn't — every route it serves is a GET, and the panel only reads.

## What it shows

The UI (`index.jsx`) refreshes every 8 seconds (hardware fit is read once per
visit and on the refresh button) and renders five sections:

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
5. **Recent Agent Missions** — every agent from Memory Core's `GET /api/agents`:
   your own AEON first, then the others, most recently active first. Each row
   shows what the agent was last asked and when (the last entry of
   `Vault/Agents/<Folder>/missions/log.json`), or when it was last active, plus
   its memory count, its model if it has one, and a lock if it is Local only.
   A click loads the agent into the Neural Terminal (`aeon:agent-select`). With
   Memory Core not installed, the section says so instead of showing a list.

## What it reads

| Source | Served by | Used for |
|---|---|---|
| `GET /api/llm-telemetry` | kernel | server status card, calls, telemetry table |
| `GET /core/provider-health` | kernel | provider card and rows |
| `GET /api/connections` | Settings | configured providers not yet seen by the health map |
| `GET /api/autopilot/status` | `tools/autopilot-daemon.cjs` | video autopilot card |
| `GET /api/agents` | Memory Core | Recent Agent Missions |
| `GET /api/hwfit/models` | this block | model fit |

## Routes this block serves

All GET, all behind the auth gate (`block.manifest.json`):

- `/api/hwfit/system`, `/api/hwfit/models`, `/api/hwfit/profiles`,
  `/api/hwfit/fit` (`api/hwfit.cjs`) — read by this panel and by Cookbook's
  What Fits tab.
- `/api/local-status` (`api/local-status.js`) — the local runtime's state.
- `/api/fleet/missions` and `/api/fleet/mission/:id` (`api/missions.cjs`) — the
  older mission files, `Vault/Agents/Aeon/missions/*.md`. The panel no longer
  calls these; its mission list comes from `/api/agents`.
