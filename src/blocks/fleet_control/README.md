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
5. **Recent agent missions** — every agent (Memory Core, `GET /api/agents`), most recently active first,
   with what it was last asked (`Vault/Agents/<Folder>/missions/log.json`). A click loads the agent
   into the Neural Terminal (`aeon:agent-select`).