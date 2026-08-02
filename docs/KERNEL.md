# AEON Kernel

The kernel is `server/server.js` — the composition root: an Express server providing routing, LLM abstraction, block loading, and system services. `server.cjs` at the repo root is a 12-line compatibility shim that re-exports it; earlier docs described the shim as the kernel.

## Boot Sequence

```
1. Load .env (dotenv)
2. Initialize Treasury (Firebase sync, local only)
3. Create Express app
4. Mount middleware (CORS, auth, JSON parser, multer)
5. Initialize Supabase client
6. Define LLM functions (geminiRequest, groqRequest, localNativeRequest, kernelLLM)
7. Define system functions (writeOSAudit, validateSDI, fetchDuckDuckGo)
8. Mount modular plugins (modules/*.js — ats_engine, hr_arsenal, logistics)
9. Scan src/blocks/*/block.manifest.json → mount API routes (Block Router v2)
10. Mount route modules (routes/*.js — 17 route files)
11. Mount Render Studio routes + Autopilot daemon
12. Start listening on port 3001
13. Launch sync daemon (tools/local-sync-daemon.js)
14. Reap orphaned trading engine processes
```

## LLM Service Layer

### Direct Functions (internal use by routes)
- `geminiRequest(prompt, model)` — Gemini API with key rotation and 429 failover
- `groqRequest(prompt, model)` — Groq Cloud API
- `localNativeRequest(prompt, model)` — AEON's bundled llama.cpp runtime, managed inside the app's data root

### Kernel LLM (preferred for blocks)
```
POST /api/kernel/llm
{ "prompt": "...", "role": "chat|grading|research|creative" }
```

Reads `aeon-settings.json` for role → provider/model mapping:
```json
{
  "models": {
    "chat": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "grading": { "provider": "gemini", "model": "gemini-2.0-flash" },
    "research": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "creative": { "provider": "gemini", "model": "gemini-2.0-flash" }
  },
  "roulette": false
}
```

**Roulette mode:** When enabled, randomly picks between available providers to distribute rate limits across free-tier keys.

**Failover chain:** Gemini (with key rotation) → Groq → local runtime. Automatic on 429 or connection failure.

## Block Router v2

At boot, the kernel:
1. Scans every directory in `src/blocks/`
2. Reads `block.manifest.json` if present
3. Builds `_blockRegistry` array (exposed via `GET /api/blocks/registry`)
4. For blocks with `api/` subdirectory: auto-mounts each `.js` file as Express routes

Blocks without manifests are still loaded but flagged as `tier: 'unknown'`.

## Route Architecture

| File | Endpoints | Purpose |
|------|-----------|---------|
| routes/os.js | /api/exec, /api/os/* | OS-level commands (allowlisted) |
| routes/trading.js | /api/trading/* | Trading engine supervisor |
| routes/fs.js | /api/fs/* | Filesystem CRUD |
| routes/gemini.js | /api/email-draft, /api/transcribe | LLM endpoints |
| routes/chat.js | /api/chat, /api/terminal-* | Chat log + terminal SSE |
| routes/media.js | /api/video/*, /api/media/* | Video pipeline + components |
| routes/brain.js | /api/brain_file, /api/notes, /api/narrator/* | Second Brain file access |
| routes/analytics.js | /api/search, /api/telemetry, /api/pipeline-* | Search + analytics |
| routes/system.js | /api/health, /api/system/*, /api/sync-* | System health + scanning |
| routes/sandbox.js | /api/sandbox/*, /api/orion-scrape | Sandbox + Orion scraper |
| routes/sync.js | /api/sync/*, /api/logistics/* | Block data sync + logistics (ATS routes removed 2026-07-17) |
| routes/research.js | /api/research/* | Deep research pipeline |
| routes/cookbook.js | /api/cookbook/*, /api/model/* | Local AI model management |
| routes/hwfit.js | /api/hwfit/* | Hardware fitness scoring |
| routes/compare.js | /api/compare/* | Model comparison arena |
| routes/memory.js | /api/memory/* | Memory CRUD + tidy |
| routes/token-analytics.js | /api/token-analytics/* | Usage tracking + heatmap data |

## Security Layers

1. **CORS allowlist** — Only listed origins permitted (localhost + configured domains)
2. **Bearer auth** — External requests require `AEON_MOBILE_SECRET`
3. **Session on privileged OS endpoints** — `requireShellAuth` requires an operator session from every origin, loopback included. Loopback is not authentication: a malicious local process, a compromised browser tab and an exposed dev proxy all originate from 127.0.0.1. `AEON_MOBILE_SECRET` remains accepted for headless callers, and the gate is fail-closed when neither is present.
4. **No shell execution surface** — AEON does not run a caller-supplied string through a shell. `POST /api/os/action` exposes named operations with typed parameters, each launched with a fixed executable and an argument array.
5. **Path allowlist** — Filesystem access restricted to `ALLOWED_ROOTS`
6. **SDI validator** — Schema validation on all structured data writes
7. **Audit trail** — Every action logged to `audit_log.json` + Supabase

## Telemetry

Every LLM call is tracked via `_trackLLM(engine, model, tokens, latencyMs, success)`:
- Stored in memory (`_llmTelemetry` object)
- Written to audit log
- Forwarded to token-analytics if available
- Exposed via `GET /api/llm-telemetry`

System metrics (CPU, RAM) broadcast every 5 seconds via SSE to connected terminals.
