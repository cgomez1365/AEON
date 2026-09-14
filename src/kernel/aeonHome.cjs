/**
 * The AEON home — where the operator's data lives, outside the install.
 *
 * Before 2026-09-14 every writable root defaulted to a folder INSIDE the
 * install directory: the Vault under src/blocks/aeon_matrix/data, models under
 * data/, keyslots under secrets/, the master key in <install>/.env, runtime
 * state in db/, settings in src/. Each was redirectable by its own env var, and
 * a packaged build or a USB bundle set all of them. A plain `git clone` set
 * none — so for the ordinary operator a reinstall was a data-loss event, and
 * "restore .env, secrets, Vault and data before first launch" was a procedure
 * that had to be written down and remembered.
 *
 * Now the defaults all point at ONE folder, the AEON home:
 *
 *     <home>/Vault               documents, memories, block memory
 *     <home>/data                indexes, local models, block state
 *     <home>/secrets             keyslots, endpoint registry   (mode 0700)
 *     <home>/.env                master key, API keys, configuration
 *     <home>/db                  runtime state (chat log, audit, retrieval indexes)
 *     <home>/aeon-settings.json  the nervous system's settings
 *     <home>/home.json           this module's own record of the home
 *
 * The home is `~/AEON` on every OS (os.homedir()/AEON), or AEON_HOME. The
 * install can then be read-only and a reinstall is `git pull`.
 *
 * Rules:
 *
 *   1. AEON_HOME is read from the PROCESS environment only, never from .env —
 *      .env lives inside the home, so it cannot say where the home is.
 *
 *   2. Every per-root override keeps winning: VAULT_PATH, DATA_PATH,
 *      AEON_SECRETS_DIR, AEON_ENV_FILE, AEON_DB_DIR, AEON_SETTINGS_FILE,
 *      AEON_WORKSPACE. A relative value resolves against the install, never
 *      process.cwd() — the rule services/local-runtime/paths.cjs and
 *      src/kernel/envFile.cjs already enforce, for the reason written there.
 *
 *   3. A portable install (AEON_PORTABLE=true) keeps the legacy layout: every
 *      default stays inside the install, because a USB drive must write
 *      nothing to the host. Its own .env then points each root at the drive.
 *
 *   4. Someone who clones the repo INTO ~/AEON would otherwise have the home
 *      equal the install — the exact situation this module ends. That case
 *      falls back to `~/AEON Data` and says so.
 *
 * This is the ONLY reader of os.homedir() outside services/local-runtime/
 * paths.cjs. tools/scan/path-authority.cjs allows it by name; nothing else may
 * reach for a home directory.
 *
 * Kernel module: relative requires only, no reach into services/.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR_NAME = 'AEON';
const COLLISION_DIR_NAME = 'AEON Data';
const HOME_MANIFEST = 'home.json';
const HOME_SCHEMA = 1;

/** Legacy (in-install) location of every root, relative to the install. */
const LEGACY = Object.freeze({
  vault: path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault'),
  data: 'data',
  secrets: 'secrets',
  envFile: '.env',
  db: 'db',
  settings: path.join('src', 'aeon-settings.json'),
});

/** The env var that overrides each root on its own. */
const OVERRIDE_VAR = Object.freeze({
  vault: 'VAULT_PATH',
  data: 'DATA_PATH',
  secrets: 'AEON_SECRETS_DIR',
  envFile: 'AEON_ENV_FILE',
  db: 'AEON_DB_DIR',
  settings: 'AEON_SETTINGS_FILE',
  workspace: 'AEON_WORKSPACE',
});

function assertAppRoot(appRoot) {
  if (!appRoot || typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) {
    throw new Error('aeonHome: ctx.appRoot must be an absolute path');
  }
}

/** "" and "   " are unset — a launcher exporting an empty var must not yield a garbage path. */
function nonBlank(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** join, not resolve: path.resolve would fill a drive-less root from cwd on Windows. */
function against(appRoot, value) {
  return path.isAbsolute(value) ? value : path.join(appRoot, value);
}

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function isPortable(env) {
  return env.AEON_PORTABLE === 'true';
}

/**
 * Resolve the home directory.
 *
 * @param {{ appRoot: string, env?: object, homedir?: () => string, warn?: (msg: string) => void }} ctx
 * @returns {string} absolute path of the AEON home
 */
function resolveHome(ctx = {}) {
  const appRoot = ctx.appRoot;
  assertAppRoot(appRoot);
  const env = ctx.env || process.env;
  const homedir = ctx.homedir || os.homedir;
  const warn = typeof ctx.warn === 'function' ? ctx.warn : null;

  // Portable media: the install IS the home. Nothing touches the host.
  if (isPortable(env)) return appRoot;

  const override = nonBlank(env.AEON_HOME);
  let home = override ? against(appRoot, override) : path.join(homedir(), HOME_DIR_NAME);

  if (realOrSelf(home) === realOrSelf(appRoot)) {
    const fallback = path.join(homedir(), COLLISION_DIR_NAME);
    if (warn) warn(`AEON home ${home} is the install directory itself — using ${fallback} instead`);
    home = fallback;
  }
  return home;
}

/**
 * Every root, with each per-root env var winning when set.
 *
 * @param {{ appRoot: string, env?: object, homedir?: () => string, warn?: Function }} ctx
 * @returns {{ home: string, vault: string, data: string, secrets: string, db: string,
 *             envFile: string, settings: string, workspace: string }}
 */
function roots(ctx = {}) {
  const appRoot = ctx.appRoot;
  assertAppRoot(appRoot);
  const env = ctx.env || process.env;
  const home = resolveHome({ ...ctx, env });
  const portable = isPortable(env);

  // In the legacy layout (portable) each root sits where it always did; in the
  // home layout each root is a child of the home.
  const dflt = (name) => (portable ? path.join(appRoot, LEGACY[name]) : path.join(home, path.basename(LEGACY[name])));
  const pick = (name, fallback) => {
    const v = nonBlank(env[OVERRIDE_VAR[name]]);
    return v ? against(appRoot, v) : fallback;
  };

  return {
    home,
    vault: pick('vault', dflt('vault')),
    data: pick('data', dflt('data')),
    secrets: pick('secrets', dflt('secrets')),
    db: pick('db', dflt('db')),
    envFile: pick('envFile', dflt('envFile')),
    settings: pick('settings', dflt('settings')),
    // The File Manager and OS tools open here. The home (not the install, not
    // the operator's whole profile) is what a consumer install should greet
    // its owner with; the portable layout keeps the install as before.
    workspace: pick('workspace', portable ? appRoot : home),
  };
}

/** True when the root's env var is set (non-blank) — i.e. the operator, not the home, chose it. */
function isOverridden(name, env = process.env) {
  return !!nonBlank(env[OVERRIDE_VAR[name]]);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function manifestPath(home) { return path.join(home, HOME_MANIFEST); }

/** The home's own record. null when the home has never been set up. */
function readManifest(home) {
  const m = readJson(manifestPath(home));
  return m && typeof m === 'object' ? m : null;
}

/** Merge fields into home.json (creating it). Returns the written record. */
function updateManifest(home, fields) {
  const current = readManifest(home) || { schema: HOME_SCHEMA, createdAt: new Date().toISOString() };
  const next = { ...current, ...fields, schema: HOME_SCHEMA, updatedAt: new Date().toISOString() };
  fs.mkdirSync(home, { recursive: true });
  writeJsonAtomic(manifestPath(home), next);
  return next;
}

/**
 * Seed <db>/retrieval/_scopes.json from the install's tracked copy when the
 * home has none (or an empty one). The scope registry is the one db/ file that
 * ships with the install; every other db/ file is runtime state.
 */
function seedRetrievalScopes({ appRoot, db }) {
  const src = path.join(appRoot, LEGACY.db, 'retrieval', '_scopes.json');
  const dst = path.join(db, 'retrieval', '_scopes.json');
  if (realOrSelf(src) === realOrSelf(dst)) return false;
  if (!fs.existsSync(src)) return false;
  const have = readJson(dst);
  const empty = !have || (typeof have === 'object' && Object.keys(have).length === 0);
  if (!empty) return false;
  const seed = readJson(src);
  if (!seed || typeof seed !== 'object' || Object.keys(seed).length === 0) {
    if (have) return false;            // both empty — nothing to copy
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

/**
 * Create the home skeleton. Idempotent, and safe to call on every boot.
 *
 * Does NOT create the Vault or data trees' contents — only the directories —
 * and never touches a root the operator redirected elsewhere except to make
 * sure it exists. Cloud runtimes have no writable home; callers guard that.
 *
 * @param {ReturnType<typeof roots>} r
 * @param {{ appRoot: string }} ctx
 */
function ensureHome(r, ctx = {}) {
  const appRoot = ctx.appRoot;
  assertAppRoot(appRoot);
  fs.mkdirSync(r.home, { recursive: true });
  for (const dir of [r.vault, r.data, r.db, path.dirname(r.envFile), path.dirname(r.settings)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(r.secrets, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(r.secrets, 0o700); } catch { /* Windows: ACLs, not modes */ }

  let seededScopes = false;
  try { seededScopes = seedRetrievalScopes({ appRoot, db: r.db }); } catch { /* retrieval.cjs tolerates {} */ }

  const manifest = updateManifest(r.home, { appRoot });
  return { home: r.home, manifest, seededScopes };
}

module.exports = {
  resolveHome,
  roots,
  ensureHome,
  isOverridden,
  readManifest,
  updateManifest,
  seedRetrievalScopes,
  LEGACY,
  OVERRIDE_VAR,
  HOME_DIR_NAME,
  COLLISION_DIR_NAME,
  HOME_MANIFEST,
};
