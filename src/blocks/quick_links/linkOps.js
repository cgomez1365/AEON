// Quick Links list operations — pure, so they are testable without a DOM
// (tests/home-blocks-ui-logic.test.js). The page persists whatever these
// return through AeonContext's updateLinks → /api/sync/quick_links.

/**
 * An address a link may point at: http(s) only. Anything else — javascript:,
 * data:, file: — returns null. Links also arrive from the terminal's link
 * command and from other clients through the sync route, not only from this
 * form, and `window.open(url)` is not protected by React's href sanitising.
 */
export function safeHref(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** What the operator typed → a storable address, or null. Bare hosts get https://. */
export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return safeHref(withScheme);
}

/**
 * Move a link up (-1) or down (+1) past the next link IN ITS CATEGORY.
 * The list is stored flat; the page renders it grouped, so swapping with the
 * flat neighbour could move a link into a different visible group's order
 * without anything on screen changing.
 */
export function moveLink(links, id, delta) {
  const list = Array.isArray(links) ? links.slice() : [];
  const i = list.findIndex(l => l.id === id);
  if (i < 0) return list;
  const cat = list[i].category || 'General';
  let j = i + delta;
  while (j >= 0 && j < list.length && (list[j].category || 'General') !== cat) j += delta;
  if (j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

/** Edit one link's name/url/category. Returns { links, error }. */
export function editLink(links, id, fields = {}) {
  const list = Array.isArray(links) ? links : [];
  const i = list.findIndex(l => l.id === id);
  if (i < 0) return { links: list, error: 'That link no longer exists.' };
  const next = { ...list[i] };
  if (fields.name !== undefined) {
    const name = String(fields.name).trim();
    if (!name) return { links: list, error: 'A link needs a name.' };
    next.name = name;
  }
  if (fields.url !== undefined) {
    const url = normalizeUrl(fields.url);
    if (!url) return { links: list, error: 'Only http:// and https:// addresses can be saved.' };
    next.url = url;
  }
  if (fields.category !== undefined) next.category = String(fields.category).trim() || 'General';
  const out = list.slice();
  out[i] = next;
  return { links: out, error: null };
}

/**
 * Why links are not reaching the server, in words that name the fix.
 * `linksError` is AeonContext's message; `storeStatus` is the HTTP status of a
 * direct probe of the links store (0 = no answer), or undefined if unprobed.
 */
export function storeProblem(linksError, storeStatus) {
  if (!linksError) return null;
  if (storeStatus === 404) {
    return 'Quick Links saves through the Aeon Matrix block, which is not installed. '
      + 'Links you add now stay in this browser only and will not reach the server.';
  }
  if (storeStatus === 401) return 'Your session expired — sign in again to save links.';
  return linksError;
}
