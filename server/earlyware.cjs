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

// ── Host + Origin, ahead of everything ────────────────────────────────────
//
// Measured on a fresh install at e44058b and again at fe93dbf (no account):
//  - `Host: evil.example:PORT` (DNS rebinding) read GET /api/settings,
//    /api/store/source and /api/build/queue — 200.
//  - A page on another localhost port (Origin http://localhost:8080) was let
//    in with credentials: it read /api/settings, reached POST
//    /api/store/install, and took the pre-account credential export, vault
//    master key included (audit A055, A058).
//  - Origin https://aeon-cortex.vercel.app, a Vercel name that serves nothing
//    and was never deployed, was trusted the same way (A117).
//  - A refused origin came back 500 "Internal Core Error" (the cors package
//    hands its refusal to the error handler), as if AEON had broken.
//
// Now one rule, src/kernel/ws.cjs (checkHost, checkOrigin) — the one /ws
// already used for origins — answers every request: a Host AEON does not
// answer to is 421, a browser page from anywhere but AEON itself, the Vite
// dev server or AEON_ALLOWED_ORIGINS is 403, each with the reason. CORS
// headers are then sent only for an origin that passed.
//
// A tunnel visitor arrives from 127.0.0.1, like this machine (the tunnel gate,
// rate limiter and pre-account rules all read the socket). Their Host is the
// tunnel's name, so it is told apart here: refused while login is off.
// Settings refuses to START a tunnel without login, but login can be switched
// off while one runs.
function createRequestGuard({ policy = require('../src/kernel/ws.cjs'), sessions, log = console, env = process.env } = {}) {
  const getSessions = () => sessions || require('../src/kernel/server-utils/sessionValidator.cjs');
  // One line per refused value per minute: a page that loops on a refused
  // request must not flood the console.
  const lastSaid = new Map();
  const say = (key, line) => {
    const now = Date.now();
    if (now - (lastSaid.get(key) || 0) < 60 * 1000) return;
    if (lastSaid.size > 200) lastSaid.clear();
    lastSaid.set(key, now);
    try { log.warn(line); } catch { /* console gone */ }
  };
  const refuse = (req, res, status, reason, error) => res.status(status).json({
    correlation_id: req.correlationId || 'AEON-SYS', error, reason,
  });

  function requestGuard(req, res, next) {
    const hostHeader = req.headers.host;
    const port = req.socket && req.socket.localPort;
    const host = policy.checkHost(hostHeader, { port, env });
    if (!host.ok) {
      say(`host:${hostHeader}`, `[SECURITY] Refused ${req.method} ${req.path}: ${host.reason}.`);
      return refuse(req, res, 421, 'host-not-allowed',
        `This AEON answers to localhost, 127.0.0.1, [::1] or an IP address on port ${port}, not to "${hostHeader}". `
        + 'To reach it under another name, list that origin in AEON_ALLOWED_ORIGINS.');
    }
    const origin = policy.checkOrigin(req.headers.origin, hostHeader, { env });
    if (!origin.ok) {
      say(`origin:${req.headers.origin}`, `[SECURITY] Refused ${req.method} ${req.path}: ${origin.reason}.`);
      return refuse(req, res, 403, 'origin-not-allowed',
        `This AEON does not answer pages served from ${req.headers.origin}. `
        + 'It answers its own pages, the Vite dev server (http://localhost:3000) and origins listed in AEON_ALLOWED_ORIGINS.');
    }
    if (host.via === 'tunnel') {
      let loginOn = false;
      try { loginOn = getSessions().guardActive(); } catch { loginOn = false; }
      if (!loginOn) {
        say('tunnel', `[SECURITY] Refused ${req.method} ${req.path} through the tunnel: login is off.`);
        return refuse(req, res, 403, 'tunnel-without-login',
          'Remote access is closed while login is off. Turn "Require login" back on (Security) on the computer running AEON.');
      }
    }
    return next();
  }

  // CORS headers for what passed above. The delegate form sees the request,
  // which "is this the page's own origin" needs; an origin the guard would
  // refuse gets no CORS headers even if this runs without it.
  const cors = require('cors')((req, cb) => cb(null, {
    origin: !!req.headers.origin && policy.checkOrigin(req.headers.origin, req.headers.host, { env }).ok,
    credentials: true,
  }));

  return { requestGuard, cors };
}

module.exports = {
  createEarlyware,
  createAppJsonParser, bodyTooLargeReply, APP_JSON_LIMIT, OWN_JSON_LIMIT_PATHS,
  createRequestGuard,
};
