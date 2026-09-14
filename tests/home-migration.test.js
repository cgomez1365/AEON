/**
 * The one-time move of an existing install's data into the AEON home.
 *
 * src/kernel/homeMigration.cjs runs at the top of launch.js and server.js. It
 * is the only code that ever moves the operator's data, so every rule it
 * follows is asserted here on real temp directories: per-root, never merging,
 * never deleting, the vault protector moved as a pair and rolled back as a
 * pair, resumable, and silent on cloud/portable installs.
 *
 * The vault case is driven through the REAL vault (src/kernel/vault.cjs) in
 * child processes, because vault.cjs resolves its secrets dir and .env at
 * require time — exactly as the server does. Create a vault in the legacy
 * layout, migrate, then unlock it from the home layout the way boot would:
 * envFile → dotenv → AEON_VAULT_MASTER_KEY → keyslots → DEK.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(process.cwd());
const { migrateToHome, prepareHome } = require('../src/kernel/homeMigration.cjs');
const home = require('../src/kernel/aeonHome.cjs');

let tmp, appRoot, homeDir;
const KEY = crypto.randomBytes(32).toString('hex');

/** An install from before the home existed: every root inside the folder. */
function makeLegacyInstall(root, { withVault = true } = {}) {
  const w = (rel, body) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  w('package.json', '{"name":"aeon"}');
  w('.env', `GROQ_API_KEY=\nAEON_VAULT_MASTER_KEY=${KEY}\n`);
  w(path.join('src', 'aeon-settings.json'), '{"models":{}}');
  w(path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault', 'notes', 'doc.md'), '# doc');
  w(path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault', 'Agents', 'Aeon', 'memory', 'memories.json'), '[]');
  w(path.join('src', 'blocks', 'aeon_matrix', 'data', '.extract-cache', 'x.json'), '{}');
  w(path.join('data', 'local-runtime', 'models', 'tiny', 'tiny.gguf'), Buffer.alloc(4096, 7));
  w(path.join('data', 'vault_index.json'), '{"documents":{}}');
  // db/: tracked seeds stay, runtime state moves.
  w(path.join('db', 'aeon_vault_schema.sql'), '-- seed');
  w(path.join('db', 'migrations', '001.sql'), '-- seed');
  w(path.join('db', 'retrieval', '_scopes.json'), '{"hr":{"domain":"hr"}}');
  w(path.join('db', 'retrieval', 'hr.json'), '{"chunks":[]}');
  w(path.join('db', 'audit_log.json'), '[]');
  w(path.join('db', 'llm_calls.jsonl'), '{}\n');
  w(path.join('db', 'logs', 'audit_low.log'), 'x\n');
  w(path.join('db', 'aeon-block-runstate.json'), '{}');
  if (!withVault) return;
  // A REAL vault in the legacy layout — keyslots + an encrypted secret.
  const r = spawnSync(process.execPath, ['-e', `
    const v = require(${JSON.stringify(path.join(REPO, 'src', 'kernel', 'vault.cjs'))});
    const k = v.ensureKeyslots();
    if (!k.created) throw new Error('keyslots not created: ' + k.reason);
    v.setSecret('probe-key', 'sk-probe-value').then(() => { if (!v.isUnlocked()) throw new Error('locked'); });
  `], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      AEON_SECRETS_DIR: path.join(root, 'secrets'),
      AEON_VAULT_MASTER_KEY: KEY,
      AEON_HOME: path.join(root, '.never-used-home'), // vault.cjs never writes here; belt and braces
    },
  });
  if (r.status !== 0) throw new Error(`legacy vault setup failed: ${r.stderr}`);
  expect(fs.existsSync(path.join(root, 'secrets', 'aeon-keyslots.json'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'secrets', 'aeon-vault.json'))).toBe(true);
}

/** Boot-order unlock from the home layout: .env via the authority, then the vault. */
function unlockFromHome(homePath) {
  return spawnSync(process.execPath, ['-e', `
    const path = require('path');
    const { envFilePath } = require(${JSON.stringify(path.join(REPO, 'src', 'kernel', 'envFile.cjs'))});
    const envFile = envFilePath({ appRoot: ${JSON.stringify(REPO)} });
    if (envFile !== path.join(process.env.AEON_HOME, '.env')) throw new Error('env authority did not resolve to the home: ' + envFile);
    require(${JSON.stringify(path.join(REPO, 'node_modules', 'dotenv'))}).config({ path: envFile });
    if (!process.env.AEON_VAULT_MASTER_KEY) throw new Error('master key not loaded from ' + envFile);
    const v = require(${JSON.stringify(path.join(REPO, 'src', 'kernel', 'vault.cjs'))});
    const st = v.getRecoveryStatus();
    if (!st.hasKeyslots) throw new Error('no keyslots in the home secrets dir');
    if (!v.isUnlocked()) throw new Error('vault locked after migration');
    v.getSecret('probe-key').then((s) => { if (s !== 'sk-probe-value') throw new Error('secret mismatch: ' + s); process.stdout.write('UNLOCKED'); });
  `], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AEON_HOME: homePath },
  });
}

const exists = (p) => fs.existsSync(p);
const legacy = (rel) => path.join(appRoot, rel);
const inHome = (rel) => path.join(homeDir, rel);
const baseEnv = () => ({ AEON_HOME: homeDir });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-migrate-'));
  appRoot = path.join(tmp, 'install');
  homeDir = path.join(tmp, 'home');
  fs.mkdirSync(appRoot, { recursive: true });
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('home migration — (a) legacy → home, and the vault still unlocks', () => {
  it('moves every root and the vault opens from the home layout', () => {
    makeLegacyInstall(appRoot);
    const { migration, roots } = prepareHome({ appRoot, env: baseEnv() });
    expect(migration.ran).toBe(true);
    expect(migration.refused).toEqual([]);
    expect(migration.moved.map(m => m.root).sort()).toEqual(['data', 'db', 'envFile', 'secrets', 'settings', 'vault']);

    // Where things are now.
    expect(exists(inHome('.env'))).toBe(true);
    expect(exists(inHome(path.join('secrets', 'aeon-keyslots.json')))).toBe(true);
    expect(exists(inHome('aeon-settings.json'))).toBe(true);
    expect(exists(inHome(path.join('Vault', 'notes', 'doc.md')))).toBe(true);
    expect(exists(inHome(path.join('data', 'local-runtime', 'models', 'tiny', 'tiny.gguf')))).toBe(true);
    expect(exists(inHome(path.join('db', 'audit_log.json')))).toBe(true);
    expect(exists(inHome(path.join('db', 'llm_calls.jsonl')))).toBe(true);
    expect(exists(inHome(path.join('db', 'logs', 'audit_low.log')))).toBe(true);
    expect(exists(inHome(path.join('db', 'retrieval', 'hr.json')))).toBe(true);
    expect(exists(inHome(path.join('db', 'aeon-block-runstate.json')))).toBe(true);
    // The scope registry was SEEDED from the install's tracked copy.
    expect(JSON.parse(fs.readFileSync(inHome(path.join('db', 'retrieval', '_scopes.json')), 'utf8'))).toEqual({ hr: { domain: 'hr' } });

    // Where things are not.
    expect(exists(legacy('.env'))).toBe(false);
    expect(exists(legacy('secrets'))).toBe(false);
    expect(exists(legacy(path.join('src', 'aeon-settings.json')))).toBe(false);
    expect(exists(legacy(path.join('src', 'blocks', 'aeon_matrix', 'data')))).toBe(false); // parent gone with its cache
    expect(exists(legacy('data'))).toBe(false);
    expect(exists(legacy(path.join('db', 'audit_log.json')))).toBe(false);
    // Tracked seeds never leave the install.
    expect(exists(legacy(path.join('db', 'aeon_vault_schema.sql')))).toBe(true);
    expect(exists(legacy(path.join('db', 'migrations', '001.sql')))).toBe(true);
    expect(exists(legacy(path.join('db', 'retrieval', '_scopes.json')))).toBe(true);

    // home.json remembers, the stub points, the roots agree.
    const manifest = home.readManifest(homeDir);
    expect(Object.keys(manifest.migrated).sort()).toEqual(['data', 'db', 'envFile', 'secrets', 'settings', 'vault']);
    expect(fs.readFileSync(legacy('.aeon-home'), 'utf8').trim()).toBe(homeDir);
    expect(roots.vault).toBe(inHome('Vault'));

    // The vault unlocks through the real boot path.
    const r = unlockFromHome(homeDir);
    expect(r.stderr, r.stderr).toBe('');
    expect(r.stdout).toContain('UNLOCKED');
  });
});

describe('home migration — (b) a second run is a no-op', () => {
  it('moves nothing and refuses nothing', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.mkdirSync(legacy('secrets'), { recursive: true });
    fs.writeFileSync(legacy(path.join('secrets', 'aeon-keyslots.json')), '{}');
    const first = migrateToHome({ appRoot, env: baseEnv() });
    expect(first.moved.length).toBeGreaterThan(0);
    const snapshot = JSON.stringify(home.readManifest(homeDir).migrated);
    const second = migrateToHome({ appRoot, env: baseEnv() });
    expect(second.ran).toBe(true);
    expect(second.moved).toEqual([]);
    expect(second.refused).toEqual([]);
    expect(JSON.stringify(home.readManifest(homeDir).migrated)).toBe(snapshot);
  });
});

describe('home migration — (c) a populated target is refused, never merged', () => {
  it('leaves the legacy Vault where it is and still moves the other roots', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.mkdirSync(inHome('Vault'), { recursive: true });
    fs.writeFileSync(inHome(path.join('Vault', 'other.md')), 'someone else\'s vault');
    const logs = [];
    const r = migrateToHome({ appRoot, env: baseEnv(), log: (m) => logs.push(m) });
    expect(r.refused.map(x => x.root)).toEqual(['vault']);
    expect(r.refused[0].from).toBe(legacy(path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault')));
    expect(r.refused[0].to).toBe(inHome('Vault'));
    // Both paths are printed for the operator.
    expect(logs.join('\n')).toContain(r.refused[0].from);
    expect(logs.join('\n')).toContain(r.refused[0].to);
    // Legacy untouched, target untouched.
    expect(exists(legacy(path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault', 'notes', 'doc.md')))).toBe(true);
    expect(fs.readdirSync(inHome('Vault'))).toEqual(['other.md']);
    // Everything else moved.
    expect(r.moved.map(m => m.root)).toContain('data');
    expect(r.moved.map(m => m.root)).toContain('envFile');
    expect(home.readManifest(homeDir).migrated.vault).toBeUndefined();
  });

  it('a target holding only empty directories counts as empty (module-scope mkdirs)', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.mkdirSync(inHome(path.join('data', 'runtime', 'temp_frames')), { recursive: true });
    const r = migrateToHome({ appRoot, env: baseEnv() });
    expect(r.refused).toEqual([]);
    expect(exists(inHome(path.join('data', 'vault_index.json')))).toBe(true);
  });
});

describe('home migration — (d) portable and cloud installs are skipped', () => {
  it('AEON_PORTABLE=true → skipped, nothing moves', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const r = migrateToHome({ appRoot, env: { ...baseEnv(), AEON_PORTABLE: 'true' } });
    expect(r).toMatchObject({ ran: false, skipped: true, reason: 'portable', moved: [] });
    expect(exists(legacy('.env'))).toBe(true);
    expect(exists(homeDir)).toBe(false);
  });

  it('AEON_PORTABLE=true declared in the legacy .env is honoured too', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.appendFileSync(legacy('.env'), 'AEON_PORTABLE=true\n');
    const r = migrateToHome({ appRoot, env: baseEnv() });
    expect(r.reason).toBe('portable');
    expect(exists(homeDir)).toBe(false);
  });

  it('a cloud runtime → skipped, nothing moves', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const saved = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const r = migrateToHome({ appRoot, env: baseEnv() });
      expect(r).toMatchObject({ ran: false, skipped: true, reason: 'cloud', moved: [] });
      const prep = prepareHome({ appRoot, env: baseEnv() });
      expect(prep.ensured).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
    }
    expect(exists(legacy('.env'))).toBe(true);
    expect(exists(homeDir)).toBe(false);
  });

  it('AEON_HOME_MIGRATE=0 → skipped', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const r = migrateToHome({ appRoot, env: { ...baseEnv(), AEON_HOME_MIGRATE: '0' } });
    expect(r.reason).toBe('disabled');
    expect(exists(legacy('.env'))).toBe(true);
  });
});

describe('home migration — (e) a per-root override skips only that root', () => {
  it('VAULT_PATH set in the process env: the Vault stays, everything else moves', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const r = migrateToHome({ appRoot, env: { ...baseEnv(), VAULT_PATH: path.join(tmp, 'elsewhere') } });
    expect(r.moved.map(m => m.root)).not.toContain('vault');
    expect(r.moved.map(m => m.root)).toEqual(expect.arrayContaining(['envFile', 'settings', 'db', 'data']));
    expect(exists(legacy(path.join('src', 'blocks', 'aeon_matrix', 'data', 'Vault', 'notes', 'doc.md')))).toBe(true);
    expect(exists(inHome('Vault'))).toBe(false);
  });

  it('VAULT_PATH set in the legacy .env counts too — dotenv loads it right after', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.appendFileSync(legacy('.env'), `VAULT_PATH=${path.join(tmp, 'elsewhere')}\n`);
    const r = migrateToHome({ appRoot, env: baseEnv() });
    expect(r.moved.map(m => m.root)).not.toContain('vault');
    expect(r.moved.map(m => m.root)).toContain('data');
  });
});

describe('home migration — (f) .env and secrets move as one', () => {
  it('when secrets cannot follow, .env goes back beside its keyslots', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.mkdirSync(legacy('secrets'), { recursive: true });
    fs.writeFileSync(legacy(path.join('secrets', 'aeon-keyslots.json')), '{"v":1}');
    const secretsLegacy = legacy('secrets');
    const brokenFs = {
      ...fs,
      renameSync(from, to) {
        if (from === secretsLegacy) { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
        return fs.renameSync(from, to);
      },
    };
    const r = migrateToHome({ appRoot, env: baseEnv(), fs: brokenFs });
    expect(r.refused.map(x => x.root)).toContain('secrets');
    expect(r.moved.map(m => m.root)).not.toContain('envFile');
    expect(r.moved.map(m => m.root)).not.toContain('secrets');
    // .env is back where the keyslots are; the home has neither.
    expect(fs.readFileSync(legacy('.env'), 'utf8')).toContain(`AEON_VAULT_MASTER_KEY=${KEY}`);
    expect(exists(inHome('.env'))).toBe(false);
    expect(exists(legacy(path.join('secrets', 'aeon-keyslots.json')))).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/moved back/);
    const m = home.readManifest(homeDir).migrated || {};
    expect(m.envFile).toBeUndefined();
    expect(m.secrets).toBeUndefined();
    // The other roots still moved: per root, not all-or-nothing.
    expect(r.moved.map(m => m.root)).toEqual(expect.arrayContaining(['settings', 'data', 'vault']));
  });

  it('a populated secrets target refuses BOTH halves', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    fs.mkdirSync(legacy('secrets'), { recursive: true });
    fs.writeFileSync(legacy(path.join('secrets', 'aeon-keyslots.json')), '{"v":1}');
    fs.mkdirSync(inHome('secrets'), { recursive: true });
    fs.writeFileSync(inHome(path.join('secrets', 'aeon-keyslots.json')), '{"v":"other"}');
    const r = migrateToHome({ appRoot, env: baseEnv() });
    expect(r.refused.map(x => x.root)).toEqual(['secrets']);
    expect(r.moved.map(m => m.root)).not.toContain('envFile');
    expect(exists(legacy('.env'))).toBe(true);
    expect(exists(inHome('.env'))).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/move together/);
  });
});

describe('home migration — cross-volume path (copy, verify, remove)', () => {
  it('falls back to a verified copy on EXDEV and removes the legacy tree only after', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const dataLegacy = legacy('data');
    const exdevFs = {
      ...fs,
      renameSync(from, to) {
        if (from === dataLegacy) { const e = new Error('EXDEV: cross-device link'); e.code = 'EXDEV'; throw e; }
        return fs.renameSync(from, to);
      },
    };
    const r = migrateToHome({ appRoot, env: baseEnv(), fs: exdevFs });
    const data = r.moved.find(m => m.root === 'data');
    expect(data.method).toBe('copy');
    expect(fs.statSync(inHome(path.join('data', 'local-runtime', 'models', 'tiny', 'tiny.gguf'))).size).toBe(4096);
    expect(exists(dataLegacy)).toBe(false);
  });

  it('a copy that fails verification keeps the legacy tree and removes the partial target', () => {
    makeLegacyInstall(appRoot, { withVault: false });
    const dataLegacy = legacy('data');
    const lyingFs = {
      ...fs,
      renameSync(from, to) {
        if (from === dataLegacy) { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; }
        return fs.renameSync(from, to);
      },
      cpSync(from, to, opts) {
        fs.cpSync(from, to, opts);
        if (from === dataLegacy) fs.truncateSync(path.join(to, 'local-runtime', 'models', 'tiny', 'tiny.gguf'), 10);
      },
    };
    const r = migrateToHome({ appRoot, env: baseEnv(), fs: lyingFs });
    expect(r.refused.find(x => x.root === 'data').reason).toMatch(/verification failed/);
    expect(fs.statSync(path.join(dataLegacy, 'local-runtime', 'models', 'tiny', 'tiny.gguf')).size).toBe(4096);
    expect(exists(inHome('data'))).toBe(false);
  });
});
