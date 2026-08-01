/**
 * Phase 2 — The local runtime registry. One transactional truth.
 *
 * Cookbook writes it, Settings and the kernel read it, the launcher validates
 * it. Nothing probes folders or processes to discover what is installed.
 *
 * Durability contract: a crash at ANY write boundary leaves either the old
 * valid registry or the new valid registry — never a partial one. That is
 * achieved with temp-write → fsync → atomic rename, plus a `.bak` of the last
 * known-good file so a torn or truncated primary can be recovered rather than
 * silently resetting a user's model list to empty.
 *
 * Forward compatibility: a registry whose schemaVersion is HIGHER than this
 * build understands is served READ-ONLY. An older AEON must never rewrite (and
 * thereby destroy) state a newer AEON wrote — that is how a downgrade eats a
 * user's installed models.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths.cjs');

const SCHEMA_VERSION = 1;

const RUNTIME_STATES = new Set(['staged', 'ready', 'quarantined', 'superseded']);
const MODEL_STATES = new Set(['staged', 'ready', 'quarantined', 'removing']);
const BACKENDS = new Set(['cpu', 'cuda', 'metal', 'vulkan', 'rocm']);
const CAPABILITIES = new Set(['chat', 'embed', 'vision', 'tools']);

/**
 * Legal state transitions. Anything not listed is refused — an install that
 * jumps staged→ready without passing verification is exactly the bug the
 * Phase 4 gate exists to prevent, so the registry refuses to record it
 * without the caller having gone through verify().
 */
const MODEL_TRANSITIONS = {
  staged:      new Set(['ready', 'quarantined', 'removing']),
  ready:       new Set(['quarantined', 'removing']),
  quarantined: new Set(['removing', 'staged']),
  removing:    new Set([]),
};
const RUNTIME_TRANSITIONS = {
  staged:      new Set(['ready', 'quarantined']),
  ready:       new Set(['superseded', 'quarantined']),
  quarantined: new Set(['staged']),
  superseded:  new Set(['ready']),   // rollback re-activates a prior runtime
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function emptyRegistry() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    activeRuntimeId: null,
    runtimes: [],
    models: [],
  };
}

// ── Validation ────────────────────────────────────────────────────────────

class RegistryError extends Error {
  constructor(msg, code) { super(msg); this.name = 'RegistryError'; this.code = code || 'REGISTRY_INVALID'; }
}

function assertRelPath(relPath, what) {
  const s = String(relPath == null ? '' : relPath);
  if (!s) throw new RegistryError(`${what}: relPath is required`, 'REGISTRY_INVALID');
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || s.startsWith('\\\\')) {
    throw new RegistryError(`${what}: relPath must be relative to dataRoot, got ${s.slice(0, 80)}`, 'REGISTRY_ABSOLUTE_PATH');
  }
  if (s.split('/').some(p => p === '..')) {
    throw new RegistryError(`${what}: relPath traversal rejected`, 'REGISTRY_PATH_ESCAPE');
  }
  if (s.includes('\\')) {
    throw new RegistryError(`${what}: relPath must use POSIX separators`, 'REGISTRY_INVALID');
  }
  return s;
}

function validateRuntime(r, i) {
  const at = `runtimes[${i}]`;
  P.assertSafeId(r.id, `${at}.id`);
  if (!RUNTIME_STATES.has(r.state)) throw new RegistryError(`${at}.state invalid: ${r.state}`, 'REGISTRY_INVALID');
  if (!r.version) throw new RegistryError(`${at}.version required`, 'REGISTRY_INVALID');
  if (!BACKENDS.has(r.backend)) throw new RegistryError(`${at}.backend invalid: ${r.backend}`, 'REGISTRY_INVALID');
  assertRelPath(r.relPath, at);
  if (r.sha256 != null && !SHA256_RE.test(r.sha256)) throw new RegistryError(`${at}.sha256 malformed`, 'REGISTRY_INVALID');
  if (r.entrypoint != null && (path.isAbsolute(r.entrypoint) || r.entrypoint.includes('..'))) {
    throw new RegistryError(`${at}.entrypoint must be a contained filename`, 'REGISTRY_PATH_ESCAPE');
  }
  if (!ISO_RE.test(String(r.installedAt || ''))) throw new RegistryError(`${at}.installedAt must be ISO-8601`, 'REGISTRY_INVALID');
  // A runtime cannot be ready without proof it was verified and probed.
  if (r.state === 'ready' && !r.sha256) {
    throw new RegistryError(`${at} cannot be "ready" without a recorded sha256`, 'REGISTRY_UNVERIFIED_READY');
  }
}

function validateModel(m, i) {
  const at = `models[${i}]`;
  P.assertSafeId(m.id, `${at}.id`);
  if (!MODEL_STATES.has(m.state)) throw new RegistryError(`${at}.state invalid: ${m.state}`, 'REGISTRY_INVALID');
  assertRelPath(m.relPath, at);
  if (!Number.isInteger(m.bytes) || m.bytes < 0) throw new RegistryError(`${at}.bytes must be a non-negative integer`, 'REGISTRY_INVALID');
  if (m.sha256 != null && !SHA256_RE.test(m.sha256)) throw new RegistryError(`${at}.sha256 malformed`, 'REGISTRY_INVALID');
  if (m.capabilities != null) {
    if (!Array.isArray(m.capabilities)) throw new RegistryError(`${at}.capabilities must be an array`, 'REGISTRY_INVALID');
    for (const c of m.capabilities) {
      if (!CAPABILITIES.has(c)) throw new RegistryError(`${at}.capabilities has unknown value: ${c}`, 'REGISTRY_INVALID');
    }
  }
  if (!ISO_RE.test(String(m.installedAt || ''))) throw new RegistryError(`${at}.installedAt must be ISO-8601`, 'REGISTRY_INVALID');
  // The Phase 4 gate, enforced at the storage layer: no hash, no ready.
  if (m.state === 'ready' && !m.sha256) {
    throw new RegistryError(`${at} cannot be "ready" without a recorded sha256`, 'REGISTRY_UNVERIFIED_READY');
  }
}

function validate(reg) {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) {
    throw new RegistryError('registry must be an object', 'REGISTRY_INVALID');
  }
  if (!Number.isInteger(reg.schemaVersion) || reg.schemaVersion < 1) {
    throw new RegistryError('schemaVersion must be a positive integer', 'REGISTRY_INVALID');
  }
  if (!Array.isArray(reg.runtimes)) throw new RegistryError('runtimes must be an array', 'REGISTRY_INVALID');
  if (!Array.isArray(reg.models)) throw new RegistryError('models must be an array', 'REGISTRY_INVALID');

  reg.runtimes.forEach(validateRuntime);
  reg.models.forEach(validateModel);

  const rIds = new Set();
  for (const r of reg.runtimes) {
    if (rIds.has(r.id)) throw new RegistryError(`duplicate runtime id: ${r.id}`, 'REGISTRY_DUPLICATE_ID');
    rIds.add(r.id);
  }
  const mIds = new Set();
  for (const m of reg.models) {
    if (mIds.has(m.id)) throw new RegistryError(`duplicate model id: ${m.id}`, 'REGISTRY_DUPLICATE_ID');
    mIds.add(m.id);
  }
  if (reg.activeRuntimeId != null && !rIds.has(reg.activeRuntimeId)) {
    throw new RegistryError(`activeRuntimeId "${reg.activeRuntimeId}" is not a known runtime`, 'REGISTRY_DANGLING_ACTIVE');
  }
  return reg;
}

// ── Migration ─────────────────────────────────────────────────────────────

/**
 * Idempotent forward migration. Running it twice must equal running it once.
 * Returns { registry, migrated, readOnly }.
 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { registry: emptyRegistry(), migrated: true, readOnly: false };

  // A newer AEON wrote this. Serve it, never rewrite it.
  if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
    return { registry: raw, migrated: false, readOnly: true };
  }

  let migrated = false;
  const reg = { ...raw };

  // v0 → v1: the pre-schema shape had no version and used object maps keyed
  // by id. Normalize to arrays and stamp the version.
  if (!Number.isInteger(reg.schemaVersion)) {
    reg.schemaVersion = SCHEMA_VERSION;
    migrated = true;
    for (const key of ['runtimes', 'models']) {
      const v = reg[key];
      if (v && !Array.isArray(v) && typeof v === 'object') {
        reg[key] = Object.entries(v).map(([id, val]) => ({ id, ...(val || {}) }));
      } else if (!Array.isArray(v)) {
        reg[key] = [];
      }
    }
  }

  if (!Array.isArray(reg.runtimes)) { reg.runtimes = []; migrated = true; }
  if (!Array.isArray(reg.models)) { reg.models = []; migrated = true; }
  if (!('activeRuntimeId' in reg)) { reg.activeRuntimeId = null; migrated = true; }
  if (!reg.updatedAt) { reg.updatedAt = new Date().toISOString(); migrated = true; }

  return { registry: reg, migrated, readOnly: false };
}

// ── Durable read/write ────────────────────────────────────────────────────

function createRegistry(dataRoot) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new RegistryError('createRegistry: dataRoot must be an absolute path', 'REGISTRY_INVALID');
  }
  const file = P.registryPath(dataRoot);
  const bak = file + '.bak';
  const tmpOf = () => `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;

  let lastReadOnly = false;

  function parseOrNull(p) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      if (!txt.trim()) return null;
      const parsed = JSON.parse(txt);
      const { registry, readOnly } = migrate(parsed);
      // A newer schema's records are not ours to judge — validating them
      // against today's rules would discard a valid future registry as
      // corrupt and silently reset the user's model list.
      if (!readOnly) validate(registry);
      return parsed; // return the RAW so migrate() decides readOnly on read()
    } catch { return null; }
  }

  /**
   * Read the registry, recovering from corruption.
   * Order: primary → backup → fresh empty. Never throws for a missing file.
   */
  function read() {
    P.ensureManagedDirs(dataRoot);

    let raw = parseOrNull(file);
    let recovered = false;

    if (raw === null && fs.existsSync(file)) {
      // Primary exists but is torn/truncated/invalid — fall back to backup.
      const fromBak = parseOrNull(bak);
      if (fromBak !== null) { raw = fromBak; recovered = true; }
    }
    if (raw === null && !fs.existsSync(file)) {
      const fromBak = parseOrNull(bak);
      if (fromBak !== null) { raw = fromBak; recovered = true; }
    }

    if (raw === null) {
      lastReadOnly = false;
      const fresh = emptyRegistry();
      return { registry: fresh, recovered: fs.existsSync(file), readOnly: false, fresh: true };
    }

    const { registry, readOnly } = migrate(raw);
    lastReadOnly = readOnly;
    if (!readOnly) validate(registry);
    return { registry, recovered, readOnly, fresh: false };
  }

  /** Convenience: just the registry object. */
  function load() { return read().registry; }

  /**
   * Atomically persist. Validates BEFORE touching the primary so an invalid
   * write can never replace a good file.
   */
  function write(next) {
    const { readOnly } = read();
    if (readOnly) {
      throw new RegistryError(
        `registry schemaVersion is newer than this build (${SCHEMA_VERSION}); refusing to overwrite`,
        'REGISTRY_READ_ONLY');
    }

    const out = { ...next, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    validate(out);

    P.ensureManagedDirs(dataRoot);
    const body = JSON.stringify(out, null, 2);
    const tmp = tmpOf();

    // temp-write → fsync → rename. The fsync is what makes the rename a real
    // durability boundary rather than a promise the page cache may not keep.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Retain the prior valid file as backup before replacing it.
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, bak); } catch { /* best effort; not fatal */ }
    }

    fs.renameSync(tmp, file);   // atomic on the same filesystem
    return out;
  }

  /** Read → mutate → write, with validation on the way out. */
  function update(mutator) {
    const current = load();
    const draft = JSON.parse(JSON.stringify(current));
    const result = mutator(draft);
    return write(result === undefined ? draft : result);
  }

  /** Remove stale .tmp files left by an interrupted write. */
  function cleanStaging() {
    P.ensureManagedDirs(dataRoot);
    const dir = path.dirname(file);
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(path.basename(file) + '.') && name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(dir, name)); removed++; } catch {}
      }
    }
    return removed;
  }

  // ── Typed accessors ─────────────────────────────────────────────────────

  /** Ready models only. This is what Settings and the kernel consume. */
  function readyModels() {
    return load().models.filter(m => m.state === 'ready');
  }

  /** Ready models advertising a capability (e.g. 'chat', 'embed'). */
  function modelsForCapability(cap) {
    return readyModels().filter(m => Array.isArray(m.capabilities) && m.capabilities.includes(cap));
  }

  function activeRuntime() {
    const reg = load();
    if (!reg.activeRuntimeId) return null;
    return reg.runtimes.find(r => r.id === reg.activeRuntimeId && r.state === 'ready') || null;
  }

  /** Resolve a registry entry's stored relative path to an absolute one. */
  /**
   * Absolute path to an entry's executable/weights file.
   *
   * A MODEL's relPath already points at the .gguf. A RUNTIME's relPath points
   * at the extracted DIRECTORY, and the file to run is named separately in
   * `entrypoint` — which this ignored, so every caller received a directory
   * where it expected a binary. index.cjs handed that directory to the
   * supervisor and to the embedder; runtime-installer worked only because it
   * appended `${relPath}/${entrypoint}` by hand on its own return path.
   *
   * Appending entrypoint here makes the one resolver correct for both kinds
   * and removes the hand-assembly. Entries without an entrypoint (models) are
   * unchanged.
   */
  function resolveEntryPath(entry) {
    const rel = entry && entry.entrypoint
      ? `${entry.relPath}/${entry.entrypoint}`
      : entry.relPath;
    return P.fromRegistryRelative(dataRoot, rel);
  }

  function assertTransition(kind, from, to) {
    const table = kind === 'model' ? MODEL_TRANSITIONS : RUNTIME_TRANSITIONS;
    const allowed = table[from];
    if (!allowed || !allowed.has(to)) {
      throw new RegistryError(`illegal ${kind} state transition ${from} → ${to}`, 'REGISTRY_ILLEGAL_TRANSITION');
    }
  }

  function upsertModel(entry) {
    return update(reg => {
      const i = reg.models.findIndex(m => m.id === entry.id);
      if (i === -1) {
        reg.models.push({ installedAt: new Date().toISOString(), ...entry });
      } else {
        if (entry.state && entry.state !== reg.models[i].state) {
          assertTransition('model', reg.models[i].state, entry.state);
        }
        reg.models[i] = { ...reg.models[i], ...entry };
      }
    });
  }

  function setModelState(id, state, reason = null) {
    return update(reg => {
      const m = reg.models.find(x => x.id === id);
      if (!m) throw new RegistryError(`unknown model: ${id}`, 'REGISTRY_UNKNOWN_ID');
      assertTransition('model', m.state, state);
      m.state = state;
      m.quarantineReason = state === 'quarantined' ? (reason || 'unspecified') : null;
    });
  }

  function removeModel(id) {
    return update(reg => {
      const m = reg.models.find(x => x.id === id);
      if (!m) throw new RegistryError(`unknown model: ${id}`, 'REGISTRY_UNKNOWN_ID');
      if (m.state !== 'removing') {
        throw new RegistryError(`model ${id} must be marked "removing" before deletion`, 'REGISTRY_ILLEGAL_TRANSITION');
      }
      reg.models = reg.models.filter(x => x.id !== id);
    });
  }

  function upsertRuntime(entry) {
    return update(reg => {
      const i = reg.runtimes.findIndex(r => r.id === entry.id);
      if (i === -1) {
        reg.runtimes.push({ installedAt: new Date().toISOString(), ...entry });
      } else {
        if (entry.state && entry.state !== reg.runtimes[i].state) {
          assertTransition('runtime', reg.runtimes[i].state, entry.state);
        }
        reg.runtimes[i] = { ...reg.runtimes[i], ...entry };
      }
    });
  }

  /**
   * Activation is a metadata swap, never a folder move. Rollback is the same
   * operation pointed at the previous runtime id.
   */
  function activateRuntime(id) {
    return update(reg => {
      const r = reg.runtimes.find(x => x.id === id);
      if (!r) throw new RegistryError(`unknown runtime: ${id}`, 'REGISTRY_UNKNOWN_ID');
      if (r.state !== 'ready') throw new RegistryError(`runtime ${id} is "${r.state}", not "ready"`, 'REGISTRY_NOT_READY');
      for (const other of reg.runtimes) {
        if (other.id !== id && other.state === 'ready') other.state = 'superseded';
      }
      reg.activeRuntimeId = id;
    });
  }

  return {
    file, backupFile: bak,
    read, load, write, update, cleanStaging,
    readyModels, modelsForCapability, activeRuntime, resolveEntryPath,
    upsertModel, setModelState, removeModel,
    upsertRuntime, activateRuntime,
    get readOnly() { return lastReadOnly; },
  };
}

module.exports = {
  createRegistry,
  validate,
  migrate,
  emptyRegistry,
  RegistryError,
  SCHEMA_VERSION,
  RUNTIME_STATES,
  MODEL_STATES,
  MODEL_TRANSITIONS,
  RUNTIME_TRANSITIONS,
};
