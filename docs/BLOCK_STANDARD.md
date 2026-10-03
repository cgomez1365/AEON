# AEON Block Standard

Every block in `src/blocks/` must follow this contract. To BUILD one, follow
[`src/blocks/master/README.md`](../src/blocks/master/README.md) end to end —
scaffold, lint, promote, routes, build, mount, stop/start/remove, and what a
block can and cannot get from AEON. This page is the short contract.

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
  "deployment": { "target": "any", "runtime": "nodejs" },
  "tier": "core | plugin | experimental",
  "requires": {
    "apis": ["groq", "gemini", "supabase", "firebase"],
    "local": ["ffmpeg", "python"],
    "blocks": ["research"]
  },
  "api_routes": true,
  "version": "1.0.0"
}
```

Full JSON Schema: [src/kernel/schema.json](../src/kernel/schema.json). `aeon lint`
enforces part of it, via `validateManifest()` in `src/kernel/staging.cjs`:
the required fields, `id`, `route`, the `filesystem`/`network` values and the
v1.1 storage and memory rules. It does not check the `tier` enum or that
`deployment` is an object (measured 2026-10-02: `tier: "free"` with
`deployment: "universal"` linted clean), so follow the schema, not the lint.
A second, stale copy lived at `db/block.schema.json` until 2026-08-09; it was
referenced only by docs, enforced by nothing, and contradicted this one
(`deployment` as a string vs an object, a different `tier` enum). It was deleted
rather than fixed — two schemas is the defect, not their disagreement.

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
- Backend routes go in `api/<id>.cjs` as CommonJS modules
- Each file exports a factory, `module.exports = (deps) => router`, and every
  route path starts with `/<id>/` (the router is mounted at `/api`). The older
  plugin shape `(app, deps) => { ... }` still mounts.
- `deps` is scoped by `contract.permissions`: `blockStorage` (unless
  `filesystem: "none"`), `kernelLLM` (only with `ai: true`), plus
  `blockSettings()`, `lifecycle` and `writeOSAudit` for every block. The full
  list, and what is not provided, is in the Master guide.
- Call models through `deps.kernelLLM(prompt, { role })`, never a provider URL

### Frontend Pattern
- Import React, `lucide-react` and `src/kernel` only. Any other `../../`
  import — `../../config.js`, `../../components/…` — is a HIGH
  `path-traversal` finding in `aeon lint`, and `aeon promote` refuses it.
- Fetch relative paths only (`/api/<id>/...`) with `credentials: 'same-origin'`
- All fetch calls must have try/catch with graceful degradation
- No secret in browser code or a `VITE_` variable

### Deployment Tags
- `universal` — Needs no OS access and no local files, so it would run on a read-only host. (No cloud target is deployed today.)
- `local_required` — Needs OS access, hardware, or local services (FFmpeg, Python, the local runtime Cookbook downloads).
- `hybrid` — Core features work on cloud, advanced features need local.

### What Blocks Must Not Do — conventions, partly checked by `aeon lint`, not enforced

Blocks share one Node.js process, so nothing below is a sandbox. `aeon lint`
pattern-checks some of these rules and `aeon promote` refuses a HIGH finding;
a block already in `src/blocks/` is not re-linted at runtime. The rest are
review items.

- Reach the filesystem outside the block's own namespace without declaring it in
  the manifest. `npm run scan:block-fs` reports undeclared access in shipped
  blocks; browsing the operator's files goes through host_os's `/api/fs/*` routes.
- Run shell commands. There is no shell route (`/api/exec` was deleted); named OS
  operations are `POST /api/os/action`. `aeon lint` flags `child_process`,
  `execSync` and `spawnSync` as HIGH unless the manifest declares
  `contract.permissions.shell: true`.
- Import or require other block modules directly (any `../../` path other than an
  import of a kernel module is a HIGH `path-traversal` finding).
- Hardcode API keys, Supabase URLs, or file paths (`hardcoded-secret` catches
  key-shaped strings only).
- Assume any other block is installed
