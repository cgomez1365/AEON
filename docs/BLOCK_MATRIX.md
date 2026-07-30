# Block Responsibility Matrix

Every block's ownership boundaries. If a block isn't listed under "Reads", it has no access.

## Core Blocks

### Dashboard
- **Owns:** System overview, treasury display, pipeline metrics
- **Reads:** /api/health, /api/llm-telemetry, /api/trading/status, /api/autopilot/status, /api/pipeline-metrics, /api/token-analytics/*
- **Writes:** Firebase treasury (via treasury.js)
- **Requires:** supabase, firebase
- **Can be deleted:** NO (core)

### Fleet Control
- **Owns:** Agent management view, LLM telemetry display
- **Reads:** /api/llm-telemetry, /api/trading/status, /api/autopilot/status
- **Writes:** Nothing
- **Requires:** supabase
- **Can be deleted:** NO (core)

### Agent Registry (dictionary)
- **Owns:** Agent status display, capability listing
- **Reads:** /api/health, /api/trading/status, /api/autopilot/status
- **Writes:** Nothing
- **Requires:** None
- **Can be deleted:** NO (core)

### Activity (token_heatmap)
- **Owns:** Token usage heatmap, daily breakdown
- **Reads:** /api/token-analytics/heatmap, /api/token-analytics/summary, /api/token-analytics/daily/*
- **Writes:** Nothing
- **Requires:** supabase
- **Can be deleted:** NO (core)

### Memory
- **Owns:** Memory entries (local JSON + Supabase aeon_blocks.memory)
- **Reads:** /api/memory, /api/memory/stats
- **Writes:** /api/memory/add, /api/memory/bulk-delete, /api/memory/tidy, /api/memory/import
- **Requires:** groq (for tidy), supabase
- **Can be deleted:** NO (core)

### Files
- **Owns:** File browser UI, DataNotes component
- **Reads:** /api/fs/list, /api/fs/read, /api/fs/serve
- **Writes:** /api/fs/write, /api/fs/upload, /api/fs/delete
- **Side effect:** Upload to Second_Brain dir triggers re-index
- **Requires:** supabase (cloud mode)
- **Can be deleted:** NO (core)

### Settings
- **Owns:** API key display, model-per-role config, block registry view
- **Reads:** /api/settings, /api/settings/providers, /api/settings/blocks
- **Writes:** /api/settings (aeon-settings.json)
- **Requires:** None
- **Can be deleted:** NO (core)

### Staff
- **Owns:** Agent workload visualization
- **Reads:** /api/llm-telemetry
- **Writes:** Nothing
- **Requires:** None
- **Can be deleted:** NO (core)

## Free Blocks

### Deep Research
- **Owns:** Research jobs, research library (local JSON + Supabase research_library)
- **Reads:** /api/research/active, /api/research/library, /api/search-web
- **Writes:** /api/research/start, /api/research/cancel/*
- **Requires:** groq, gemini, supabase
- **Can be deleted:** YES (reports will show empty library)

### Reports
- **Owns:** Report rendering, HTML/PDF export
- **Reads:** /api/research/library (depends on research block's data)
- **Writes:** Nothing (exports are client-side downloads)
- **Requires:** supabase
- **Can be deleted:** YES

### Quick Links
- **Owns:** Bookmark entries (local state via AeonContext)
- **Reads:** Nothing
- **Writes:** Nothing (client-side only)
- **Requires:** None
- **Can be deleted:** YES

### Sandbox
- **Owns:** Scrub results (local JSON + Supabase sandbox_results)
- **Reads:** /api/sandbox/results
- **Writes:** /api/sandbox/scrub
- **Requires:** groq, supabase
- **Can be deleted:** YES

## Plugin Blocks

### Resume Grader
- **Owns:** Stateless resume-vs-JD grading (candidate pipeline removed 2026-07-24)
- **Reads:** nothing persistent
- **Writes:** /api/resume-grader/grade
- **Requires:** groq, gemini, supabase
- **Can be deleted:** YES

### Clients (CRM)
- **Owns:** Client roster, invoices, scrape results
- **Reads:** /api/orion-scrape, /api/executive-briefing
- **Writes:** /api/audit (logs), /api/chat (notifications)
- **Requires:** groq, supabase
- **Can be deleted:** YES

### HR Arsenal
- **Owns:** HR audit results, TA packages
- **Reads:** /api/hr-audit, /api/hr/records
- **Writes:** /api/hr-audit
- **Requires:** groq, firebase, gas
- **Can be deleted:** YES

### Outreach
- **Owns:** Email drafts, send tracking
- **Reads:** /api/email-draft
- **Writes:** /api/email-tracker
- **Requires:** groq, firebase
- **Can be deleted:** YES

### Arena (compare)
- **Owns:** Comparison history, voting scoreboard
- **Reads:** /api/compare/models, /api/compare/history, /api/compare/scoreboard
- **Writes:** /api/compare/start, /api/compare/record, /api/compare/*/vote
- **Requires:** groq, gemini
- **Can be deleted:** YES

### Scheduler
- **Owns:** Calendar events, task entries
- **Reads:** Google Calendar via GAS
- **Writes:** Google Calendar via GAS
- **Requires:** gas
- **Can be deleted:** YES

### Cookbook
- **Owns:** GPU probe data, model download/serve tasks
- **Reads:** /api/cookbook/gpus, /api/model/cached, /api/hwfit/*
- **Writes:** /api/model/download, /api/model/serve, /api/cookbook/delete-cache
- **Requires:** ollama (local)
- **Can be deleted:** YES

### Render Studio
- **Owns:** Video components, render pipeline, autopilot state
- **Reads:** /api/media/*, /api/video/*, /api/autopilot/*
- **Writes:** /api/video/stream-*, /api/autopilot/start|stop
- **Requires:** ffmpeg (local), youtube
- **Can be deleted:** YES

### Trading Block
- **Owns:** Engine control, position display
- **Reads:** /api/trading/status
- **Writes:** /api/trading/start, /api/trading/stop
- **Requires:** coinbase, python (local), supabase
- **Can be deleted:** YES

### Inventory
- **Owns:** Asset/expense entries (JSON via /api/fs)
- **Reads:** /api/fs/read
- **Writes:** /api/fs/write, /api/audit
- **Requires:** None (hybrid — filesystem on local, Supabase on cloud)
- **Can be deleted:** YES

### Logistics
- **Owns:** Delivery entries, status tracking, signatures
- **Reads:** /api/logistics/entries
- **Writes:** /api/logistics/entries, /api/logistics/status, /api/logistics/sign
- **Requires:** supabase
- **Can be deleted:** YES

### Sign Flow
- **Owns:** PDF signature sessions, signed document storage
- **Reads:** Firebase signed documents
- **Writes:** Firebase signed documents
- **Requires:** firebase
- **Can be deleted:** YES

### Portfolio
- **Owns:** Canva OAuth connection, asset uploads
- **Reads:** /api/canva/status
- **Writes:** /api/canva/upload-asset
- **Requires:** canva, gas
- **Can be deleted:** YES
