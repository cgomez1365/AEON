# Memory & Second Brain Architecture

AEON's long-term value is what it remembers: the operator's documents, the facts they ask
it to keep, and the ability to answer from both with sources. This is how that works today.

> Rewritten 2026-09-14. The previous version described a `Data/Second_Brain` folder, a
> `brain-data.json` graph and a batch-file indexer, none of which exist any more. Every
> path below is checked by `tests/docs-truth.test.js`.

## Where memory lives

Everything durable is in the **Vault** — by default `~/AEON/Vault`, outside the install
(`src/kernel/aeonHome.cjs`; redirectable with `VAULT_PATH`, exposed by `services/storage.js`).
It is never deployed and survives a re-clone untouched, because nothing in the install
directory is yours.

| What | Where | Written by |
|---|---|---|
| Documents | anywhere in the Vault (for example `<Vault>/Reading_Library/Uploads/`) | uploads, `/upload`, the Files block |
| Memories (shared — in every agent's prompt unless its **Reads the shared memory too** box is unticked, or your own AEON is Local only and the agent is Roulette; with agent tools on, any agent can still read a memory file that is not withheld) | `<Vault>/Agents/Aeon/memory/memories.json` + one readable `.md` per memory | Memory Core (`src/blocks/memory_core/api/memory.cjs`), Writer saves |
| An agent and its own memories | `<Vault>/Agents/<Folder>/agent.json` and `<Vault>/Agents/<Folder>/memory/` (same shape as the shared store) | Memory Core (`src/kernel/agents.cjs` owns the layout) |
| An agent's mission log | `<Vault>/Agents/<Folder>/missions/log.json` — the last 50 things it was asked, never its answers | the streaming chat |
| An agent's scratchpad | `<Vault>/Agents/<Folder>/scratchpad.md` — at most 2,000 characters, shown to the agent every turn | the agent's `scratchpad_write` tool, and Memory Core |
| An agent's handoffs | `<Vault>/Agents/<Folder>/handoffs/<time>.md` — the newest is shown to the agent on every turn until it writes a newer one; none is deleted | `/handoff`, and a chat save when Memory Core's "Write a handoff when you save a chat" is on |
| An agent's artifacts | `<Vault>/Agents/<Folder>/artifacts/<name>.md` — never overwritten (`-2`, `-3`…) | the agent's `artifact_save` tool |
| Saved conversations | `<Vault>/Agents/Aeon/chat_sessions/` | the terminal and chat |
| Block memory | `<Vault>/blocks/<id>/` | blocks, through their declared storage contract |

## The index

`src/blocks/aeon_matrix/api/ingest.cjs` walks the Vault and keeps two files in the data root:

- **`data/vault_index.json` — the table of contents.** One entry per file: title, a
  280-character summary, folder-derived tags, and one embedding of that summary tagged with
  the space it was made in (`model#task`).
- **`data/vault_chunks.json` — the windows.** Longer documents are also cut into
  1,200-character windows, each embedded, so a sentence 4 KB into a file can be found.

**Indexed:** `.md`, `.txt`, `.json`, `.pdf`, `.html`. Word files are not read — mammoth was
removed 2026-09-12 with its eight `@xmldom/xmldom` advisories.

**Never indexed automatically:** `blocks/security` (credentials) and
`Agents/Aeon/chat_sessions`. A saved conversation includes the assistant's own turns;
indexing it would let a later answer cite an earlier model output as if it were a source.
Operator turns re-enter only through an explicit `POST /crn/second-brain/ingest/chat`.
For the same reason an agent's `scratchpad.md` and `handoffs/` are not indexed: both are
the model's own words (`src/kernel/agentWorkspace.cjs`). An agent's `artifacts/` are
documents it was asked to write, and are indexed.

**Withheld from the index and recall** (`src/kernel/vaultPrivacy.cjs`): switched-off
memories, a memory store that holds one, and the whole folder of an agent set to Local
only. The same verdicts apply to an agent's chat tools: `vault_read` and `vault_list`
refuse those paths (a Local only agent may still read and list its own folder;
switched-off memories in it stay withheld), and `vault_search` goes through the same
retriever. An agent's own working files (`scratchpad.md`, `handoffs/`, `artifacts/`)
are never opened through a link, and an agent whose `agent.json` cannot be read is
treated as Local only (`src/kernel/agents.cjs`).

### When indexing runs

1. **Every boot**, about 15 seconds after the kernel starts (`server/server.js`) —
   incremental, so only new, changed and deleted files are touched. Opening AEON from the
   Desktop icon therefore indexes on every open.
2. **Nightly**, once per day at 03:00 local time.
3. **On demand** from Matrix ▸ Index (`src/blocks/aeon_matrix/components/IndexPanel.jsx`)
   or the `/scan` and `/index-brain` commands.
4. **After block memory writes**, coalesced into one refresh (`src/kernel/vaultSync.cjs`).

A file counts as unchanged when its size and modification time match the last run. Only
one scan runs at a time; a second caller joins the one in flight.

### Embeddings

Vectors come from whatever serves the `embed` role (`src/kernel/embed.cjs`,
`src/kernel/endpoints.cjs`) — normally the local llama.cpp runtime with
nomic-embed-text, both downloaded from Cookbook (not bundled), or a hosted embedding endpoint.

- **No embedder yet:** documents are still indexed and found by keyword. Vectors are
  backfilled on the first run after a model appears, without re-reading the files.
- **A different model:** vectors from another space cannot be compared, so they are
  re-embedded. If the re-embed fails, the old vector is kept and the next run retries.
- **Reporting:** `GET /crn/second-brain/index-status` separates documents, embedded,
  missing, stale and pending, and names the active embedder.

## Recall

`src/blocks/aeon_matrix/api/retrieve.cjs` embeds the question once and ranks documents by
cosine similarity (floor 0.35, and within 0.06 of the best match), then re-scores the top 20
with a small lexical signal so a window that literally contains the question's terms is not
out-ranked by a merely similar one. Up to two windows per document are handed over, each
with its source file. There are no model calls at search time.

If nothing clears the floor, the answer is empty and the terminal says the question is not
in the index — the model is never handed nothing and asked to fill the gap.

Conversational turns (`POST /api/ai/converse`) get memory and vault recall through one
policy in `src/kernel/context.cjs`, so the terminal and the browser answer from the same
place.

## The citation gate (separate)

`src/kernel/citationGate.cjs`, mounted at `/api/retrieval` (`src/kernel/routers/retrieval.cjs`),
classifies a query deterministically into four classes and requires retrieval before the
model for classes 3 and 4. It is a different path from the recall above and is described in
[`RETRIEVAL_SCOPES.md`](RETRIEVAL_SCOPES.md).

## Cloud sync (optional)

With Supabase configured, Matrix can mirror indexed documents to a `vault_docs` table
(`src/blocks/aeon_matrix/api/cloudvault.cjs`). Without it, no document is synced to a cloud
database. That is cloud sync only: a cloud embedding model — used when the Embedding role names
one, or when none is assigned and no local embedding model is installed — receives each indexed
document's text, and a cloud chat model receives what a turn sends it.
