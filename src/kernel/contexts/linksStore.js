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

/**
 * The server's list with this browser's changes laid over it: every server
 * link is kept, a link with the same id (or, lacking one, the same address)
 * takes this browser's version, and links only this browser has are added.
 * A delete made while the store was out of reach can come back; a link the
 * server holds can never be lost to a stale cache.
 */
export function mergeLinks(server, local) {
  const key = (l) => (l && (l.id ?? l.url)) ?? null;
  const mine = new Map(local.filter(key).map((l) => [key(l), l]));
  const out = server.map((l) => (mine.has(key(l)) ? mine.get(key(l)) : l));
  const seen = new Set(server.map(key));
  for (const l of local) if (!seen.has(key(l))) out.push(l);
  return out;
}

/**
 * Save the whole list. Always refreshes the local cache; reports server failure.
 *
 * `lastSource` is where the list being saved came from. Anything but
 * 'server' means the page was showing this browser's cache because the store
 * could not be read (a load before sign-in answers 401, found live
 * 2026-10-02). Posting that list as it stood would REPLACE the server's with
 * whatever this browser happened to hold, so the server's list is read first
 * and the two are merged. The merged list is returned for the page to show.
 */
export async function saveLinks(items, { fetcher, storage, lastSource = 'server' }) {
  let list = items;
  if (lastSource !== 'server') {
    try {
      const r = await fetcher(LINKS_URL, { headers: { ...OWN } });
      if (r.ok) {
        const body = await r.json();
        const server = Array.isArray(body && body.data) ? body.data : [];
        list = mergeLinks(server, items);
      }
    } catch { /* still unreachable: the post below reports it */ }
  }
  writeLocalLinks(storage, list);
  try { return { ...(await post(fetcher, list)), items: list }; }
  catch (e) { return { ok: false, error: `Links were not saved to the server (${e.message})`, items: list }; }
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
