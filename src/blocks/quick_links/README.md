# 🔗 AEON Block: Quick Links

**ID:** `quick_links`
**Route:** `/links`
**Status:** `ACTIVE`
**Tier:** `core` (frontend-only — no API routes)

## What it does

A compact, categorized bookmark manager. Lets you search, add, and delete
links (bookmarks, portals, ops URLs) grouped into collapsible categories
(General, Workspace, Dev Ops, Database, Integrations, Personal, Active
Portals, Codebases, Client). Each entry shows its favicon and domain and
opens in a new tab.

## Files

- `index.jsx` — the entire block. No `api/` folder — this block makes no
  server calls of its own and registers no Express routes.
- `block.manifest.json` — OS Kernel metadata (auto-loaded by
  `src/kernel/blockStandard.cjs` on boot).
- `.aeon.runtime.json` — **auto-generated on every boot, do not edit.**
  Overwritten by the kernel; changes here don't persist.

## Data persistence

This block does **not** own a JSON file or an API route. All state comes
from the shared `AeonContext` provider
(`src/kernel/contexts/AeonContext.jsx`) via `useAeonContext()`:

- `links` — the array of `{ id, name, url, category }` entries.
- `manageLinks({ action: 'add' | 'delete', ... })` — the mutator the
  add-form and delete button call.

`AeonContext` persists links to the shared Firestore collection
`aeon_state` (document `links`, `{ items: [...] }`) alongside the other
shared stores (clients, inventory, scheduler, dictionary, trash), and
mirrors the same data to `localStorage` under the key `aeon_links` for
instant load / offline fallback. Deletions route through the shared trash
store (`moveToTrash`) rather than being destroyed immediately.

Favicons are fetched client-side, per link, from Google's public favicon
service (`https://www.google.com/s2/favicons?domain=...`) — this is the
block's one real external network dependency; it needs no API key or
secret.

## To activate

This block is automatically detected by the AEON kernel
(`src/kernel/blockStandard.cjs`) from `block.manifest.json`. Drop this
folder into `src/blocks/` and restart the Command Center.
