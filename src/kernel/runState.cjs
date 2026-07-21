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

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db');
const STATE_FILE = path.join(DB_DIR, 'aeon-block-runstate.json');

let _cache = null, _cacheAt = 0;
function load() {
  const now = Date.now();
  if (_cache && now - _cacheAt < 2000) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { _cache = {}; }
  _cacheAt = now;
  return _cache;
}
function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  _cache = state; _cacheAt = Date.now();
}

/** Called by the build pipeline at promote time. Idempotent. */
function registerManual(blockId, { by = 'pipeline' } = {}) {
  const state = load();
  if (!state[blockId]) {
    state[blockId] = { mode: 'manual', running: false, registeredBy: by, registeredAt: new Date().toISOString(), changedAt: null, changedBy: null };
    save(state);
  }
  return state[blockId];
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
  const state = load();
  const s = state[blockId];
  if (!s || s.mode !== 'manual') return { ok: false, error: `block "${blockId}" is not a manual-start block` };
  s.running = running === true;
  s.changedAt = new Date().toISOString();
  s.changedBy = operator;
  save(state);
  try { global.broadcastTerminalEvent?.('BLOCK-RUNSTATE', `${blockId} ${s.running ? 'STARTED' : 'STOPPED'} by ${operator}`); } catch {}
  return { ok: true, blockId, ...s };
}

function listManual() {
  const state = load();
  return Object.entries(state).map(([blockId, s]) => ({ blockId, ...s }));
}

module.exports = { registerManual, getState, isRunning, setRunning, listManual, STATE_FILE };
