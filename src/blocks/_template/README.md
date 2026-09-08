# _template — the modder's empty game folder (K2)

Nobody builds from a blank file; they build from a working empty one. Copy this
folder → rename → restart → live. Folders starting with `_` are never mounted.

## Every manifest field, explained

| Field | Meaning |
|---|---|
| `manifestVersion` | Schema version (`src/kernel/schema.json`). New blocks use 1.1.0. |
| `id` | MUST equal the folder name. Lowercase, digits, underscores. |
| `label` / `icon` | What nav and the dashboard show. |
| `route` | URL the block mounts at. Leading slash. |
| `description` | One-liner for the store card / registry. |
| `category` / `tier` | Grouping + trust level (`core`/`plugin`/`experimental`). |
| `version` | YOUR block's semver, bumped by you. |
| `api_routes` | `true` = loader mounts files in `api/`. |
| `nav` | Sidebar placement. `hidden: true` keeps it out of nav (like this template). |
| `requires` | What must exist before block is "ready": env vars, other blocks, local files. Drives readiness checks. |
| `provides` | What this block offers others. |
| `contract.permissions` | THE security declaration. `filesystem`/`network`/`secrets`/`shell`/`ai` gate which deps the sandbox hands you. `crossBlockRead: ["other_id"]` = Tier 1.5 declared read. Cross-block WRITE is Tier 2 (approval). Shell is Tier 3. |
| `contract.storage` | Operational local data only. It is block-scoped and never indexed. `local.indexed` must remain `false`; new blocks use `access: "scoped"`. |
| `contract.memory` | Declares durable user memory: `none`, `summary`, or `document`. Enabled memory is written to the Vault and indexed by AEON Matrix. |
| `contract.commands` | Slash-commands to surface in the Neural Terminal. `{cmd, desc, route, method, param}`. |
| `contract.settings_keys` | Keys you read/write in Settings (the nervous system). |
| `routes` | Route table with `auth` flags. |
| `deployment` | `{target, runtime}` — where this block can run. |

## Rules (the three non-negotiables apply to you)

1. The manifest is the only declaration — the kernel knows nothing not written here.
2. New blocks go through `staging/` + `npm run aeon lint` before `src/blocks/`.
3. Use the injected `blockStorage` dependency for all block-owned files. `writeData()` is for local operational state; `publishState()` and `writeMemoryDocument()` are for declared Vault memory. Never calculate a storage path yourself.

## Where everything lives (paths from the repo root; `<id>` is your folder name)

| Path | What |
|---|---|
| `src/blocks/<id>/` | Your block: `block.manifest.json`, `index.jsx`, `api/*.cjs` (optional), `README.md`. |
| `staging/<id>/` | Where `npm run aeon new <id>` puts a copy of this folder. `aeon lint` → `aeon promote` moves it to `src/blocks/`. |
| `public/brand/block-icons/<id>.svg` | **Your sidebar icon. Drop the file here — nothing to declare.** Square, single colour, no background. |
| `public/brand/block-icons/png/<id>.png` | PNG fallback of the same icon. |
| `public/brand/block-icons/sections/` | Section icons (finance, agent, work, content, tools, system). |
| `src/kernel/blockStandard.cjs` | The kernel's NAV map. It **overwrites `manifest.nav` on every boot**; an unlisted block lands in SYSTEM at order 99 and can be dragged to any section on the Home dashboard. |
| `src/kernel/blockRegistry.js` | Browser-side discovery — a **build-time** glob over `src/blocks/*/index.jsx`. |
| `server/block-loader.js` | Server-side mounting of `api/*.cjs`, deps scoped by `contract.permissions`. |
| `src/kernel/schema.json` · `src/kernel/staging.cjs` | The manifest schema and the lint that enforces it. |
| `src/blocks/<id>/.aeon.runtime.json` | Written by the kernel at boot. Never edit, never commit. |

## Make it appear — the step everyone misses

`aeon new` → edit → `aeon lint` → `aeon promote` → **`npm run build` (or `npm run dev`)** → restart.
The browser finds blocks through a build-time glob. A running production build cannot see a new
folder until it is rebuilt, and nothing is logged — the block is simply absent. The Master block
in the console has the full guide and a copyable AI prompt.
