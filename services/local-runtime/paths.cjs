/**
 * Phase 1 — The ONLY path authority for the native local runtime.
 *
 * Every runtime binary, model file, registry file, staging file and log path
 * used by services/local-runtime/** resolves here. No other module in that
 * subtree may read os.homedir(), process.env roots, or build a path by string
 * concatenation. `npm run scan:paths` fails CI on violations.
 *
 * Two invariants this module exists to guarantee:
 *
 *   1. CONTAINMENT — a resolved path can never escape the managed root, no
 *      matter what a catalog, a registry entry, or a user-supplied ID says.
 *      Traversal, absolute IDs, UNC paths, drive-letter switches and symlink
 *      /junction escapes are all rejected AFTER real path resolution.
 *
 *   2. RELOCATABILITY — the registry stores paths RELATIVE to dataRoot. A
 *      portable install moved from E:\AEON to F:\AEON (or to a path with
 *      spaces, Unicode, or a different drive) keeps every registry entry
 *      valid. Nothing persists an absolute path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── Managed subtree layout (relative to dataRoot) ─────────────────────────
const MANAGED_DIR = 'local-runtime';
const SUBDIRS = Object.freeze({
  runtime: 'runtime',   // extracted llama.cpp builds, one dir per version+backend
  models:  'models',    // one dir per model ID, containing the GGUF
  staging: 'staging',   // .part downloads and pre-activation extracts
  logs:    'logs',      // runtime/worker logs — never prompts or outputs
});
const REGISTRY_FILE = 'local-runtime.json';

/** IDs that name a directory on disk. Deliberately narrow. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

// Reserved device names on Windows resolve to devices, not files, at any
// extension and in any casing. A model ID of "con" would be a real hazard.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function assertSafeId(id, kind = 'id') {
  const s = String(id == null ? '' : id);
  if (!SAFE_ID.test(s)) {
    throw new Error(`invalid ${kind}: must match ${SAFE_ID} (got ${JSON.stringify(s.slice(0, 64))})`);
  }
  if (WIN_RESERVED.test(s)) throw new Error(`invalid ${kind}: "${s}" is a reserved device name`);
  if (s === '.' || s === '..') throw new Error(`invalid ${kind}: "${s}"`);
  return s;
}

/**
 * Resolve the data root ONCE, from explicit context. Callers never infer it
 * from process.cwd() — a launcher started from a different directory must not
 * silently relocate the user's models.
 *
 * Precedence: explicit setting → DATA_PATH env → <appRoot>/data
 *
 * @param {{ appRoot: string, dataRootSetting?: string|null, env?: object }} ctx
 */
function resolveDataRoot(ctx = {}) {
  const appRoot = ctx.appRoot;
  if (!appRoot || !path.isAbsolute(appRoot)) {
    throw new Error('resolveDataRoot: ctx.appRoot must be an absolute path');
  }
  const env = ctx.env || process.env;
  const candidate = ctx.dataRootSetting || env.DATA_PATH || path.join(appRoot, 'data');

  // A relative override is resolved against appRoot, never cwd. This is what
  // makes `DATA_PATH=./aeon-data` behave identically no matter where the
  // process was launched from.
  const resolved = path.resolve(appRoot, candidate);

  if (resolved.length === 0) throw new Error('resolveDataRoot: empty data root');
  return resolved;
}

/** Absolute root of the managed local-runtime subtree. */
function managedRoot(dataRoot) {
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new Error('managedRoot: dataRoot must be an absolute path');
  }
  return path.join(dataRoot, MANAGED_DIR);
}

/**
 * Containment check. Returns the resolved absolute target, or throws.
 *
 * Uses realpath on the deepest EXISTING ancestor so a symlink or NTFS
 * junction planted mid-path cannot smuggle the target outside the root.
 * Comparing lexical paths alone would miss exactly that attack.
 */
function assertManagedTarget(dataRoot, absTarget) {
  const root = managedRoot(dataRoot);
  const target = path.resolve(absTarget);

  // Resolve symlinks on the deepest EXISTING ancestor, then re-append the
  // not-yet-created tail. Resolving only the whole path would throw for
  // paths we are about to create; resolving nothing would miss a junction
  // planted on an existing parent directory.
  const realOf = (p) => {
    const tail = [];
    let cur = path.resolve(p);
    for (;;) {
      try {
        return path.join(path.resolve(fs.realpathSync.native(cur)), ...tail);
      } catch {
        const parent = path.dirname(cur);
        // Hit the filesystem root with nothing existing — use the lexical path.
        if (parent === cur) return path.resolve(p);
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };

  const realRoot = realOf(root);
  const rel = path.relative(realRoot, realOf(target));

  const escapes = rel === '..'
    || rel.startsWith('..' + path.sep)
    || path.isAbsolute(rel);

  if (escapes) {
    throw new Error(`path escapes managed root: ${JSON.stringify(String(absTarget).slice(0, 200))}`);
  }
  return target;
}

/**
 * Resolve a path inside the managed subtree from untrusted segments.
 * Every public path helper below funnels through here.
 */
function resolveManagedPath(dataRoot, ...segments) {
  const root = managedRoot(dataRoot);
  for (const seg of segments) {
    const s = String(seg == null ? '' : seg);
    if (s.length === 0) throw new Error('resolveManagedPath: empty segment');
    if (path.isAbsolute(s)) throw new Error(`resolveManagedPath: absolute segment rejected: ${s.slice(0, 80)}`);
    // Reject traversal and Windows drive-relative forms before joining.
    if (s.split(/[\\/]/).some(part => part === '..')) {
      throw new Error(`resolveManagedPath: traversal rejected: ${s.slice(0, 80)}`);
    }
    if (/^[a-zA-Z]:/.test(s)) throw new Error(`resolveManagedPath: drive-qualified segment rejected: ${s.slice(0, 80)}`);
  }
  const joined = path.join(root, ...segments.map(String));
  return assertManagedTarget(dataRoot, joined);
}

/**
 * Convert an absolute managed path to the dataRoot-relative form the registry
 * persists. Always POSIX-separated so a registry written on Windows reads
 * correctly on macOS/Linux (portable USB moved between hosts).
 */
function toRegistryRelative(dataRoot, absPath) {
  const target = assertManagedTarget(dataRoot, absPath);
  const rel = path.relative(dataRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`toRegistryRelative: not inside dataRoot: ${String(absPath).slice(0, 200)}`);
  }
  return rel.split(path.sep).join('/');
}

/** Inverse of toRegistryRelative — rehydrate a stored relative path. */
function fromRegistryRelative(dataRoot, relPath) {
  const r = String(relPath == null ? '' : relPath);
  if (r.length === 0) throw new Error('fromRegistryRelative: empty path');
  if (path.isAbsolute(r) || /^[a-zA-Z]:/.test(r)) {
    throw new Error(`fromRegistryRelative: stored path must be relative, got ${r.slice(0, 120)}`);
  }
  if (r.split(/[\\/]/).some(p => p === '..')) {
    throw new Error(`fromRegistryRelative: traversal in stored path: ${r.slice(0, 120)}`);
  }
  return assertManagedTarget(dataRoot, path.resolve(dataRoot, r));
}

// ── Public path helpers ───────────────────────────────────────────────────

/** Directory holding one extracted runtime build. */
function runtimePath(dataRoot, runtimeId, ...rest) {
  assertSafeId(runtimeId, 'runtime id');
  return resolveManagedPath(dataRoot, SUBDIRS.runtime, runtimeId, ...rest);
}

/** Directory holding one installed model (and its GGUF). */
function modelPath(dataRoot, modelId, ...rest) {
  assertSafeId(modelId, 'model id');
  return resolveManagedPath(dataRoot, SUBDIRS.models, modelId, ...rest);
}

/**
 * A staging path. `token` must be caller-supplied randomness — two concurrent
 * installs of the same asset must never collide on one .part file.
 */
function stagingPath(dataRoot, token, ...rest) {
  assertSafeId(token, 'staging token');
  return resolveManagedPath(dataRoot, SUBDIRS.staging, token, ...rest);
}

/** The registry file itself. */
function registryPath(dataRoot) {
  return resolveManagedPath(dataRoot, REGISTRY_FILE);
}

/** A log file inside the managed subtree. */
function logPath(dataRoot, name) {
  assertSafeId(name, 'log name');
  return resolveManagedPath(dataRoot, SUBDIRS.logs, name);
}

/** Create the managed skeleton. Idempotent. */
function ensureManagedDirs(dataRoot) {
  const root = managedRoot(dataRoot);
  fs.mkdirSync(root, { recursive: true });
  for (const sub of Object.values(SUBDIRS)) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

module.exports = {
  resolveDataRoot,
  managedRoot,
  resolveManagedPath,
  assertManagedTarget,
  toRegistryRelative,
  fromRegistryRelative,
  runtimePath,
  modelPath,
  stagingPath,
  registryPath,
  logPath,
  ensureManagedDirs,
  assertSafeId,
  MANAGED_DIR,
  SUBDIRS,
  REGISTRY_FILE,
};
