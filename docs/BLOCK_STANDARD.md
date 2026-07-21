# AEON Block Standard

Every block in `src/blocks/` must follow this contract.

## Required Files

```
src/blocks/<block_id>/
  ├── index.jsx              # Default export React component
  ├── block.manifest.json    # Block metadata (see schema below)
  ├── api/                   # (Optional) Express route handlers
  │   └── *.js               #   Auto-mounted by kernel at boot
  └── components/            # (Optional) Sub-components
```

## Manifest Schema

```json
{
  "id": "my_block",
  "label": "My Block",
  "icon": "🔧",
  "route": "/my-block",
  "description": "One-line summary (max 120 chars)",
  "category": "core | business | intelligence | operations | tools | analytics",
  "deployment": "universal | local_required | hybrid",
  "tier": "core | free | plugin",
  "requires": {
    "apis": ["groq", "gemini", "supabase", "firebase", "ollama"],
    "local": ["ffmpeg", "python", "ollama"],
    "blocks": ["research"]
  },
  "api_routes": true,
  "version": "1.0.0"
}
```

Full JSON Schema: [block.schema.json](../block.schema.json)

## Rules

### Isolation
- A block MUST NOT import from another block's folder
- A block MAY call another block's API endpoints (declare in `requires.blocks`)
- Deleting any plugin block MUST NOT break the system boot

### Data Ownership
- A block owns its own data (local JSON, Supabase table, or API responses)
- A block MUST NOT write directly to another block's data store
- Cross-block data access happens through API endpoints only

### API Pattern
- Backend routes go in `api/*.js` as CommonJS modules
- Each file exports `module.exports = (app, deps) => { ... }`
- `deps` provides: `supabase`, `geminiRequest`, `groqRequest`, `validateSDI`, `writeOSAudit`, `path`, `fs`
- Prefer `kernel.llm()` endpoint over direct provider calls

### Frontend Pattern
- Use `import.meta.env.VITE_*` for any configuration values
- Use `../../config.js` for workspace paths and Supabase credentials
- All fetch calls must have try/catch with graceful degradation
- Cloud fallback: try local API first, then Supabase direct query

### Deployment Tags
- `universal` — Works on localhost AND Vercel/cloud. No OS access, no local files.
- `local_required` — Needs OS access, hardware, or local services (Ollama, FFmpeg, Python).
- `hybrid` — Core features work on cloud, advanced features need local.

### What Blocks Cannot Do
- Access the filesystem outside of `/api/fs/*` endpoints
- Execute shell commands outside of `/api/exec` (allowlisted)
- Import or require other block modules directly
- Hardcode API keys, Supabase URLs, or file paths
- Assume any other block is installed
