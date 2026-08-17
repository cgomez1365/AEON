# Aeon Matrix

**The memory layer every agent searches.** A Second Brain / RAG knowledge base
over AEON's Vault — skills, projects, memories, reading library, saved
artifacts — with keyword + semantic search, a document reader (Ask / Summary /
Search / Listen / Edit), and a 3D knowledge graph.

Nav route: `/brain`. Block id: `aeon_matrix` (renamed from `second_brain`;
the HTTP namespace was deliberately **kept** as `/api/crn/second-brain/*` for
backward compatibility — do not rename those route strings).

## What it does

- **Search-first UI** (`index.jsx`) — one search box over the whole Vault,
  sliced into facets (Skills / Projects / Memory / Library / Artifacts) by
  path pattern. A toggle switches to the 3D graph view.
- **Document reader** (`components/SecondBrainVisualizer.jsx`) — opens inside
  an overlay when a graph node is clicked (via `postMessage` from the 3D
  visualizer iframe). Renders text/PDF/image/Office docs and adds four tabs:
  - **Read** — raw content (or PDF/image preview, or extracted text for
    Office docs).
  - **Ask** — chapter-aware Q&A. Long documents are split on
    chapter/episode/part headings (or fixed 9k-char sections as a fallback);
    the question is matched to the most relevant chapter(s) client-side
    (keyword scoring, no embeddings) before the context is sent to the LLM.
  - **Summary** — brief or detailed, per-chapter or whole-document
    (map-reduce: summarize each chapter, then combine).
  - **Search** — plain keyword/line search within the open document.
  - Answers and summaries can be saved back into Notes (`/api/notes`) via
    "Save to Memory".
- **Edit mode** (`components/EditorMode.jsx`) — inline textarea editor for
  `.md`/`.txt` files; saves overwrite the file on disk and re-embed it.
- **Narrator** (`components/NarratorPlayer.jsx`) — sentence-by-sentence
  text-to-speech via the browser's `speechSynthesis` API, with themes, focus
  mode, adjustable speed/voice, and resumable playback position (persisted
  server-side).
- **Ingestion & indexing** (`api/ingest.cjs`) — incrementally walks the Vault,
  extracts text from every supported file, and maintains `vault_index.json`
  (the Table of Contents): one entry per file with title, a short summary,
  folder-derived tags, and a single embedding of that summary. Retrieval is
  then plain cosine similarity against these cached vectors — no LLM
  reasoning call needed at search time. Runs on boot, nightly (03:00 local),
  and on demand via `/index-brain`.
- **Retrieval** (`api/retrieve.cjs`) — embeds the query, ranks documents by
  cosine similarity, returns the top matches with citations. Backs both the
  block's own search and the Neural Terminal's semantic-recall step (which
  gates on an intent classifier so most chat turns skip the embed call).
- **Universal text extraction** (`api/_extract.cjs`) — any file → plain text:
  code/markdown/JSON/etc. read directly, HTML tag-stripped, DOCX via
  `mammoth`, XLSX/PPTX via raw zip/XML parsing, PDFs via `pdf-parse` with a
  fallback to page-by-page OCR (`pdfjs-dist` + `@napi-rs/canvas` +
  `tesseract.js`) for scanned PDFs, images OCR'd directly. OCR results are
  cached on disk (`data/.extract-cache/`, capped at 100 entries).
- **Cloud vault sync** (`api/cloudvault.cjs`) — optional, incremental mirror
  of indexed docs to Supabase `vault_docs` so a deployed Command Center has
  read access to Vault content. Triggered via `/vault-push`.

## API routes (this block's `api/`)

All mounted under `/api` (dual-mounted so both `/api/...` and the bare path
work, depending on kernel mount order):

| Method | Route | Purpose |
|---|---|---|
| GET | `/crn/second-brain/health` | Vault/Library/Artifacts directory status |
| GET | `/crn/second-brain/tree?section=` | Recursive file tree for a Vault section |
| GET | `/crn/second-brain/search?q=` | Filename + content grep across the Vault |
| GET | `/crn/second-brain/document?path=` | Read a document's raw text |
| GET | `/crn/second-brain/raw?path=` | Serve a raw file (images, PDFs) with correct MIME type |
| GET | `/crn/second-brain/extract?path=` | Universal text extraction (OCR fallback) — feeds Ask/Summary/Search |
| GET | `/crn/second-brain/pdf-text?path=` | Cached PDF text-layer extraction |
| GET | `/crn/second-brain/pdf?path=` | Raw PDF stream for `<iframe>` preview |
| GET | `/crn/second-brain/graph` | Vault file tree as `{ nodes, links }` for the 3D visualizer |
| GET | `/crn/second-brain/visualizer` | Serves the self-contained 3D graph HTML (`public/second_brain.html`) |
| GET | `/crn/second-brain/vendor/:file` | Vendored graph libs (local-first, no CDN dependency) |
| GET/POST | `/narrator/state` | Narrator playback position, keyed by node id |
| POST | `/crn/second-brain/ingest/chat` | Append chat turns to a real file + ToC entry |
| POST | `/crn/second-brain/ingest/document` | Create a ToC entry (and file, if content is given) — **never overwrites** an existing file |
| PUT | `/crn/second-brain/ingest/document` | Overwrite an existing file's content and re-embed it — used by Edit mode |
| DELETE | `/crn/second-brain/ingest/document` | Remove a doc's ToC + manifest entry |
| POST | `/crn/second-brain/ingest/scan-docs` | Incremental re-index, streamed via SSE |
| GET | `/crn/second-brain/index-status` | Last index run stats (doc count, errors) |
| POST | `/crn/second-brain/retrieve` | Semantic retrieval, no intent gate (block-namespaced) |
| ~~POST~~ | ~~`/search`~~ | **Deleted 2026-08-16 (§21).** Its only caller was `NeuralTerminal.jsx`, removed the same day. The recall gate and the `/matrix ` bypass live on in `dashboard/api/chat.cjs`, which re-implements them locally; retrieval itself is unchanged on `/crn/second-brain/retrieve`. |
| POST | `/crn/second-brain/vault-push` | Push new/changed docs to Supabase `vault_docs` |
| GET | `/crn/second-brain/vault-push/status` | Last push stats |

`api/sync.cjs` also lives in this folder and mounts generic `/sync/:block`
(bulk push/pull + per-block CRUD for inventory, clients, scheduler, staff,
etc.) and `/logistics/*` routes. These predate the `second_brain` →
`aeon_matrix` rename and aren't part of the Second Brain feature set — they
were extracted from other blocks' modules and happen to be mounted from
here. Left as-is; flagged for a future cleanup (see block owner notes).

## Config / settings

No `settings_keys` are declared in the manifest. Behavior is controlled
entirely by environment variables (below) plus two constants in
`api/ingest.cjs`: `NIGHTLY_HOUR` (auto-reindex time, default 3am local) and
`SUMMARY_CHARS` (ToC summary length, 280 chars).

## Dependencies

- **Bundled local runtime** (free, private, no daemon) — an embedding model
  such as `nomic-embed-text-q8`, installed through Cookbook and managed inside
  AEON's own data root. Required for the query side of retrieval to work well;
  without it, indexing and search fall back to Gemini.
- **Gemini embedding fallback** — `text-embedding-004`, used when no local
  embedding model is installed. Rotates across `GEMINI_PAID_KEY`, `GEMINI_API_KEY`, and any
  `GEMINI_FREE_KEY_1..N` on 429s. Vectors from different embedding models
  are never compared against each other (tagged per-entry via
  `embeddingModel`).
- **Supabase** (optional) — `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  used only by `vault-push` (cloud mirror) and `api/sync.cjs`'s generic
  block sync. Everything else works fully offline.
- **pdf-parse, mammoth, adm-zip, pdfjs-dist, @napi-rs/canvas, tesseract.js**
  — document/OCR extraction pipeline (`api/_extract.cjs`, `api/_lib.cjs`).
  All are soft dependencies: extraction methods that need a missing package
  fail gracefully rather than crashing the router.

## Data layout (`data/`, gitignored — see scope note)

```
data/
  Vault/                  # BRAIN_DIR — the indexed knowledge base
    Reading_Library/       # nested section, gets its own graph/search facet
    Saved_Artifacts/       # nested section, gets its own graph/search facet
    Chat_History/           # per-session .md files written by ingest/chat
  vault_index.json         # Table of Contents: path, title, summary, tags, embedding
  index_manifest.json      # hash-based change detection (size+mtime), not committed to the ToC
  index_status.json        # last run stats, surfaced in Settings ▸ Installed blocks
  narrator-state.json      # per-node playback position for the Narrator
  cloudvault_state.json    # last vault-push hashes, for incremental cloud sync
  .extract-cache/          # cached OCR results, capped at 100 entries
```

`data/Vault` is an NTFS junction on this machine pointing outside the repo —
never assume it's a real directory or "fix" paths found inside it.

## Local vs. cloud

Ingestion, extraction, and the file-backed routes are **local-only** — they
no-op or return a clear "cloud env" reason when `deps.isVercel` is true,
since the Vault lives on the local filesystem. `vault-push` is the bridge:
run it locally to mirror indexed docs into Supabase so a deployed instance
can still read (not write) Vault content.
