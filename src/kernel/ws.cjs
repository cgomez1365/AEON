const WebSocket = require('ws');

/**
 * /ws — the live terminal event stream.
 *
 * An upgrade request never passes through Express middleware, so the HTTP
 * session guard does not cover it, and WebSocket has no CORS: the browser will
 * open a socket to any origin and hand the page every message. Until
 * 2026-09-23 this server accepted every upgrade — measured: a client sending
 * `Origin: https://evil.example` and no session opened /ws on a server with an
 * operator account and the guard ON. Any page the operator visited could read
 * the stream.
 *
 * The rule (checked here, before the upgrade completes):
 *  1. Origin. A browser always sends one. Allowed: this server's own loopback
 *     origin (localhost / 127.0.0.1 / [::1] on the port the request came in on),
 *     the Vite dev server, and AEON_ALLOWED_ORIGINS. Anything else is 403 —
 *     including other localhost ports and a DNS-rebinding hostname, whether or
 *     not an account exists. No Origin header = not a browser (CLI, script);
 *     that is not a cross-site risk and goes on to step 2.
 *  2. Session. Once an operator account exists, the same validateSession() the
 *     HTTP guard uses must pass: aeon_session cookie, Bearer, ?token=, or the
 *     AEON_MOBILE_SECRET machine bearer. Otherwise 401.
 *     With NO account nothing in AEON can hold a session and every route is
 *     open by design (first run); /ws mirrors that and asks for none.
 *     Unlike the HTTP guard, turning the guard OFF does not open /ws — same as
 *     manifest routes declared auth:true, which also stay closed once an
 *     account exists.
 */
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function envOrigins(env = process.env) {
  return String(env.AEON_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function hostPort(value, defaultPort) {
  // "127.0.0.1:3001" / "[::1]:3001" / "localhost"
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(value || '').trim().toLowerCase());
  if (!m) return null;
  return { host: m[1], port: Number(m[2] || defaultPort) };
}

/** Is `origin` this server's own page, served over loopback? */
function isOwnLoopbackOrigin(origin, hostHeader) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  const o = hostPort(u.host, u.protocol === 'https:' ? 443 : 80);
  const h = hostPort(hostHeader, 80);
  if (!o || !h) return false;
  return LOOPBACK_HOSTS.has(o.host) && LOOPBACK_HOSTS.has(h.host) && o.port === h.port;
}

/**
 * Decide an upgrade. Pure apart from validateSession's own lastSeen touch.
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 */
function checkUpgrade(req, { sessions, allowedOrigins = [] } = {}) {
  const origin = req.headers?.origin;
  if (origin) {
    const allow = [...DEV_ORIGINS, ...envOrigins(), ...allowedOrigins];
    if (!allow.includes(origin) && !isOwnLoopbackOrigin(origin, req.headers?.host)) {
      return { ok: false, status: 403, reason: `origin not allowed: ${origin}` };
    }
  }
  if (sessions && sessions.hasAccount()) {
    let query = {};
    try { query = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams); } catch {}
    const v = sessions.validateSession({ headers: req.headers || {}, query });
    if (!v.ok) return { ok: false, status: 401, reason: v.reason || 'no-session' };
  }
  return { ok: true };
}

module.exports = function attachWS(server, deps) {
  const { aeonTerminalStream } = deps;
  const log = deps.log || console;
  // Required lazily (not at module scope): sessionValidator resolves the Vault
  // path when first loaded, and tests set it before requiring.
  const sessions = deps.sessions || require('./server-utils/sessionValidator.cjs');
  const allowedOrigins = deps.allowedOrigins || [];

  const wss = new WebSocket.Server({
    server,
    path: '/ws',
    verifyClient: (info, cb) => {
      let verdict;
      try { verdict = checkUpgrade(info.req, { sessions, allowedOrigins }); }
      catch (e) { verdict = { ok: false, status: 500, reason: `check failed: ${e.message}` }; }
      if (verdict.ok) return cb(true);
      // R-05: a refused socket is said out loud, with the reason.
      try { log.warn(`[WS] refused ${verdict.status}: ${verdict.reason}`); } catch {}
      return cb(false, verdict.status, verdict.status === 403 ? 'Forbidden origin' : 'Unauthorized');
    },
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

    const onLog = (evt) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(evt));
      }
    };
    aeonTerminalStream.on('log', onLog);

    ws.on('close', () => aeonTerminalStream.removeListener('log', onLog));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
      } catch {}
    });
  });

  try { log.log('[KERNEL] WebSocket server attached at /ws (origin + session checked on upgrade)'); } catch {}
  return wss;
};

module.exports.checkUpgrade = checkUpgrade;
module.exports.isOwnLoopbackOrigin = isOwnLoopbackOrigin;
