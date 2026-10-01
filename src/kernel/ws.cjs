const WebSocket = require('ws');
const net = require('net');

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
 *  0. Host. The name the request was sent to must be one this AEON answers
 *     to (checkHost below — the same check every HTTP request gets).
 *  1. Origin. A browser always sends one. Allowed: this server's own origin
 *     (localhost / 127.0.0.1 / [::1] on the port the request came in on, or
 *     the running tunnel's name), the Vite dev server, and
 *     AEON_ALLOWED_ORIGINS. Anything else is 403 —
 *     including other localhost ports and a DNS-rebinding hostname, whether or
 *     not an account exists. No Origin header = not a browser (CLI, script);
 *     that is not a cross-site risk and goes on to step 2.
 *     A tunnel visitor is refused while login is off.
 *  2. Session. Once an operator account exists, the same validateSession() the
 *     HTTP guard uses must pass: aeon_session cookie, Bearer, ?token=, or the
 *     AEON_MOBILE_SECRET machine bearer. Otherwise 401.
 *     With NO account nothing in AEON can hold a session and every route is
 *     open by design (first run); /ws mirrors that and asks for none.
 *     Unlike the HTTP guard, turning the guard OFF does not open /ws — same as
 *     manifest routes declared auth:true, which also stay closed once an
 *     account exists.
 */
const DEV_ORIGINS = Object.freeze(['http://localhost:3000', 'http://127.0.0.1:3000']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// The process-wide tunnel registry Settings keeps (src/blocks/settings/api/
// connectivity.js, TUNNELS). Read, never written, from here.
const TUNNELS_KEY = Symbol.for('aeon.settings.tunnels');

function envOrigins(env = process.env) {
  return String(env.AEON_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function hostPort(value, defaultPort) {
  // "127.0.0.1:3001" / "[::1]:3001" / "localhost"
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(value || '').trim().toLowerCase());
  if (!m) return null;
  return { host: m[1], port: Number(m[2] || defaultPort), explicit: m[2] !== undefined };
}

/** A name or address that only ever means this machine. */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** An IP address literal ("192.168.1.5", "[fe80::1]"), not a DNS name. */
function isAddress(host) {
  return net.isIP(String(host || '').replace(/^\[|\]$/g, '')) !== 0;
}

/** Hostnames of the Cloudflare tunnels running in this process right now. */
function liveTunnelHosts() {
  const hosts = new Set();
  const reg = globalThis[TUNNELS_KEY];
  if (!reg || typeof reg.values !== 'function') return hosts;
  for (const t of reg.values()) {
    if (!t || !t.proc || !t.url) continue;
    try { hosts.add(new URL(t.url).hostname.toLowerCase()); } catch { /* not a URL */ }
  }
  return hosts;
}

/**
 * Does this AEON answer to the name in a request's Host header?
 *
 * DNS rebinding (measured at e44058b, 2026-09-29): a page on evil.example
 * re-points its own name at 127.0.0.1, and the browser then treats AEON as
 * evil.example — same origin, so no CORS and no Origin header on a GET. The
 * one thing it cannot change is the Host header, which still says
 * evil.example. GET /api/settings, /api/store/source and /api/build/queue
 * answered such a request 200 before an account existed.
 *
 * Answered:
 *  - localhost, *.localhost, 127.x.x.x, [::1], or any IP address, on the port
 *    the request arrived on. An address cannot be re-pointed by DNS, and
 *    AEON_BIND=0.0.0.0 is reached by one (http://192.168.1.5:3001).
 *  - the hostname of a Cloudflare tunnel Settings is running right now.
 *    cloudflared passes the public name through as Host.
 *  - a hostname named in AEON_ALLOWED_ORIGINS (a reverse proxy, a LAN name).
 * No Host header at all is answered: only an HTTP/1.0 client can send that,
 * never a browser, and this check exists for browsers.
 *
 * `port` is the port the connection arrived on (req.socket.localPort), not a
 * configured value — the drive's launchers pick 3001-3020.
 *
 * @returns {{ok: true, via: string} | {ok: false, reason: string}}
 */
function checkHost(hostHeader, { port, env = process.env, tunnelHosts = liveTunnelHosts() } = {}) {
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return { ok: true, via: 'none' };
  const h = hostPort(hostHeader, 80);
  if (!h) return { ok: false, reason: `unreadable Host "${hostHeader}"` };
  if (isLoopbackHost(h.host) || isAddress(h.host)) {
    if (port === undefined || h.port === Number(port)) return { ok: true, via: isLoopbackHost(h.host) ? 'loopback' : 'address' };
    return { ok: false, reason: `Host "${hostHeader}" names port ${h.port}; this AEON is on ${port}` };
  }
  if (tunnelHosts.has(h.host)) return { ok: true, via: 'tunnel' };
  for (const o of envOrigins(env)) {
    try { if (new URL(o).hostname.toLowerCase() === h.host) return { ok: true, via: 'configured' }; } catch { /* skip */ }
  }
  return { ok: false, reason: `Host "${hostHeader}" is not a name this AEON answers to` };
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
 * Is `origin` the page this request's Host serves? Loopback names are one
 * machine, so localhost and 127.0.0.1 on the same port match. Any other name
 * must match exactly; a Host with no port (a tunnel or a reverse proxy, where
 * the page is https on 443 and the hop to AEON is http) matches on the name.
 * Only meaningful AFTER checkHost passed: a rebinding page's Origin and Host
 * are both evil.example, and match each other.
 */
function isOwnOrigin(origin, hostHeader) {
  if (isOwnLoopbackOrigin(origin, hostHeader)) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  const o = hostPort(u.host, u.protocol === 'https:' ? 443 : 80);
  const h = hostPort(hostHeader, 80);
  if (!o || !h || isLoopbackHost(o.host)) return false;
  return o.host === h.host && (!h.explicit || o.port === h.port);
}

/**
 * Does this AEON answer a browser page served from `origin`?
 *
 * Its own page (above), the Vite dev server (`npm start`, :3000) and
 * AEON_ALLOWED_ORIGINS. Not "any localhost port": a page another program
 * serves on this machine is not AEON, and until 2026-09-30 HTTP let every
 * one of them in with credentials (audit A055) while /ws already refused it.
 * "null" (sandboxed frames, file://) is refused.
 */
function checkOrigin(origin, hostHeader, { env = process.env, allowedOrigins = [] } = {}) {
  if (origin === undefined || origin === null || origin === '') return { ok: true };
  if ([...DEV_ORIGINS, ...envOrigins(env), ...allowedOrigins].includes(origin)) return { ok: true };
  if (isOwnOrigin(origin, hostHeader)) return { ok: true };
  return { ok: false, reason: `origin not allowed: ${origin}` };
}

/**
 * Decide an upgrade. Pure apart from validateSession's own lastSeen touch.
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 */
function checkUpgrade(req, { sessions, allowedOrigins = [] } = {}) {
  const host = checkHost(req.headers?.host, { port: req.socket?.localPort });
  if (!host.ok) return { ok: false, status: 403, reason: host.reason };
  const origin = checkOrigin(req.headers?.origin, req.headers?.host, { allowedOrigins });
  if (!origin.ok) return { ok: false, status: 403, reason: origin.reason };
  // A tunnel visitor is the internet. With no account, or the guard off,
  // nothing would stand between them and the stream (see server/earlyware.cjs).
  if (host.via === 'tunnel' && sessions && !sessions.guardActive()) {
    return { ok: false, status: 403, reason: 'tunnel request while login is off' };
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
// The same rule for HTTP: server/earlyware.cjs (Host + Origin on every request)
// and the Security block's pre-account export check.
module.exports.checkHost = checkHost;
module.exports.checkOrigin = checkOrigin;
module.exports.isLoopbackHost = isLoopbackHost;
module.exports.liveTunnelHosts = liveTunnelHosts;
module.exports.DEV_ORIGINS = DEV_ORIGINS;
module.exports.TUNNELS_KEY = TUNNELS_KEY;
