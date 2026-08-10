# AEON Command Center — Architecture

## What Is This

AEON is a modular, offline-first AI operations portal. React + Vite frontend, Express backend, plugin block architecture. Runs locally with full OS access or on Vercel as a stateless cloud mirror.

## System Layers

```
┌─────────────────────────────────────┐
│         PLUGIN BLOCKS               │  ← Drop-in modules (src/blocks/*)
│  ATS, CRM, Trading, Research, etc.  │
├─────────────────────────────────────┤
│         SYSTEM SETTINGS             │  ← API keys, model-per-role config
├─────────────────────────────────────┤
│         ALWAYS-ON CORE              │  ← Dashboard, Fleet, Activity, Memory
├─────────────────────────────────────┤
│         AEON KERNEL                 │  ← Express router, block loader,
│  server.cjs + routes/*              │     LLM service layer, SDI validator
├─────────────────────────────────────┤
│    PROVIDERS                        │
│  Groq | Gemini | OpenAI | local     │  ← Cloud APIs + bundled llama.cpp
├─────────────────────────────────────┤
│    NEURAL TERMINAL                  │  ← User interface, slash commands
└─────────────────────────────────────┘
```

## How Blocks Work

Every block lives in `src/blocks/<block_id>/` and must contain:

- `index.jsx` — React component (the UI)
- `block.manifest.json` — Declares ID, route, deployment tag, dependencies
- `api/` (optional) — Express route handlers auto-loaded by the kernel

The kernel block loader (`server/block-loader.js`, wired from `server/server.js`) scans `src/blocks/*/` at boot, reads each `block.manifest.json`, and mounts any `api/*.js` files as Express routes. Frontend routing is in `DesktopLayout.jsx`.

### Adding a new block

1. Create folder: `src/blocks/my_block/`
2. Add `block.manifest.json` with required fields
3. Add `index.jsx` with a default export React component
4. (Optional) Add `api/my_routes.js` for backend endpoints
5. Add import + Route in `DesktopLayout.jsx`
6. Restart server

### Block manifest spec

```json
{
  "id": "my_block",
  "label": "My Block",
  "icon": "🔧",
  "route": "/my-block",
  "description": "What this block does in one line",
  "category": "tools",
  "deployment": "universal",
  "tier": "plugin",
  "requires": {
    "apis": ["groq"],
    "blocks": []
  },
  "api_routes": false,
  "version": "1.0.0"
}
```

**deployment** values:
- `universal` — Works on localhost and Vercel/cloud
- `local_required` — Needs OS access, hardware, or local services
- `hybrid` — Core features work on cloud, full features need local

**tier** values:
- `core` — Always present, cannot be removed
- `free` — Ships with base AEON, can be removed
- `plugin` — Installable add-on

## Kernel LLM Service Layer

Blocks should call the kernel LLM endpoint instead of specific providers:

```
POST /api/kernel/llm
{ "prompt": "...", "role": "grading" }
```

The kernel reads `aeon-settings.json` to determine which provider/model handles each role:
- `chat` → default conversational model
- `grading` → analytical model for scoring/evaluation
- `research` → model used for multi-step research
- `creative` → model for content generation

**Roulette mode**: When enabled, the kernel randomly picks between available free-tier providers to distribute rate limits.

**Failover chain**: Gemini → Groq → local runtime. If one provider 429s or errors, the next is tried automatically.

## Data Architecture

- **Supabase** — Source of truth for cloud sync (aeon_blocks, documents, candidates)
- **Firebase** — Treasury sync, real-time telemetry
- **Local JSON** — chat_log.json, audit_log.json, aeon-settings.json, brain-data.json
- **Google Apps Script** — Failsafe backup (not source of truth)

Every block that needs cloud sync follows the pattern: try local API → Supabase fallback.

## Key Files

| File | Purpose |
|------|---------|
| `server/server.js` | Express backend — the kernel composition root: routes, block loader, LLM functions |
| `server.cjs` | 12-line compatibility shim re-exporting `server/server.js` |
| `src/config.js` | Shared frontend config (WORKSPACE, SB_URL, SB_KEY from env) |
| `src/kernel/supabase.js` | Shared Supabase client |
| `.env` | All API keys and configuration (never committed) |
| `.env.example` | Template for new installations |
| `aeon-settings.json` | Runtime settings (model assignments, roulette toggle) |
| `src/kernel/schema.json` | JSON Schema for block.manifest.json — enforced by `staging.cjs validateManifest()` |
| `launch-brain.bat` | Windows boot script (index → sync → start) |

## Security Model

- `.env` contains all secrets, never committed to git
- `AEON_MOBILE_SECRET` bearer token required for external API access
- `requireShellAuth` on privileged OS endpoints: operator session required from every origin (loopback included), `AEON_MOBILE_SECRET` for headless callers, fail-closed when neither is present
- No shell execution surface — `POST /api/os/action` runs named operations with fixed executables and argument arrays, so no caller-supplied string reaches a shell
- `ALLOWED_ROOTS` for filesystem access boundaries
- Supabase RLS enabled on all tables
- Groq/Gemini keys only in `.env`, referenced via `import.meta.env.VITE_*` in frontend

## Ports

- `3000` — Vite dev server (frontend + proxy)
- `3001` — Express API server (backend)
- Vite proxies `/api/*` to `localhost:3001`
