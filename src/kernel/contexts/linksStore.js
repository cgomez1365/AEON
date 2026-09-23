// Quick Links persistence — pure helpers (injected fetch + storage) so the
// logic is testable without a DOM. Source of truth is the server's
// /api/sync/quick_links (a local JSON file in the data home; Supabase mirrors
// it only when configured). localStorage is a cache/offline fallback.
// Every failure is RETURNED, never swallowed (R-05).
export const LINKS_KEY = 'aeon_links';
export const LINKS_URL = '/api/sync/quick_links';
// The Quick Links page explains a failure itself (including a missing Aeon
// Matrix block, which serves this route); without this every page raised the
// global "[API FAILED]" banner for it (2026-09-23).
const OWN = { 'x-aeon-self-reported': '1' };

export function readLocalLinks(storage) {
  try {
    const raw = storage && storage.getItem(LINKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function writeLocalLinks(storage, items) {
  try { storage.setItem(LINKS_KEY, JSON.stringify(items)); } catch { /* cache only */ }
}

async function post(fetcher, items) {
  const r = await fetcher(LINKS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...OWN }, body: JSON.stringify({ data: items }) });
  if (r.ok) return { ok: true, error: null };
  let detail = '';
  try { const b = await r.json(); detail = b.error || ''; } catch { /* no body */ }
  return { ok: false, error: `Links were not saved (HTTP ${r.status}${detail ? `: ${detail}` : ''})` };
}

/** Save the whole list. Always refreshes the local cache; reports server failure. */
export async function saveLinks(items, { fetcher, storage }) {
  writeLocalLinks(storage, items);
  try { return await post(fetcher, items); }
  catch (e) { return { ok: false, error: `Links were not saved to the server (${e.message})` }; }
}

/** Load from the server; migrate legacy local-only links up; fall back to cache with an error. */
export async function loadLinks({ fetcher, storage }) {
  const local = readLocalLinks(storage);
  try {
    const r = await fetcher(LINKS_URL, { headers: { ...OWN } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const server = Array.isArray(body && body.data) ? body.data : [];
    if (server.length === 0 && local.length > 0) {
      const p = await post(fetcher, local);
      return { items: local, source: 'local-migrated', error: p.ok ? null : p.error };
    }
    writeLocalLinks(storage, server);
    return { items: server, source: 'server', error: null };
  } catch (e) {
    return { items: local, source: 'local-cache', error: `Could not reach the links store; showing this browser's cached copy (${e.message})` };
  }
}
