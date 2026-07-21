# _blank — AGENT BLUEPRINT (machine-first build recipe)

You are building a new AEON block. Follow these steps EXACTLY, in order.
Do not skip a VERIFY. Do not invent fields, routes, or files not listed here.
Everything you need is in this folder — copy, rename, fill the marked slots.

## HARD RULES (violating any one breaks the block)

1. `id` in block.manifest.json MUST equal the folder name. Lowercase letters, digits, underscores only.
2. NEVER edit or write files outside the new block's own folder.
3. NEVER invent manifest fields. Only change the fields listed in STEP 2. Copy everything else byte-for-byte.
4. All API route paths MUST start with `/crn/<id>/`. No other prefix.
5. The UI file MUST default-export exactly one React component. No other exports.
6. Store data ONLY via the pattern in api/blank.cjs (own `data/` folder, auto-created). Never pre-create `data/`.
7. Folder names starting with `_` are never mounted — your new block's name must NOT start with `_`.

## STEP 1 — copy

Copy ALL of these files into a new folder named after the block id:
- `BLUEPRINT.md` → do NOT copy this file
- `block.manifest.json` → copy
- `index.jsx` → copy
- `api/blank.cjs` → copy, rename to `api/<id>.cjs`

VERIFY: list the new folder. It must contain exactly: `block.manifest.json`, `index.jsx`, `api/<id>.cjs`.

## STEP 2 — fill the manifest slots

Open the copied `block.manifest.json`. Change ONLY these 8 fields (every one currently contains the text `__BLANK__` or a placeholder value):

| Field | Set to |
|---|---|
| `id` | the folder name |
| `label` | Human name, 1-3 words |
| `icon` | one emoji or a lucide icon name |
| `route` | `/` + the folder name |
| `description` | one sentence |
| `category` | one of: Productivity, System, Business, Creative, Data |
| `nav.label` | same as `label` |
| `contract.permissions` | pick ONE archetype from the table below — copy its 5 values exactly |

### Permission archetypes (measured from the 35 live blocks — pick the weakest that works)

| Archetype | filesystem | network | secrets | shell | ai | Use when |
|---|---|---|---|---|---|---|
| A. UI-only | `"none"` | `"none"` | `false` | `false` | `false` | Pure front-end tool, no server calls (like shift_scheduler) |
| B. Standard | `"read"` | `"internal"` | `false` | `false` | `true` | Reads own data + calls kernel AI (like writer, tasks, staff — the most common) |
| C. Web-connected | `"read"` | `"external"` | `false` | `false` | `true` | Also calls outside APIs/web (like research, trading, outreach) |
| D. System | `"workspace"` | `"internal"` | `false` | `true` | `true` | Needs shell or broad file access (like host_os, agent_core) — AVOID unless the goal demands it |

VERIFY: parse the file as JSON (it must parse) AND confirm `id` equals the folder name AND confirm no field still contains `__BLANK__`.

## STEP 3 — fill the API slots

Open `api/<id>.cjs`. It works as-is. Replace only:
- every `__BLANK__` string with the block id (there are 4)
- the `/// EDIT ZONE` section — add your routes there, following the two patterns already present (read collection, append item). Route paths: `/crn/<id>/<thing>`.

Rules inside this file:
- Use `deps.kernelLLM(prompt, { role: 'chat' })` for AI. Never call a provider URL directly.
- Data lives in `DATA_FILE`. Read with `load()`, write with `save()`. Never use any other path.

VERIFY: run `node --check api/<id>.cjs` (or read the file back and confirm no `__BLANK__` remains).

## STEP 4 — fill the UI slots

Open `index.jsx`. Replace only:
- every `__BLANK__` with the block id (there are 3)
- the `/// EDIT ZONE` JSX — build the interface there. Fetch your own API with relative paths: `fetch('/api/crn/<id>/items')`.

Rules: keep the single default export. Keep the outer `<div style={S.wrap}>`. Inline styles only (match the S object pattern).

VERIFY: confirm no `__BLANK__` remains anywhere in the folder (search all files).

## STEP 5 — final checklist (report each item with evidence)

- [ ] folder name == manifest `id` == route (minus slash)
- [ ] manifest parses as JSON, all 8 fields filled, one archetype copied exactly
- [ ] `node --check` passes on the api file (or zero `__BLANK__` on read-back)
- [ ] zero `__BLANK__` strings anywhere
- [ ] every API route starts with `/crn/<id>/`
- [ ] no file written outside the new folder

Done. The operator moves the folder to `src/blocks/` (or through `staging/` + `npm run aeon lint <id>`) and restarts — the block loader mounts it automatically from the manifest. You do not register anything anywhere else: THE MANIFEST IS THE ONLY DECLARATION.
