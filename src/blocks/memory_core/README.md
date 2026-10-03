# 🧠 AEON Block: Memory Core

**ID:** `memory_core`
**Route:** `/memory_core`
**Status:** `ACTIVE` (core, nav group `system`, order 99)

## What it does

The operator's agents and what each one remembers.

- **Shared memory** ("All agents" tab) — `Vault/Agents/Aeon/memory/`, the path it
  always had. Every agent reads it unless told not to.
- **Agents** — each one a folder `Vault/Agents/<Folder>/` with an `agent.json` (name,
  persona, model, privacy, memory switches) and its **own** memory in `memory/`.
  Created, edited and removed here (`/api/agents`); removing moves the folder to
  `Vault/Agents/.removed/` — nothing is deleted. The operator's own AEON
  (`Agents/Aeon`) can be renamed and given a persona and a model; it cannot be
  removed. Layout and rules: `src/kernel/agents.cjs`.
- **A manual switch on every memory** (`active`). Off keeps the memory saved and
  listed here and in Aeon Matrix, but it is never sent to a model and it stays out
  of the Second Brain index and recall (`/recall`, `/ask`, chat recall): the next
  index scan takes it out, and recall skips it even before that scan. The page
  shows what the switched-on memories cost every turn (~tokens), with all-on /
  all-off. Settings → Blocks → Memory Core → **New memories start on** decides the
  default.
- **Calling an agent:** `/agent <name>` in the terminal, a click in Fleet Control's
  Recent Agent Missions, "talk in terminal" here, or any wake-up call that names it
  ("scout come online", "scout - online", "wake up, scout", "hey scout, wake up").
  `aeon` and `vp` wake the operator's own AEON; "come online" or "wake up" alone
  wakes whoever is current. Wake rules: `detectWake` in `src/kernel/agents.cjs`.
- **Per-agent model and privacy:** an agent may name its own model (else Settings and
  roulette decide). **Local only**:
  - its calls — chat, distil, auto-capture, the title of a saved chat — are refused
    rather than sent to a cloud model, whatever the global switch says. An image
    attached in its chat is not read at all (`POST /api/ai/vision` answers 409),
    because images are read only by cloud models here;
  - its saved chats are skipped by a distil that runs on a model that is not Local
    only, and "remember" will not add them to the indexed record. The terminal tags
    every turn with the agent it was with, so in a chat that switched agents its
    turns are left out of what goes to another agent's model, a chat title, a
    distil or the record (`shareableTurns` in `src/kernel/agents.cjs`);
  - `/memory`, `/context`, `/doc` and `/read` show its memory files but never read
    them back into the conversation or have a model summarise them;
  - the question it searches the Second Brain with is embedded on this computer (or
    the LAN), or recall does not run;
  - its whole folder (`Agents/<Folder>/` — memory, mission log, `agent.json`) stays
    out of the Second Brain index and recall.

  For the operator's own AEON, its memory **is** the shared memory: an agent set to
  Roulette that reads the shared memory still sends it to its own model. A block
  can run its own jobs as an agent: `POST /api/ai { prompt, agent }`.
- **Mission log:** `Vault/Agents/<Folder>/missions/log.json`, the last 50 things the
  agent was asked (the operator's words, never the answer — R09). Recent Agent
  Missions shows the latest.

Every memory route takes `?agent=<id|name>` (or `agent` in the body); none means the
shared store. An agent nobody has answers 404 — the shared store never stands in
for it.

This block replaces an older `memory` block that was deleted without
relocating its store — the terminal kept reading a path that no longer
existed, so injection silently returned nothing for weeks with no error.
`memory_core` now owns that store directly, and every reader resolves it
through `src/kernel/agents.cjs` (`memoryDir`, `sharedMemoryDir`) from the same
`VAULT_ROOT`, so the paths cannot drift apart again.

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

**Record shape** (superset — fields are never removed):

```json
{
  "id": "hex12", "text": "...", "originalText": "(only when the text was reworded)",
  "category": "fact|identity|preference|contact|project|goal",
  "type": "outline|algorithm|decision|milestone|null", "title": null,
  "tags": [], "pinned": false, "active": true, "timestamp": 0, "source": "operator|distill|api|auto-extract",
  "refs": [{ "kind": "terminal-history|transcript|chat-session|file|url|mission|operator", "...locator": "" }]
}
```

`active` missing means on. `refs` is provenance — every memory can answer
"where did this come from." `/memory/distill` attaches the chat session,
transcript SHA or terminal-history span it read; `/memory/add` accepts
caller-supplied refs (capped at 5).

### Ranking doctrine — continuity over recency

One implementation, `src/kernel/memory-policy.cjs` (`continuityRank`,
`selectForInjection`), used by chat injection and by `/memory/context`:

```
pinned (+100000)  ≫  operator-authored (+500)
  + decision (400) > outline/algorithm (300) > untyped/other category (150) > milestone (50)
  + an agent's own memory (+250) over the shared pool it also reads
```

Keyword matches add on top; recency only breaks ties. Rationale:
re-litigating a settled decision costs more than missing a recent event, so
old decisions must outrank yesterday's milestone. Switched-off memories are
never selected.

## Storage

Per store (the shared one, and one per agent):

- `Vault/Agents/Aeon/memory/memories.json` (shared) or
  `Vault/Agents/<Folder>/memory/memories.json` (an agent's own) — the
  canonical array, written atomically. Unreadable is not empty: a damaged
  file answers 503 with its path and is never overwritten.
- `<same folder>/<id>.md` — one operator-readable mirror per memory (YAML
  front matter: `id, category, type?, title?, tags?, pinned, active: false
  (only when off), created, source?, refs?`), so every memory is also a file
  in Aeon Matrix. The Second Brain indexes memories through these mirrors;
  `memories.json` itself is never indexed (it holds the switched-off ones too).
- `<same folder>/.distilled.json` — fingerprints of transcripts already
  distilled (last 200), so the same conversation is not distilled twice.

The Vault root is `deps.VAULT_ROOT` (falls back to
`src/blocks/aeon_matrix/data/Vault` if not injected); what is withheld from
the index is decided by `src/kernel/vaultPrivacy.cjs`.

## API routes (mounted at `/api` and `/block/memory_core`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/memory` | List, pinned first then newest. Query: `?type=`, `?category=`, `?q=` (every word, any order, in text + title; a `q` that is only a category word is a section lookup). Returns `memories` (each with `active` and `tokens`), a `summary` (total, on, off, tokens of the on ones), `text` for the terminal chip, and `modelText` — what the terminal may read back into the conversation (without switched-off memories; `null` for a Local only agent). |
| `POST` | `/api/memory/add` | Create. Body: `{text, category?, type?, title?, tags?, pinned?, source?, refs?, active?}`. `text` must be 6+ chars. Deduped on trimmed, lower-cased text — a repeat is a no-op and its `text` says so. Every response carries a one-line `text` for the terminal chip. **Path is a contract**: the chat auto-extract posts here. |
| `PUT` | `/api/memory/:id` | Edit any of `text, category, type, title, tags, pinned, active`. |
| `POST` | `/api/memory/:id/pin` | Toggle pin. |
| `POST` | `/api/memory/:id/active` | The switch: `{active: true\|false}` sets it, no body flips it. |
| `POST` | `/api/memory/active` | Many switches at once: `{active, ids: [...]}` or `{active, all: true}`. |
| `DELETE` | `/api/memory/:id` | Remove (and its `.md` mirror). |
| `GET` | `/api/memory/context?q=&budget=` | The injection payload over HTTP (`/context` in the terminal). `budget` is in **tokens** (default 1100, max 6000). Returns `{text, count, considered, dropped, disabled, tokensUsed, budget, budgetUnit}`. |
| `POST` | `/api/memory/distill` | Up to 5 typed memories from a transcript, on the agent's own model and privacy (the operator's AEON's too). Body `{transcript?, refs?, sessionId?, force?}`; with no transcript it reads the newest saved chat (or `sessionId`) from the store's sibling `chat_sessions/`, then the legacy terminal history file. A chat with an agent set to Local only is skipped unless the distil itself runs as a Local only agent (asked for by `sessionId`: 409). A conversation already distilled answers "nothing new" unless `force`. |
| `GET` | `/api/agents` | Every agent: the operator's own AEON first, with model, privacy, memory count, last activity and last mission. |
| `POST` | `/api/agents` | Create: `{name, persona?, model?, privacy?, sharedMemory?, capture?}`. |
| `PUT` | `/api/agents/:id` | Change any of those fields. |
| `DELETE` | `/api/agents/:id` | Move the agent's folder to `Agents/.removed/`. |

All routes require auth per the manifest (`routes[].auth: true`). Add, edit,
delete, distill, the switches and agent changes ask the kernel to index the
Vault (`deps.requestIndex`), so `/recall` reflects them within seconds instead
of after the next scheduled scan.

## How a chat turn uses memory

`memory_core` owns the store; chat reads it directly off disk through the
kernel, not over HTTP:

1. `src/blocks/dashboard/api/chat-stream.cjs` (and `POST /api/ai/converse`) call
   `src/kernel/context.cjs` `buildMemoryContext()`. It reads the agent's own
   store plus the shared one (unless the agent was told not to read it), drops
   switched-off memories, ranks with `memory-policy.cjs`, and fits the result
   to a token budget: 12% of the model's context window on an ordinary turn,
   25% on a wake (at most 32,000 tokens). An ordinary turn also caps the count
   at **Most memories per turn** (default 200); a wake loads every switched-on
   memory that fits and adds a `## WAKE` block naming the agent and the count.
2. After a reply, the **auto-capture** loop posts durable facts to
   `POST /api/memory/add`, as the agent and with its privacy. It runs for the
   operator's own AEON when **Save memories automatically** is on, and for
   another agent when its own "Captures memories from its chats" box is ticked.

## Settings

Declared in the manifest (`contract.settings`), shown in Settings → Blocks →
Memory Core:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `memory_in_context` | boolean | `true` | Use memories in chat. Off: the model sees none. |
| `auto_memory` | boolean | `false` | Save memories automatically from the operator's own AEON's chats. |
| `memory_max_context` | number | `200` | Most memories considered per ordinary turn; the token budget still decides what fits. |
| `new_memories_on` | boolean | `true` | New memories start switched on. Off: they are saved switched off. |

## UI (`index.jsx`)

Agent tabs (All agents, then each agent) / new and edit agent (name, persona,
model, privacy, shared memory, auto-capture) / "talk in terminal" / the switch
on every memory with its token cost and all-on, all-off / filter by type or
category chip, or free-text search / add / pin / inline edit / delete /
"distill" (the newest saved chat in that store's sibling `chat_sessions/`).

## Files
- `index.jsx` — operator UI
- `api/memory.cjs` — Express router (arity-1 factory `(deps) => router`), owns the stores
- `block.manifest.json` — kernel metadata (auto-loaded)
- `.aeon.runtime.json` — generated by the kernel, git-ignored, do not hand-edit

## To Activate
This block is automatically detected by the AEON OS Kernel router and
dual-mounted at `/api` and `/block/memory_core`. Drop this folder into
`src/blocks/`, then run `npm run prep:routes` and `npm run build`; a
restart alone does not rebuild the interface.
