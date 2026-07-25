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
