/**
 * Interruption mode — manual start/stop for self-built blocks (trading-block
 * pattern, applied kernel-wide).
 *
 * Rules:
 *  - Every pipeline-built block (any source, any score) is registered
 *    mode:'manual' at promote time and lands live-but-STOPPED. First start is
 *    an explicit operator click — code the operator hasn't started never
 *    handles a request.
 *  - Stopped manual blocks keep their routes mounted but the kernel answers
 *    503 for them (enforced in blockHost, not trusted to block code).
 *  - Hand-built blocks absent from the registry default to mode:'auto'
 *    (always running) — zero behavior change for the existing 33 blocks.
 *  - Start/stop are kernel-side state (db/aeon-block-runstate.json), NOT a
 *    manifest field — the manifest schema stays frozen (K1).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db');
const STATE_FILE = path.join(DB_DIR, 'aeon-block-runstate.json');

let _cache = null, _cacheAt = 0;
function load() {
  const now = Date.now();
  if (_cache && now - _cacheAt < 2000) return _cache;
  return loadFresh();
}

/**
 * Read from disk, ignoring the cache.
 *
 * BO-SHIP P1.3 — the 2s cache is fine for readers, and poison for writers. A
 * read-modify-write that starts from a cached copy re-publishes state that is
 * up to two seconds stale, silently reverting whatever another process wrote in
 * between. A lock around a cached read protects nothing, so every critical
 * section below starts here.
 */
function loadFresh() {
  try { _cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _cache = {}; }
  _cacheAt = Date.now();
  return _cache;
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  // Atomic, with a per-writer temp name. This was a direct writeFileSync onto
  // the live file: a crash mid-write left truncated JSON, and load()'s catch
  // turned that into {} — every manual block silently reverting to 'auto',
  // which means always-running. Rename is atomic; a unique temp keeps two
  // writers from sharing scratch.
  const tmp = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  _cache = state; _cacheAt = Date.now();
}

// ── Cross-process lock ───────────────────────────────────────────────
// P1.3: 60 concurrent registerManual() calls retained 48. Same read-modify-write
// shape as the vault. These functions are synchronous and called from route
// handlers, so the wait is a blocking sleep rather than an await — the critical
// section is a small file read and rename.
const LOCK_FILE = () => `${STATE_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquireLock() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const fd = fs.openSync(LOCK_FILE(), 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(LOCK_FILE()).mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_FILE());
        return tryAcquireLock();
      }
    } catch { /* vanished between calls; next attempt takes it */ }
    return false;
  }
}

/** Run `fn` with exclusive access to the run-state file. Synchronous. */
function withLock(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 2;
  while (!tryAcquireLock()) {
    if (Date.now() > deadline) throw new Error('[RUNSTATE] timed out waiting for the write lock');
    sleepSync(delay);
    delay = Math.min(delay * 2, 50);
  }
  try { return fn(); } finally {
    try { fs.unlinkSync(LOCK_FILE()); } catch {}
  }
}

/** Called by the build pipeline at promote time. Idempotent. */
function registerManual(blockId, { by = 'pipeline' } = {}) {
  return withLock(() => {
    const state = loadFresh(); // never start a write from the cache
    if (!state[blockId]) {
      state[blockId] = { mode: 'manual', running: false, registeredBy: by, registeredAt: new Date().toISOString(), changedAt: null, changedBy: null };
      save(state);
    }
    return state[blockId];
  });
}

function getState(blockId) {
  return load()[blockId] || { mode: 'auto', running: true };
}

/** true = requests may reach the block. */
function isRunning(blockId) {
  const s = getState(blockId);
  return s.mode === 'auto' || s.running === true;
}

/** Explicit operator click — the only way a manual block starts or stops. */
function setRunning(blockId, running, { operator = 'operator' } = {}) {
  const r = withLock(() => {
    const state = loadFresh(); // never start a write from the cache
    const s = state[blockId];
    if (!s || s.mode !== 'manual') return { ok: false, error: `block "${blockId}" is not a manual-start block` };
    s.running = running === true;
    s.changedAt = new Date().toISOString();
    s.changedBy = operator;
    save(state);
    return { ok: true, s };
  });
  if (!r.ok) return r;
  const s = r.s;
  try { global.broadcastTerminalEvent?.('BLOCK-RUNSTATE', `${blockId} ${s.running ? 'STARTED' : 'STOPPED'} by ${operator}`); } catch {}
  return { ok: true, blockId, ...s };
}

function listManual() {
  const state = load();
  return Object.entries(state).map(([blockId, s]) => ({ blockId, ...s }));
}

module.exports = { registerManual, getState, isRunning, setRunning, listManual, STATE_FILE };
