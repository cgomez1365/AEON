# AEON Block: Files

**ID:** `files`
**Route:** `/files`
**Icon:** 📁
**Tier:** `core`
**Status:** `ACTIVE`

Dual-pane file browser and document manager. Browses the local disk and a
Supabase Storage cloud bucket side by side, with upload, download, delete,
inline preview, and in-browser text/code editing. Uploads that land in the
Second Brain folder trigger an automatic re-index.

## What it does

- **Local pane** — browses the host filesystem starting at `WORKSPACE`
  (`src/config.js`). Backed by `src/blocks/host_os/api/fs.cjs`
  (`/api/fs/list`, `/read`, `/write`, `/delete`, `/upload`, `/serve`,
  `/mkdir`). That router is desktop-only (`host_os` manifest sets
  `contract.targets.vercel: false`) and 403s every local-fs route when
  running on Vercel — there is no persistent local disk in serverless.
- **Cloud pane** — browses a Supabase Storage bucket (`aeon-files`) directly
  from the browser via `src/kernel/supabase.js`. Folders are modeled as
  `.keep` placeholder objects (Supabase Storage has no real directories).
- **Dual view** — both panes side by side (local dev only; the toggle is
  hidden when the app isn't running on `localhost`/`127.0.0.1`).
- **Upload** — drag-and-drop onto the file list, or the **Upload** button
  (native file picker). Both paths call the same `uploadFilesList()`
  function, so drag-and-drop is a convenience layer, not the only way in —
  keyboard/screen-reader users have the button as a fully equivalent
  alternative.
- **Download / Delete** — per-row icon buttons. Cloud downloads use a
  60-second Supabase signed URL; local downloads stream through
  `/api/fs/serve?download=1`.
- **Preview** — images/PDF/video open in a modal viewer (cloud: signed URL,
  60s; local: `/api/fs/serve`).
- **Edit** — text-ish files (`.txt .md .json .js .jsx .html .css .py .bat`)
  open in an in-browser textarea editor (local mode only) and save back via
  `/api/fs/write`.
- **Second Brain re-index** — any local upload under
  `WORKSPACE/Data/Second_Brain` triggers `tools/incremental-index.mjs` after
  the upload completes (fire-and-forget, logged, non-blocking). This is
  handled by `host_os/api/fs.cjs`, not by this block's own code.

## Files

| File | Purpose |
|---|---|
| `block.manifest.json` | Block Standard v4 manifest (permissions, routes, env, deployment target `hybrid`) |
| `index.jsx` | Main UI — `FileManager` (local/cloud/dual toggle, preview modal, editor modal) + `FilePane` (per-mode browser) |
| `api/notes.js` | `/api/notes` CRUD (CommonJS plugin pattern) — Supabase `aeon_notes` table, used for CEO notes, vault-synced on every write |
| `api/fs/read.js`, `api/fs/write.js` | `/api/fs/read`, `/api/fs/write` — **Vercel-only** proxy that reads/writes generic small JSON blobs to the Supabase `app_state` table (keyed by filename minus extension), standing in for local disk access when deployed serverless. Not loaded in local dev — locally `host_os/api/fs.cjs` owns these same routes against real disk. CommonJS plugin pattern, matching `api/notes.js`. |
| `components/DataNotes.jsx` | A markdown notes editor (`Daily Notes.md` / `Inbox.md` / `Master List.md` under `AGENTS_DIR`) that calls `/api/fs/read` and `/api/fs/write`. **Not currently wired into `index.jsx` or any route** — the block loader only auto-mounts each block's `index.jsx` (see `src/kernel/blockRegistry.js`), so this component is dead code today. Left in place pending a decision on whether to surface it (e.g. as a tab inside `FileManager`) or remove it. |

## Cloud requirements

Declared in the manifest: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(`requires.env`), `supabase` (`requires.apis`). All Supabase access in this
block is a **soft dependency** — if the keys aren't configured,
`src/kernel/supabase.js` exports `null` and every cloud-mode code path
(`loadDir`, `handleCreateFolder`, `uploadFilesList`, `handleDelete`,
`handleFileClick`, `handleDownload`) fails soft with a friendly
"Cloud storage not configured — add Supabase keys in Settings." message
instead of throwing. Local-only usage works with zero cloud config.

## To activate

Auto-detected by the AEON kernel's block loader — drop a folder with a
`block.manifest.json` + `index.jsx` under `src/blocks/` and it appears in
the nav with zero edits elsewhere. No restart needed in dev (hot-remount via
`kernel.rescan()`).
