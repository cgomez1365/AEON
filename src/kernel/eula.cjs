'use strict';
/**
 * The AEON License Agreement gate (EULA.md).
 *
 * AEON asks the operator to accept the agreement the first time it starts, and
 * again whenever EULA.md's version changes. Until then the kernel answers its
 * API with 428 EULA_REQUIRED, so no screen, terminal command or script can use
 * AEON before the agreement is accepted. The interface shows the agreement
 * (src/components/EulaGate.jsx); the terminal has `aeon eula` / `aeon eula accept`.
 *
 * Acceptance is recorded in the AEON home (legal/eula-acceptance.json) and sent
 * nowhere: AEON's privacy promise is that it sends Broken Gear Industries
 * nothing. A headless or automated install accepts by setting AEON_ACCEPT_EULA
 * to the exact version (the ACCEPT_EULA=Y pattern of vendor container images),
 * so a new version still has to be accepted again.
 *
 * Nothing here writes at require time: the record and its folder are created
 * only by accept().
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.join(__dirname, '..', '..');
const EULA_FILE = path.join(APP_ROOT, 'EULA.md');
const RECORD_REL = path.join('legal', 'eula-acceptance.json');

// Paths that answer before acceptance. /api/ping is the liveness probe the
// terminal uses (it must say "up, agreement pending", not look like no server);
// /api/eula* are how the agreement is read and accepted.
const ALLOW = new Set(['/api/ping', '/api/eula', '/api/eula/accept']);
// Everything the kernel and blocks serve as an API. The interface's own files
// (/, /assets/*, the service worker) must load, or the agreement could not show.
const GATED = /^\/(api|core|block|blocks|events)(\/|$)/;

let _cache = null;
function current() {
  const stat = fs.statSync(EULA_FILE);
  if (_cache && _cache.mtimeMs === stat.mtimeMs && _cache.size === stat.size) return _cache.value;
  const text = fs.readFileSync(EULA_FILE, 'utf8');
  const m = /^\*\*Version ([0-9]+(?:\.[0-9]+)*)\b/m.exec(text);
  if (!m) throw new Error('EULA.md has no "**Version N.N" line');
  const value = {
    version: m[1],
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    text,
  };
  _cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

function homeDir(env = process.env) {
  const { resolveHome } = require('./aeonHome.cjs');
  return resolveHome({ appRoot: APP_ROOT, env });
}

function recordPath(env = process.env) {
  return path.join(homeDir(env), RECORD_REL);
}

function readRecord(env = process.env) {
  try { return JSON.parse(fs.readFileSync(recordPath(env), 'utf8')); } catch { return null; }
}

/** { accepted, version, via: 'record'|'env'|null, acceptedAt, recordPath } */
function status(env = process.env) {
  const cur = current();
  const base = { version: cur.version, sha256: cur.sha256, recordPath: recordPath(env) };
  const fromEnv = String(env.AEON_ACCEPT_EULA || '').trim();
  if (fromEnv && fromEnv === cur.version) return { ...base, accepted: true, via: 'env', acceptedAt: null };
  const rec = readRecord(env);
  if (rec && rec.version === cur.version) return { ...base, accepted: true, via: 'record', acceptedAt: rec.acceptedAt || null };
  return { ...base, accepted: false, via: null, acceptedAt: null, previousVersion: rec?.version || null };
}

/**
 * Record acceptance of `version`. Refuses any version but the current one, so
 * an old screen left open cannot accept text the operator never saw.
 */
function accept(version, { source = 'ui', env = process.env, now = () => new Date() } = {}) {
  const cur = current();
  if (String(version) !== cur.version) {
    const err = new Error(`This is version ${cur.version} of the agreement, not ${version}.`);
    err.code = 'EULA_VERSION_MISMATCH';
    throw err;
  }
  const file = recordPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { version: cur.version, sha256: cur.sha256, acceptedAt: now().toISOString(), source };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

function middleware(req, res, next) {
  if (!GATED.test(req.path) || ALLOW.has(req.path)) return next();
  let st;
  try { st = status(); } catch (e) {
    // A missing or malformed EULA.md is an install defect: say so, do not open up.
    return res.status(500).json({ success: false, error: 'EULA_UNREADABLE', detail: e.message });
  }
  if (st.accepted) return next();
  return res.status(428).json({
    success: false,
    error: 'EULA_REQUIRED',
    version: st.version,
    hint: `Accept the AEON License Agreement first: open AEON in your browser, or run \`npm run aeon -- eula accept\` in the AEON folder, or set AEON_ACCEPT_EULA=${st.version} and restart AEON.`,
  });
}

/**
 * GET /api/eula — the text and whether it is accepted.
 * POST /api/eula/accept { version } — from this machine, or from a signed-in
 * session. Before an account exists anyone who can reach an exposed bind could
 * otherwise accept on the operator's behalf.
 */
function mount(app) {
  const { isLoopback } = require('./server-utils/requireOperator.cjs');
  app.get('/api/eula', (_req, res) => {
    try {
      const cur = current(); const st = status();
      res.json({ accepted: st.accepted, via: st.via, version: cur.version, acceptedAt: st.acceptedAt, previousVersion: st.previousVersion || null, text: cur.text });
    } catch (e) { res.status(500).json({ success: false, error: 'EULA_UNREADABLE', detail: e.message }); }
  });
  app.post('/api/eula/accept', (req, res) => {
    let allowed = isLoopback(req);
    if (!allowed) {
      try {
        const sessions = require('./server-utils/sessionValidator.cjs');
        allowed = !!sessions.validateSession(req, sessions.loadPolicy())?.ok;
      } catch { allowed = false; }
    }
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'EULA_ACCEPT_LOCAL_ONLY', hint: 'Accept the agreement on the machine running AEON, or sign in first.' });
    }
    const source = req.body?.source === 'cli' ? 'cli' : 'ui';
    try {
      const record = accept(req.body?.version, { source });
      res.json({ success: true, version: record.version, acceptedAt: record.acceptedAt });
    } catch (e) {
      res.status(e.code === 'EULA_VERSION_MISMATCH' ? 409 : 500).json({ success: false, error: e.code || 'EULA_ACCEPT_FAILED', detail: e.message });
    }
  });
}

module.exports = { current, status, accept, middleware, mount, recordPath, EULA_FILE, ALLOW, GATED };
