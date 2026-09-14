/**
 * One-time move of an existing install's data into the AEON home.
 *
 * An install from before 2026-09-14 has its Vault, models, keyslots, .env,
 * runtime state and settings INSIDE the install directory (see aeonHome.cjs
 * for the map). The first launch after upgrading moves each of them to the
 * home, so the operator's next reinstall is `git pull` and nothing is lost.
 *
 * Doctrine — the operator's data is the one thing this code may never damage:
 *
 *   PER ROOT, NOT ALL-OR-NOTHING. Each root moves iff its resolved target is
 *   the home default (no per-root override — set by the process environment
 *   OR by the legacy .env, which dotenv will load right after this runs), the
 *   legacy path exists, the target is absent or holds no files, and home.json
 *   does not already record it. Every other root still moves.
 *
 *   NEVER MERGE, NEVER DELETE. A populated target is refused with both paths
 *   printed; the boot continues on the target and the legacy copy stays where
 *   it is for the operator to reconcile by hand.
 *
 *   THE VAULT PROTECTOR IS ONE THING. The .env master key and
 *   secrets/aeon-keyslots.json are two halves of one protector (vault.cjs). They
 *   move as a pair, .env first; if secrets cannot follow, .env goes back. The
 *   pair moves before anything else so the vault is whole for the rest of boot.
 *
 *   RENAME, ELSE COPY-VERIFY-REMOVE. fs.renameSync is atomic on one volume. If
 *   the home is on another volume (EXDEV) the tree is copied (errorOnExist),
 *   verified (file count, byte total, and per-file size for every *.gguf — the
 *   models are the 7 GB that matter), and only then is the legacy tree removed.
 *   Free space is checked before a cross-volume copy. A failed verification
 *   removes the partial target and keeps the legacy tree.
 *
 *   RESUMABLE. Each root is recorded in <home>/home.json as it completes, so an
 *   interrupted run picks up where it stopped and a finished one is a no-op.
 *
 *   NEVER on a cloud runtime (no writable home), on portable media
 *   (AEON_PORTABLE=true — the drive is the home), or with AEON_HOME_MIGRATE=0.
 *
 * Order: .env + secrets (pair) → aeon-settings.json → db runtime files →
 * Vault → data (largest last, so everything small is safe before the long
 * copy).
 *
 * Kernel module: relative requires only. `fs` is injectable for tests.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isCloud } = require('./runtime.cjs');
const home = require('./aeonHome.cjs');

const STUB_FILE = '.aeon-home';
/** Regenerable caches that may sit beside the legacy Vault; safe to drop when it moves. */
const LEGACY_VAULT_PARENT_CACHES = new Set(['.extract-cache', '.DS_Store', 'Thumbs.db']);

// ── small helpers ─────────────────────────────────────────────────────────

function realOrSelf(fsx, p) {
  try { return fsx.realpathSync.native ? fsx.realpathSync.native(p) : fsx.realpathSync(p); }
  catch { return path.resolve(p); }
}

function lexists(fsx, p) {
  try { fsx.lstatSync(p); return true; } catch { return false; }
}

function isSymlink(fsx, p) {
  try { return fsx.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Minimal KEY=VALUE reader for the legacy .env — only to learn which roots it
 * redirects. Quotes are stripped, comments and blanks skipped. Not a dotenv
 * replacement; dotenv loads the file for real once boot reaches it.
 */
function parseEnvFile(fsx, file) {
  const out = {};
  let text = '';
  try { text = fsx.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}

/** A path holds no files: absent, or a directory tree of empty directories. */
function holdsNoFiles(fsx, p) {
  let st;
  try { st = fsx.lstatSync(p); } catch { return true; }
  if (!st.isDirectory()) return false;
  for (const name of fsx.readdirSync(p)) {
    if (!holdsNoFiles(fsx, path.join(p, name))) return false;
  }
  return true;
}

/** File count, byte total, and per-file sizes of every *.gguf under p. */
function treeStats(fsx, p, acc = { files: 0, bytes: 0, gguf: {} }, base = p) {
  const st = fsx.lstatSync(p);
  if (st.isDirectory()) {
    for (const name of fsx.readdirSync(p)) treeStats(fsx, path.join(p, name), acc, base);
    return acc;
  }
  acc.files += 1;
  if (st.isFile()) {
    acc.bytes += st.size;
    if (/\.gguf$/i.test(p)) acc.gguf[path.relative(base, p)] = st.size;
  }
  return acc;
}

function verifyCopy(fsx, from, to) {
  const a = treeStats(fsx, from);
  const b = treeStats(fsx, to);
  if (a.files !== b.files) return `file count differs (${a.files} → ${b.files})`;
  if (a.bytes !== b.bytes) return `byte total differs (${a.bytes} → ${b.bytes})`;
  for (const [rel, size] of Object.entries(a.gguf)) {
    if (b.gguf[rel] !== size) return `model ${rel} size differs (${size} → ${b.gguf[rel]})`;
  }
  return null;
}

function assertFreeSpace(fsx, dir, bytes) {
  if (typeof fsx.statfsSync !== 'function') return;
  let st;
  try { st = fsx.statfsSync(dir); } catch { return; }
  const free = Number(st.bavail) * Number(st.bsize);
  if (Number.isFinite(free) && free < bytes) {
    throw new Error(`not enough free space at ${dir}: need ${bytes} bytes, have ${free}`);
  }
}

/**
 * Move one path (file or tree). Same volume: rename. Across volumes: copy,
 * verify, then remove the source. On any failure the target is removed (only
 * what this call created) and the source is untouched.
 */
function moveTree(fsx, from, to) {
  fsx.mkdirSync(path.dirname(to), { recursive: true });
  if (lexists(fsx, to) && holdsNoFiles(fsx, to)) fsx.rmSync(to, { recursive: true, force: true });
  try {
    fsx.renameSync(from, to);
    return 'rename';
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  const need = treeStats(fsx, from).bytes;
  assertFreeSpace(fsx, path.dirname(to), need);
  try {
    fsx.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    const problem = verifyCopy(fsx, from, to);
    if (problem) throw new Error(`copy verification failed: ${problem}`);
  } catch (e) {
    try { fsx.rmSync(to, { recursive: true, force: true }); } catch { /* keep going: the source is intact */ }
    throw e;
  }
  fsx.rmSync(from, { recursive: true, force: true });
  return 'copy';
}

/** db/ entries that ship with the install and stay there. */
function dbKeep(name) {
  return name.endsWith('.sql') || name === 'migrations';
}

// ── the migration ─────────────────────────────────────────────────────────

/**
 * @param {{ appRoot: string, env?: object, log?: Function, fs?: object, homedir?: Function }} opts
 * @returns {{ ran: boolean, skipped: boolean, reason: string|null, home: string|null,
 *             moved: Array<{root: string, from: string, to: string, method: string}>,
 *             refused: Array<{root: string, from: string, to: string, reason: string}>,
 *             warnings: string[] }}
 */
function migrateToHome(opts = {}) {
  const appRoot = opts.appRoot;
  if (!appRoot || !path.isAbsolute(appRoot)) throw new Error('migrateToHome: appRoot must be an absolute path');
  const env = opts.env || process.env;
  const fsx = opts.fs || fs;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const result = { ran: false, skipped: false, reason: null, home: null, moved: [], refused: [], warnings: [] };
  const skip = (reason) => { result.skipped = true; result.reason = reason; return result; };
  const warn = (m) => { result.warnings.push(m); log(m); };

  if (isCloud()) return skip('cloud');
  if (env.AEON_PORTABLE === 'true') return skip('portable');
  if (env.AEON_HOME_MIGRATE === '0') return skip('disabled');

  // Overrides the legacy .env declares count too: dotenv loads it right after
  // this and they win from then on. AEON_HOME never comes from a file.
  const legacyEnvFile = path.join(appRoot, home.LEGACY.envFile);
  const effective = { ...parseEnvFile(fsx, legacyEnvFile) };
  delete effective.AEON_HOME;
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.trim()) effective[k] = v;
  if (effective.AEON_PORTABLE === 'true') return skip('portable');

  const r = home.roots({ appRoot, env: effective, homedir: opts.homedir, warn });
  result.home = r.home;
  if (realOrSelf(fsx, r.home) === realOrSelf(fsx, appRoot)) return skip('home-is-install');

  const manifest = home.readManifest(r.home) || {};
  const done = { ...(manifest.migrated || {}) };
  const record = (name, from, method) => {
    done[name] = { at: new Date().toISOString(), from, method };
    home.updateManifest(r.home, { appRoot, migrated: done });
  };

  const spec = (name) => ({
    name,
    legacy: path.join(appRoot, home.LEGACY[name]),
    target: r[name],
    overridden: home.isOverridden(name, effective),
  });

  /** Why a root cannot move right now — or null when it can. */
  const assess = (s) => {
    if (done[s.name]) return { skip: 'done' };
    if (s.overridden) return { skip: 'override' };
    if (!lexists(fsx, s.legacy)) return { skip: 'no-legacy' };
    if (realOrSelf(fsx, s.legacy) === realOrSelf(fsx, s.target)) return { skip: 'same-path' };
    if (isSymlink(fsx, s.legacy)) {
      if (inside(realOrSelf(fsx, s.target), realOrSelf(fsx, s.legacy))) return { skip: 'symlink-into-target' };
      return { refuse: 'legacy path is a symlink' };
    }
    if (lexists(fsx, s.target) && !holdsNoFiles(fsx, s.target)) return { refuse: 'target already has data' };
    return null;
  };

  const refuse = (s, reason) => {
    result.refused.push({ root: s.name, from: s.legacy, to: s.target, reason });
    log(`[HOME] not moving ${s.name}: ${reason}\n         legacy: ${s.legacy}\n         target: ${s.target}\n         AEON continues on the target; reconcile the legacy copy by hand.`);
  };

  const move = (s) => {
    const method = moveTree(fsx, s.legacy, s.target);
    result.moved.push({ root: s.name, from: s.legacy, to: s.target, method });
    record(s.name, s.legacy, method);
  };

  result.ran = true;

  // 1. .env + secrets — one protector, two halves.
  {
    const e = spec('envFile'), s = spec('secrets');
    const ae = assess(e), as = assess(s);
    if (ae && ae.refuse) refuse(e, ae.refuse);
    if (as && as.refuse) refuse(s, as.refuse);
    const envCan = !ae, secCan = !as;
    if ((ae && ae.refuse && secCan) || (as && as.refuse && envCan)) {
      warn('[HOME] .env and secrets/ are two halves of the vault protector and move together — neither moved.');
    } else {
      let envMoved = false;
      if (envCan) {
        try { move(e); envMoved = true; }
        catch (err) { refuse(e, `move failed: ${err.message}`); }
      }
      if (secCan && (envMoved || !envCan)) {
        try { move(s); }
        catch (err) {
          refuse(s, `move failed: ${err.message}`);
          if (envMoved) {
            try {
              moveTree(fsx, e.target, e.legacy);
              delete done.envFile;
              home.updateManifest(r.home, { appRoot, migrated: done });
              result.moved = result.moved.filter(m => m.root !== 'envFile');
              warn(`[HOME] .env moved back to ${e.legacy} so the vault key stays beside its keyslots.`);
            } catch (rb) {
              warn(`[HOME] could not move .env back to ${e.legacy}: ${rb.message} — it is at ${e.target}`);
            }
          }
        }
      }
    }
  }

  // 2. settings
  {
    const s = spec('settings');
    const a = assess(s);
    if (a && a.refuse) refuse(s, a.refuse);
    else if (!a) { try { move(s); } catch (err) { refuse(s, `move failed: ${err.message}`); } }
  }

  // 3. db runtime files — the tracked seeds (*.sql, migrations/, retrieval/_scopes.json) stay.
  {
    const s = spec('db');
    if (!done.db && !s.overridden && lexists(fsx, s.legacy)
        && realOrSelf(fsx, s.legacy) !== realOrSelf(fsx, s.target) && !isSymlink(fsx, s.legacy)) {
      const movedNames = [];
      let refusedAny = false;
      const moveItem = (rel) => {
        const from = path.join(s.legacy, rel), to = path.join(s.target, rel);
        if (lexists(fsx, to) && !holdsNoFiles(fsx, to)) {
          refusedAny = true;
          result.refused.push({ root: `db/${rel}`, from, to, reason: 'target already has data' });
          log(`[HOME] not moving db/${rel}: target already has data\n         legacy: ${from}\n         target: ${to}`);
          return;
        }
        try { moveTree(fsx, from, to); movedNames.push(rel); }
        catch (err) { refusedAny = true; refuse({ name: `db/${rel}`, legacy: from, target: to }, `move failed: ${err.message}`); }
      };
      for (const name of fsx.readdirSync(s.legacy)) {
        if (dbKeep(name)) continue;
        if (name === 'retrieval') {
          for (const inner of fsx.readdirSync(path.join(s.legacy, 'retrieval'))) {
            if (inner === '_scopes.json') continue;
            moveItem(path.join('retrieval', inner));
          }
          continue;
        }
        moveItem(name);
      }
      if (movedNames.length) result.moved.push({ root: 'db', from: s.legacy, to: s.target, method: 'files', files: movedNames });
      if (!refusedAny) record('db', s.legacy, 'files');
    }
  }

  // 4. Vault
  {
    const s = spec('vault');
    const a = assess(s);
    if (a && a.refuse) refuse(s, a.refuse);
    else if (!a) {
      try {
        move(s);
        // The legacy block-data folder that held the Vault: drop it when only caches remain.
        const parent = path.dirname(s.legacy);
        try {
          const left = fsx.readdirSync(parent);
          if (left.every(n => LEGACY_VAULT_PARENT_CACHES.has(n))) {
            for (const n of left) fsx.rmSync(path.join(parent, n), { recursive: true, force: true });
            fsx.rmdirSync(parent);
          }
        } catch { /* leave it */ }
      } catch (err) { refuse(s, `move failed: ${err.message}`); }
    }
  }

  // 5. data — last: it is the big one.
  {
    const s = spec('data');
    const a = assess(s);
    if (a && a.refuse) refuse(s, a.refuse);
    else if (!a) { try { move(s); } catch (err) { refuse(s, `move failed: ${err.message}`); } }
  }

  // A pointer for humans (and a read-only install may refuse it — fine).
  try { fsx.writeFileSync(path.join(appRoot, STUB_FILE), `${r.home}\n`); } catch { /* best effort */ }

  return result;
}

/**
 * What both entry points call: migrate, then make sure the home exists.
 * Returns the roots the process will run on plus the migration report.
 */
function prepareHome(opts = {}) {
  const migration = migrateToHome(opts);
  const env = opts.env || process.env;
  const r = home.roots({ appRoot: opts.appRoot, env, homedir: opts.homedir });
  let ensured = null;
  if (!isCloud()) {
    try { ensured = home.ensureHome(r, { appRoot: opts.appRoot }); }
    catch (e) { migration.warnings.push(`[HOME] could not prepare ${r.home}: ${e.message}`); }
  }
  return { roots: r, migration, ensured };
}

module.exports = { migrateToHome, prepareHome, parseEnvFile, holdsNoFiles, moveTree, STUB_FILE };
