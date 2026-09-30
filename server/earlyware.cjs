/**
 * Dynamic earlyware registry (BO4).
 *
 * A block registers cross-cutting middleware (auth guard, no-store shield) by a
 * STABLE id via the kernel's registerEarlyMiddleware hook. Re-registering the
 * same id REPLACES the prior entry instead of appending — so a Security rescan,
 * which re-requires and re-runs guardian.cjs every time, leaves exactly ONE
 * Guardian in the chain instead of stacking a new one per rescan.
 *
 * Anonymous (unlabeled) registrations always append: they can't be
 * de-duplicated, so this preserves the pre-BO4 behavior for them.
 */
function createEarlyware() {
  const entries = []; // { id, fn }

  function register(fn, id = 'anonymous') {
    if (typeof fn !== 'function') return { replaced: false, count: entries.length };
    if (id !== 'anonymous') {
      const existing = entries.findIndex((e) => e.id === id);
      if (existing >= 0) {
        entries[existing] = { id, fn };
        return { replaced: true, count: entries.length };
      }
    }
    entries.push({ id, fn });
    return { replaced: false, count: entries.length };
  }

  function remove(id) {
    const existing = entries.findIndex((e) => e.id === id);
    if (existing < 0) return false;
    entries.splice(existing, 1);
    return true;
  }

  // Express middleware: run each registered fn early, in registration order,
  // threading a shared `next` so any one can short-circuit. A thrown handler is
  // surfaced to the outer next(err), never swallowed.
  function middleware(req, res, next) {
    let i = 0;
    const run = (err) => {
      if (err) return next(err);
      const entry = entries[i++];
      if (!entry) return next();
      try { entry.fn(req, res, run); } catch (e) { next(e); }
    };
    run();
  }

  return {
    register,
    remove,
    middleware,
    list: () => entries.map((e) => e.id),
    get count() { return entries.length; },
  };
}

// ── The app-wide JSON body parser ─────────────────────────────────────────
//
// It runs ahead of every router, and a route-level parser can only narrow its
// limit, never widen it: the global parser has already read the body, or
// refused it. /file-drop and the Matrix /upload declare 36 MB (a 25 MB
// document is about 34 MB as base64 JSON), yet everything over the app-wide
// 10 MB — a 7.5 MB file — was refused with a 413 before their own parser ran,
// and the terminal card read "[DROP] Internal Core Error." (2026-09-28).
//
// For the paths below the app-wide parser steps aside, and the route's own
// parser and limit are the only ones. An entry MUST have express.json on its
// route, or its handler sees no body; tests/sweep-server-json-limit.test.js
// checks both directions (every entry parses its own body, every route-level
// limit above the app-wide one is listed here).
const APP_JSON_LIMIT = '10mb';
const OWN_JSON_LIMIT_PATHS = [
  '/api/console/file-drop',                     // src/kernel/routers/console.cjs, mounted at /api/console
  '/api/crn/second-brain/upload',               // src/blocks/aeon_matrix/api/ingest.cjs, /api mount
  '/block/aeon_matrix/crn/second-brain/upload', // the same route, block mount
];

// Express matches routes case-insensitively and with or without a trailing
// slash; the step-aside matches the same way, or /API/console/file-drop
// would reach the route with the 10 MB limit back in front of it.
const routeKey = (p) => String(p || '').toLowerCase().replace(/\/+$/, '') || '/';

function createAppJsonParser({ json = require('express').json, limit = APP_JSON_LIMIT, ownLimitPaths = OWN_JSON_LIMIT_PATHS } = {}) {
  const parse = json({ limit });
  const own = new Set(ownLimitPaths.map(routeKey));
  return function appJson(req, res, next) {
    if (own.has(routeKey(req.path))) return next();
    return parse(req, res, next);
  };
}

// A body over its limit is the sender's size, not a fault in AEON. The reply
// names both sizes so the terminal card can say what to do; null for every
// other error, which stays with the global error handler.
function bodyTooLargeReply(err) {
  if (!err || err.type !== 'entity.too.large') return null;
  const mb = (n) => {
    const v = n / (1024 * 1024);
    return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
  };
  const limit = Number(err.limit);
  const length = Number(err.length);
  const has = (n) => Number.isFinite(n) && n > 0;
  const error = has(length) && has(limit)
    ? `Too large: this request is ${mb(length)}; the limit here is ${mb(limit)}.`
    : `Too large: this request is over the ${has(limit) ? mb(limit) : 'size'} limit here.`;
  return { status: 413, body: { error, limit: has(limit) ? limit : null, length: has(length) ? length : null } };
}

module.exports = {
  createEarlyware,
  createAppJsonParser, bodyTooLargeReply, APP_JSON_LIMIT, OWN_JSON_LIMIT_PATHS,
};
