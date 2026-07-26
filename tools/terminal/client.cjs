/**
 * AEON Terminal — transport + mode detection (BO-TGM)
 *
 * Two operating modes, chosen automatically:
 *
 *   Connected  — a server answers /api/ping. Every command proxies to the
 *                running kernel, so the terminal sees the exact same block
 *                ecosystem, vault state, and model wiring the browser does.
 *
 *   Standalone — nothing is listening. The CLI reads what it can directly off
 *                disk (manifests, command registry) and refuses anything that
 *                needs a live kernel, rather than booting a second server
 *                against a data directory the real one may also hold open.
 *
 * Zero external dependencies on purpose: this has to work inside a bundle
 * built with `npm ci --omit=dev`, where chalk and friends are not present.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');

// ── ANSI (hand-rolled — no chalk dependency) ────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
  reset: '\x1b[0m',
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), underline: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39),
  blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  // AEON's accent — #00ffaa. Truecolor where available, cyan as the fallback.
  neon: (s) => (useColor ? `\x1b[38;2;0;255;170m${s}\x1b[39m` : String(s)),
};

function baseUrl() {
  const port = Number(process.env.PORT) || 3001;
  return process.env.AEON_URL || `http://127.0.0.1:${port}`;
}

// ── session token ───────────────────────────────────────────────────────────
// Stored under the data root so it follows DATA_PATH on portable installs
// instead of being stranded in the user's home directory on a host machine.
function sessionFile() {
  const dataRoot = process.env.DATA_PATH || path.join(ROOT, 'data');
  return path.join(dataRoot, 'terminal', 'session.json');
}

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    if (s.expiresAt && Date.now() > s.expiresAt) return null;
    return s;
  } catch { return null; }
}

function saveSession(token, ttlMs) {
  const f = sessionFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const payload = { token, savedAt: Date.now() };
  if (ttlMs) payload.expiresAt = Date.now() + ttlMs;
  fs.writeFileSync(f, JSON.stringify(payload, null, 2));
  // The token is a live credential. Owner-only where the OS honours it;
  // on FAT/exFAT (a USB drive) this is a no-op, which is itself a reason the
  // drive should be treated as a key.
  try { fs.chmodSync(f, 0o600); } catch {}
}

function clearSession() {
  try { fs.unlinkSync(sessionFile()); return true; } catch { return false; }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function request(method, route, body, { timeout = 120000, raw = false } = {}) {
  const url = route.startsWith('http') ? route : baseUrl() + route;
  const session = loadSession();
  const headers = { 'Content-Type': 'application/json' };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    if (raw) return res;
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, status: 0, data: { error: `timed out after ${timeout}ms` } };
    return { ok: false, status: 0, data: { error: e.message } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness probe. /api/ping is mounted ahead of the auth gate precisely so
 * this answers while the vault is locked — otherwise a locked server looks
 * identical to no server, and the CLI would wrongly pick Standalone.
 */
async function ping({ timeout = 1500 } = {}) {
  const res = await request('GET', '/api/ping', undefined, { timeout });
  if (res.ok && res.data?.name === 'aeon') {
    return { connected: true, ...res.data };
  }
  // A 401 still proves something is listening and speaking AEON.
  if (res.status === 401) return { connected: true, authRequired: true, locked: true };
  return { connected: false };
}

async function requireConnected() {
  const p = await ping();
  if (!p.connected) {
    console.error(`
  ${c.red('✗')} No AEON server on ${c.dim(baseUrl())}

  Start one:  ${c.neon('npm run server')}
  Or point elsewhere:  ${c.dim('AEON_URL=http://host:3001 aeon ...')}
`);
    process.exit(1);
  }
  return p;
}

// ── auth ────────────────────────────────────────────────────────────────────
function prompt(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) return rl.question(question, (a) => { rl.close(); resolve(a); });

    // Silent read for passphrases: suppress echo by intercepting the output
    // stream rather than disabling the tty, so Ctrl+C still behaves.
    const onData = (chunk) => {
      const s = chunk.toString();
      if (s === '\r' || s === '\n' || s === '') process.stdin.removeListener('data', onData);
      else process.stdout.write('\x1b[2K\x1b[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdout.write(question);
    process.stdin.on('data', onData);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

/**
 * Interactive login. The password is read silently and sent straight to the
 * server's own /api/auth/login — the CLI never writes it anywhere, and only
 * the returned session token is persisted.
 */
async function login() {
  const username = await prompt('  username: ');
  if (!username) { console.error(`  ${c.red('✗')} no username given`); return false; }
  const password = await prompt('  password: ', { silent: true });
  if (!password) { console.error(`  ${c.red('✗')} no password given`); return false; }

  let res = await request('POST', '/api/auth/login', { username, password });

  // The unified login route (BO2) asks for a second factor inline — a 200
  // with requires2FA, not a 401 — when the account has one enabled.
  if (res.ok && res.data?.requires2FA) {
    const code = await prompt('  2FA code: ');
    res = await request('POST', '/api/auth/login', { username, password, code });
  }

  const token = res.data?.token || res.data?.session || res.data?.sessionToken;
  if (res.ok && token) {
    saveSession(token, res.data?.expiresIn ? res.data.expiresIn * 1000 : null);
    console.log(`  ${c.green('✓')} authenticated`);
    return true;
  }
  console.error(`  ${c.red('✗')} ${res.data?.error || `login failed (${res.status})`}`);
  return false;
}

/**
 * Runs `fn`, and if it comes back 401, offers a login and retries once.
 *
 * Only when stdin is a real TTY — with no terminal attached (a script, a
 * subprocess, `--json` piped into another tool, CI) there is no one to
 * answer the prompt, and `login()`'s readline.question() never resolves.
 * That hung `aeon commands --json` and `aeon blocks --json` indefinitely
 * whenever the guard was on and no session was stored: found by the
 * settings/terminal stress test (2026-07-26), which invoked the real CLI
 * as a subprocess and it simply never returned. Callers already have a
 * fallback for a non-ok response (getCommands() → scanManifests(),
 * blocks() → derive from getCommands()), so returning the 401 as-is here
 * is enough — it degrades exactly like "server unreachable" already does.
 */
async function withAuth(fn) {
  let res = await fn();
  if (res && res.status === 401 && process.stdin.isTTY) {
    console.log(`\n  ${c.yellow('!')} vault locked — authenticate to continue\n`);
    if (await login()) res = await fn();
  }
  return res;
}

// ── command registry (works in both modes) ──────────────────────────────────
/**
 * Connected: ask the kernel, which knows live readiness per block.
 * Standalone: read the manifests off disk. Same shape either way, so callers
 * and the NL router never branch on mode.
 */
async function getCommands() {
  const p = await ping();
  if (p.connected) {
    const res = await withAuth(() => request('GET', '/api/commands'));
    if (res.ok && Array.isArray(res.data?.commands)) {
      return { source: 'server', commands: res.data.commands };
    }
  }
  return { source: 'manifest', commands: scanManifests() };
}

function scanManifests() {
  const blocksDir = path.join(ROOT, 'src', 'blocks');
  const out = [];
  let folders = [];
  try { folders = fs.readdirSync(blocksDir); } catch { return out; }
  for (const folder of folders) {
    if (folder.startsWith('_')) continue;
    const mf = path.join(blocksDir, folder, 'block.manifest.json');
    if (!fs.existsSync(mf)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { continue; }
    for (const cmd of manifest?.contract?.commands || []) {
      if (!cmd.cmd || !cmd.route) continue;
      out.push({
        id: `${folder}.${cmd.cmd.replace(/^\//, '')}`,
        cmd: cmd.cmd,
        blockId: folder,
        blockLabel: manifest.label || folder,
        title: cmd.title || cmd.desc || cmd.cmd,
        desc: cmd.desc || '',
        category: cmd.category || manifest.nav?.group || 'block',
        route: cmd.route,
        method: (cmd.method || 'POST').toUpperCase(),
        param: cmd.param || null,
        mode: cmd.mode || 'instant',
        dangerous: !!cmd.dangerous,
        available: true,
      });
    }
  }
  return out;
}

/**
 * Normalise a command token before dispatch.
 *
 * MSYS (Git Bash, the default shell on a lot of Windows dev machines) rewrites
 * any bare argument starting with `/` into a Windows path — `/gpu` arrives as
 * `C:/Program Files/Git/gpu`. That is invisible to the user and makes every
 * slash-prefixed command fail with "unknown command". Recover the last segment
 * and re-add the slash. Also accepts `gpu` and `cookbook.gpu` unchanged.
 */
function normalizeCommand(token) {
  let t = String(token || '').trim();
  if (!t) return t;
  if (/[\\/]/.test(t) && !t.startsWith('/')) t = t.split(/[\\/]/).filter(Boolean).pop() || t;
  else if (t.startsWith('/') && t.slice(1).includes('/')) t = t.split('/').filter(Boolean).pop() || t;
  return t;
}

/** Dispatch through the kernel's own bus, so confirmation gates stay central. */
async function dispatch(cmdOrId, arg = '', { confirmed = false, timeout = 120000 } = {}) {
  const token = normalizeCommand(cmdOrId);
  // Send both spellings: the registry keys commands by "/gpu" and by
  // "cookbook.gpu", and the dispatcher resolves id first, then cmd.
  const withSlash = token.includes('.') ? token : `/${token.replace(/^\//, '')}`;
  return withAuth(() => request(
    'POST', '/api/commands/dispatch',
    { cmd: withSlash, id: token, arg, confirmed },
    { timeout },
  ));
}

module.exports = {
  c, ROOT, baseUrl,
  request, ping, requireConnected,
  loadSession, saveSession, clearSession, login, withAuth, prompt,
  getCommands, scanManifests, dispatch, normalizeCommand,
};
