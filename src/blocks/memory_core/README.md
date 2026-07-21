# 🧠 AEON Block: Memory Core

**ID:** `memory_core`
**Route:** `/memory_core`
**Status:** `ACTIVE` (core, hidden-nav order 99 under `system`)

## What it does

VP's persistent memory across terminal sessions. Every "durable" fact,
decision, plan, or result the operator or VP surfaces gets stored as a typed
record, vault-resident so it also shows up as a file node in Aeon Matrix.
Pinned + high-priority memories ride along on every terminal chat turn so VP
doesn't have amnesia between sessions; saying **"vp come online"** triggers a
full read of the entire store.

This block replaces an older `memory` block that was deleted without
relocating its store — the terminal kept reading a path that no longer
existed, so injection silently returned nothing for weeks with no error.
`memory_core` now owns that store directly, and `chat-stream.cjs` derives its
read path from the same shared `VAULT_ROOT` constant instead of a second
hand-rolled path, so the two can't drift apart again.

## Memory type taxonomy

Two parallel classification fields on every record — `category` is the
legacy/general taxonomy, `type` is the operator-facing taxonomy used for
ranking and filtering in this UI:

| `type` | Meaning |
|---|---|
| `outline` | A scoped structure/plan that was settled |
| `algorithm` | Logic or a flow that was decided |
| `decision` | A choice made **and why** — so it's never re-litigated |
| `milestone` | A concrete external result |
| `null` | Untyped — falls back to `category` |

| `category` | Meaning |
|---|---|
| `fact` \| `identity` \| `preference` \| `contact` \| `project` \| `goal` | General-purpose bucket when no operator `type` applies |

**Record shape** (superset — fields are never removed, since `chat-stream.cjs`
reads them directly):

```json
{
  "id": "hex12", "text": "...", "category": "fact|identity|preference|contact|project|goal",
  "type": "outline|algorithm|decision|milestone|null", "title": null,
  "tags": [], "pinned": false, "timestamp": 0, "source": "operator|distill|api|vp-import",
  "refs": [{ "kind": "terminal-history|transcript|file|url|mission", "...locator": "" }]
}
```

`refs` is provenance — every memory can answer "where did this come from."
`/memory/distill` auto-attaches a transcript SHA or terminal-history span;
`/memory/add` accepts caller-supplied refs (capped at 5).

### Ranking doctrine — continuity over recency

Used identically by this block's `/memory/context` endpoint and by
`chat-stream.cjs`'s injection (keep both in sync if you touch the formula):

```
pinned  ≫  operator-authored (+500)  >  decision (400)  >  outline/algorithm (300)
        >  untyped fact (150)  >  milestone (50)
```

Recency only breaks ties. Rationale: re-litigating a settled decision costs
more than missing a recent event, so old decisions must outrank yesterday's
milestone.

## Storage

- `Vault/Agents/vp/memory/memories.json` — canonical array, single source of
  truth.
- `Vault/Agents/vp/memory/<id>.md` — one operator-readable mirror per memory
  (YAML frontmatter: `id, category, type, title, tags, pinned, created,
  source, refs`), so every memory is also browsable as a file in Aeon Matrix.

The vault path resolves through `deps.VAULT_ROOT` (falls back to
`src/blocks/aeon_matrix/data/Vault` if not injected), which is itself the
kernel's single shared constant (`services/storage.js`). It is **not**
independently hardcoded here — if the Vault is relocated, only that one
constant needs to change.

## API routes (mounted at `/api` and `/block/memory_core`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/memory` | Full list, pinned float to top then newest-first. Query: `?type=`, `?category=`, `?q=` (substring match on text+title). |
| `POST` | `/api/memory/add` | Create. Body: `{text, category?, type?, title?, tags?, pinned?, source?, refs?}`. `text` must be 6+ chars. Deduped on normalized (trim+lowercase) text — a repeat is a no-op, not a second row. **Path is a contract**: the dashboard chat-stream auto-extract loop POSTs here fire-and-forget; don't rename it without updating `chat-stream.cjs`. |
| `PUT` | `/api/memory/:id` | Edit any of `text, category, type, title, tags, pinned`. |
| `POST` | `/api/memory/:id/pin` | Toggle pin. |
| `DELETE` | `/api/memory/:id` | Remove (and its `.md` mirror). |
| `GET` | `/api/memory/context?q=&budget=` | Injection payload for callers that want it over HTTP: pinned first, then continuity rank + keyword relevance, recency last. `budget` is a char cap (default 4500, max 20000). Returns `{text, count, budget}`. |
| `POST` | `/api/memory/distill` | `kernelLLM(role: 'chat', background: true)` over a transcript (body `{transcript?, refs?}`) or, if none supplied, the last 30 turns of `db/aeon_terminal_history.json`. Returns up to 5 typed candidate memories, written unpinned with `source: 'distill'`, deduped against the existing store. |

All routes require auth per the manifest (`routes[].auth: true`).

## The injection contract with the terminal (read this before touching either side)

`memory_core` owns the store; it does **not** serve the terminal's live
context injection over HTTP. Instead:

1. **`src/blocks/dashboard/api/chat-stream.cjs`** reads
   `Vault/Agents/vp/memory/memories.json` **directly off disk** (`fs.readFileSync`,
   not a fetch to `/api/memory/context`) on every terminal turn, inside
   `buildMemoryContext()`. It re-implements the same continuity-over-recency
   ranking formula locally (kept in sync by convention, not by import — if you
   change the weights in `api/memory.cjs`, update `chat-stream.cjs` too).
   - Normal turn: pinned + top-ranked memories, capped at 4500 chars.
   - Wake phrase (`/\bvp[,!]?\s+(?:come\s+)?online\b/i`, e.g. "vp come
     online"): **all** memories loaded, cap raised to 10000 chars, and a
     `## WAKE` block is appended telling VP to confirm online, state the
     memory count, and ask for the mission.
2. Its **auto-extract loop** (gated by `prefs.brain_settings.auto_memory` in
   Settings) POSTs newly-noticed durable facts to `POST /api/memory/add`,
   fire-and-forget, from inside the SSE handler after a response completes.

`GET /api/memory/context` exists for any *other* future caller that wants the
same ranked/budgeted text over HTTP (e.g. a mission agent) — the terminal
itself does not use it today.

**Known gap, not fixed by this pass:** `src/components/NeuralTerminal.jsx`
still has a `/tidy` slash-command that calls `POST /api/memory/tidy`
(`fetch('/api/memory/tidy', ...)`, around line 679 and 1532). That route does
not exist anywhere in this block or elsewhere in the kernel — it's a 404 today.
`docs/BLOCK_MATRIX.md` still documents the old deleted `memory` block's route
set (`/api/memory/bulk-delete`, `/api/memory/tidy`, `/api/memory/import`,
Supabase-backed) which never carried over to `memory_core`. Fixing
`NeuralTerminal.jsx` or `docs/BLOCK_MATRIX.md` is outside this block's folder
and was left alone; flagging here so it doesn't get rediscovered as a mystery
bug later.

## Settings / config keys

Declared in `contract.settings`, read via `GET /api/settings/block/memory_core`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `injection_budget` | number | `4500` | Char cap for normal (non-wake) memory injection into terminal context. |
| `auto_distill` | boolean | `true` | Whether sessions get auto-distilled into typed memories (governs the auto-extract loop in `chat-stream.cjs`, not `/memory/distill` itself — that endpoint can always be called manually). |

`prefs.brain_settings` (read by `chat-stream.cjs`, not owned by this block)
also affects injection: `memory_in_context` (kill switch), `memory_max_context`
(row cap on normal turns, default 25).

## UI (`index.jsx`)

List / filter (by type or category chip, or free-text search) / add / pin /
inline-edit / delete / "distill session" (runs `/memory/distill` with no body,
i.e. against recent terminal history). Every memory shown is also a file
under `Vault/Agents/vp/memory/` visible in Aeon Matrix.

## Files
- `index.jsx` — operator UI (list/filter/add/edit/pin/delete/distill)
- `api/memory.cjs` — Express router (arity-1 factory `(deps) => router`), owns the store
- `block.manifest.json` — kernel metadata (auto-loaded)
- `.aeon.runtime.json` — **auto-generated on boot, do not hand-edit**

## To Activate
This block is automatically detected by the AEON OS Kernel router and
dual-mounted at `/api` and `/block/memory_core`. Drop this folder into
`src/blocks/` and restart the Command Center.
