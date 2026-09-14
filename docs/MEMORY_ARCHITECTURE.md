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
| Memories | `<Vault>/Agents/Aeon/memory/memories.json` + one readable `.md` per memory | Memory Core (`src/blocks/memory_core/api/memory.cjs`), Writer saves |
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
`src/kernel/endpoints.cjs`) — normally the bundled llama.cpp runtime with
nomic-embed-text, installed from Cookbook, or a hosted embedding endpoint.

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
(`src/blocks/aeon_matrix/api/cloudvault.cjs`). Without it, nothing leaves the machine.
