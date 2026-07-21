# B2 Complexity Gate Rules (Ship Plan v2)

> **NEVER an LLM call.** Asking a model if something is risky makes the gate exploitable.
> All checks are deterministic string/regex/AST operations.
> Engine: `src/kernel/complexityGate.cjs` + `src/kernel/staging.cjs` (shared `CODE_CHECKS`).
> Test suite: `node tools/test-gate.cjs` — **must pass 20/20** before any change to this system ships.

---

## Scoring table

| Condition | Score | Approval behavior |
|---|---|---|
| Pure CRUD, own folder, no new perms | **LOW** | Auto-build — no human touch |
| Cross-block WRITE or shared schema scope | **MEDIUM** | Single-click + perm summary |
| Estimated cost > `AEON_BUILD_DAILY_COST_LIMIT` (default $1/day) | **MEDIUM** | Single-click + cost breakdown |
| `permissions.shell == true` | **HIGH** | Full review: perm breakdown + code diff + explicit approve |
| Required secrets not in vault | **HIGH** | Full review — new secret requires explicit grant |
| Code references paths outside own block | **HIGH** | Full review — sandbox escape attempt |

Three **distinct** approval behaviors — not two, not one. GAP 2 fix.

---

## Code checks (deterministic)

Defined in `src/kernel/staging.cjs → CODE_CHECKS`. Shared by `lintBlock()` and `gate()`.
Extend here and only here — both paths inherit the change.

| Check ID | Severity | Pattern | Why |
|---|---|---|---|
| `path-traversal` | HIGH | `../../` or multiple `'..'` args | Path escape from block sandbox |
| `secret-file-read` | HIGH | `.env` filename or `/secrets/` path in a string | Credential theft attempt |
| `child-process` | HIGH | `require('child_process')`, `execSync`, `spawnSync` | Shell execution (unless `permissions.shell=true` AND source is not `untrusted`) |
| `eval` | HIGH | `eval(...)` or `new Function(...)` | Dynamic code execution |
| `hardcoded-secret` | HIGH | `api_key = "..."` with 20+ char value | Hardcoded credential |
| `env-write` | MEDIUM | `process.env[x] =` or `process.env.x =` | Runtime env mutation |
| `global-mutation` | MEDIUM | `global.x =` | Global scope write |

### Trust modifier

Source `paste` or `store` = `trust: 'untrusted'`. Even if `permissions.shell = true` is declared in the manifest, the `child-process` finding is **not excused** for untrusted sources. The gate still flags it HIGH, routes to the full-review queue, and the operator reads the code diff before approving.

### Gate boundary (documented)

The gate operates at **build time** (string/AST scan of source files). It does **not**:
- Trace fetch() call targets — runtime API access control is enforced by R3 at the retrieval layer.
- Detect string-concat obfuscation of module names where the function name itself is not in scope.
  Example: `require('child'+'_process')` evades the `require(...)` pattern but `execSync` still triggers the `child-process` check if the function is called directly. Document this boundary; do not add fragile AST heuristics to close it.

---

## Manifest-level checks (in `gate()`)

Beyond code scanning, `gate()` also checks:

1. **Manifest validity** — `validateManifest()` against `src/kernel/schema.json`. Malformed = HIGH.
2. **`permissions.shell == true`** → HIGH (Tier 3 lane).
3. **Required secrets not in vault** — `requires.env` + `contract.requiredSecrets` minus `vaultSecrets` arg. Missing = HIGH.
4. **Cross-block WRITE** — `filesystem: 'write'` with `storage.scope !== 'block'`, OR `contract.outputs[].block !== manifest.id`. Either = MEDIUM.
5. **Cost threshold** — `envelope.estimatedDailyCost > AEON_BUILD_DAILY_COST_LIMIT`. Over = MEDIUM.

---

## Circular import check (staging lint only)

`detectCircularImports()` in `staging.cjs` walks the block-local import graph. A cycle = HIGH lint finding, blocks promote. This is a hot-reload failure mode (B6 #5): circular imports crash the loader on remount.

The check is block-local only — `node_modules` and kernel imports are out of scope.

---

## How to extend

1. Add a new regex to `CODE_CHECKS` in `staging.cjs`. Both `lintBlock()` and `gate()` inherit it.
2. Add a test case to `tools/test-gate.cjs` (append-only — never delete existing cases).
3. Run `node tools/test-gate.cjs` — all cases must pass before the change ships.
4. If the new check changes what "HIGH" means for any existing block in `src/blocks/`, that block must be re-linted and the finding resolved before the kernel reboots with the new check.
