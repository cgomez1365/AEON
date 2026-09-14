/**
 * The AEON home — one folder outside the install for everything the operator
 * would lose in a reinstall.
 *
 * Before 2026-09-14 the Vault, models, keyslots, .env, runtime state and
 * settings all defaulted to folders INSIDE the install directory. A plain
 * `git clone` install therefore had to be backed up by hand before every
 * reinstall, and the reinstall procedure ("stop the app, copy .env, secrets,
 * Vault and data out, restore before first launch") existed only because the
 * defaults were wrong. src/kernel/aeonHome.cjs makes ~/AEON the default for
 * all of them at once, keeps every per-root override working, and is the one
 * place allowed to ask for the home directory.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const home = require('../src/kernel/aeonHome.cjs');

const APP = path.resolve('/opt/aeon');
const fakeHomedir = () => path.resolve('/Users/someone');
const ROOT_KEYS = ['vault', 'data', 'secrets', 'db', 'envFile', 'settings', 'workspace'];

describe('AEON home — defaults', () => {
  it('AEON_HOME sets every root at once', () => {
    const r = home.roots({ appRoot: APP, env: { AEON_HOME: '/opt/home' }, homedir: fakeHomedir });
    expect(r.home).toBe(path.resolve('/opt/home'));
    expect(r.vault).toBe(path.join(r.home, 'Vault'));
    expect(r.data).toBe(path.join(r.home, 'data'));
    expect(r.secrets).toBe(path.join(r.home, 'secrets'));
    expect(r.db).toBe(path.join(r.home, 'db'));
    expect(r.envFile).toBe(path.join(r.home, '.env'));
    expect(r.settings).toBe(path.join(r.home, 'aeon-settings.json'));
    expect(r.workspace).toBe(r.home);
    for (const k of ROOT_KEYS) expect(r[k].startsWith(APP), `${k} must leave the install`).toBe(false);
  });

  it('without AEON_HOME the home is <homedir>/AEON on every OS', () => {
    const r = home.roots({ appRoot: APP, env: {}, homedir: fakeHomedir });
    expect(r.home).toBe(path.join(fakeHomedir(), 'AEON'));
    expect(r.vault).toBe(path.join(fakeHomedir(), 'AEON', 'Vault'));
  });

  it('a blank AEON_HOME is unset, not a path', () => {
    for (const blank of ['', '   ']) {
      const r = home.roots({ appRoot: APP, env: { AEON_HOME: blank }, homedir: fakeHomedir });
      expect(r.home).toBe(path.join(fakeHomedir(), 'AEON'));
    }
  });

  it('a relative AEON_HOME resolves against the install, never cwd', () => {
    const r = home.roots({ appRoot: APP, env: { AEON_HOME: 'my-home' }, homedir: fakeHomedir });
    expect(r.home).toBe(path.join(APP, 'my-home'));
  });

  it('never leaves a "~" in a resolved path', () => {
    const r = home.roots({ appRoot: APP, env: {}, homedir: fakeHomedir });
    for (const k of ['home', ...ROOT_KEYS]) {
      expect(r[k]).not.toContain('~');
      expect(path.isAbsolute(r[k]), `${k} must be absolute`).toBe(true);
    }
  });

  it('requires an absolute appRoot', () => {
    expect(() => home.roots({ appRoot: 'relative', env: {} })).toThrow(/absolute/i);
    expect(() => home.resolveHome({ env: {} })).toThrow(/absolute/i);
  });
});

describe('AEON home — each per-root override still wins', () => {
  const cases = [
    ['vault', 'VAULT_PATH', '/mnt/vault'],
    ['data', 'DATA_PATH', '/mnt/data'],
    ['secrets', 'AEON_SECRETS_DIR', '/mnt/secrets'],
    ['db', 'AEON_DB_DIR', '/mnt/db'],
    ['envFile', 'AEON_ENV_FILE', '/mnt/conf/.env'],
    ['settings', 'AEON_SETTINGS_FILE', '/mnt/conf/settings.json'],
    ['workspace', 'AEON_WORKSPACE', '/mnt/work'],
  ];
  for (const [root, varName, value] of cases) {
    it(`${varName} overrides ${root} and nothing else`, () => {
      const base = home.roots({ appRoot: APP, env: { AEON_HOME: '/opt/home' }, homedir: fakeHomedir });
      const r = home.roots({ appRoot: APP, env: { AEON_HOME: '/opt/home', [varName]: value }, homedir: fakeHomedir });
      expect(r[root]).toBe(path.resolve(value));
      for (const k of ROOT_KEYS) if (k !== root) expect(r[k], `${k} must be untouched`).toBe(base[k]);
      expect(home.isOverridden(root, { [varName]: value })).toBe(true);
      expect(home.isOverridden(root, { [varName]: '  ' })).toBe(false);
    });
  }

  it('a relative override resolves against the install', () => {
    const r = home.roots({ appRoot: APP, env: { AEON_HOME: '/opt/home', VAULT_PATH: 'my-vault' }, homedir: fakeHomedir });
    expect(r.vault).toBe(path.join(APP, 'my-vault'));
  });
});

describe('AEON home — the install is never the home', () => {
  let tmp;
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('a repo cloned to ~/AEON falls back to ~/AEON Data and says so', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-home-'));
    const appRoot = path.join(tmp, 'AEON');      // the clone landed exactly where the home would be
    fs.mkdirSync(appRoot, { recursive: true });
    const warnings = [];
    const r = home.roots({ appRoot, env: {}, homedir: () => tmp, warn: (m) => warnings.push(m) });
    expect(r.home).toBe(path.join(tmp, 'AEON Data'));
    expect(r.vault).toBe(path.join(tmp, 'AEON Data', 'Vault'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/install directory/);
  });

  it('an explicit AEON_HOME equal to the install gets the same fallback', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-home-'));
    const appRoot = path.join(tmp, 'install');
    fs.mkdirSync(appRoot, { recursive: true });
    const r = home.roots({ appRoot, env: { AEON_HOME: appRoot }, homedir: () => tmp });
    expect(r.home).toBe(path.join(tmp, 'AEON Data'));
  });
});

describe('AEON home — portable installs are untouched', () => {
  it('AEON_PORTABLE=true keeps every default inside the install', () => {
    const r = home.roots({ appRoot: APP, env: { AEON_PORTABLE: 'true', AEON_HOME: '/opt/home' }, homedir: fakeHomedir });
    expect(r.home).toBe(APP);
    expect(r.vault).toBe(path.join(APP, 'src', 'blocks', 'aeon_matrix', 'data', 'Vault'));
    expect(r.data).toBe(path.join(APP, 'data'));
    expect(r.secrets).toBe(path.join(APP, 'secrets'));
    expect(r.db).toBe(path.join(APP, 'db'));
    expect(r.envFile).toBe(path.join(APP, '.env'));
    expect(r.settings).toBe(path.join(APP, 'src', 'aeon-settings.json'));
    expect(r.workspace).toBe(APP);
  });
});

describe('AEON home — ensureHome', () => {
  let tmp;
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('creates the skeleton, a private secrets dir, seeds the scope registry and records home.json', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-home-'));
    const appRoot = path.join(tmp, 'install');
    fs.mkdirSync(path.join(appRoot, 'db', 'retrieval'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'db', 'retrieval', '_scopes.json'), JSON.stringify({ hr: { domain: 'hr' } }));
    const r = home.roots({ appRoot, env: { AEON_HOME: path.join(tmp, 'home') } });
    const out = home.ensureHome(r, { appRoot });
    for (const k of ['vault', 'data', 'secrets', 'db']) expect(fs.existsSync(r[k]), k).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(r.secrets).mode & 0o777).toBe(0o700);
    expect(out.seededScopes).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.db, 'retrieval', '_scopes.json'), 'utf8'))).toEqual({ hr: { domain: 'hr' } });
    const manifest = JSON.parse(fs.readFileSync(path.join(r.home, 'home.json'), 'utf8'));
    expect(manifest.schema).toBe(1);
    expect(manifest.appRoot).toBe(appRoot);
    // Idempotent, and a populated registry is never overwritten by the seed.
    fs.writeFileSync(path.join(r.db, 'retrieval', '_scopes.json'), JSON.stringify({ mine: {} }));
    const again = home.ensureHome(r, { appRoot });
    expect(again.seededScopes).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(r.db, 'retrieval', '_scopes.json'), 'utf8'))).toEqual({ mine: {} });
  });
});

describe('AEON home — the one reader of the home directory', () => {
  it('tools/scan/path-authority.cjs allows src/kernel/aeonHome.cjs and nothing new', () => {
    const scan = fs.readFileSync(path.join(process.cwd(), 'tools', 'scan', 'path-authority.cjs'), 'utf8');
    expect(scan).toMatch(/'src\/kernel\/aeonHome\.cjs'/);
  });

  it('the suite is isolated from the real home', () => {
    // tests/setup-isolation.js must have pointed AEON_HOME at a temp dir before
    // any module loaded; otherwise kernel modules that mkdirSync their roots at
    // require time would create ~/AEON on the developer's machine.
    expect(process.env.AEON_HOME).toBeTruthy();
    expect(process.env.AEON_HOME.startsWith(os.tmpdir()) || process.env.AEON_HOME.includes('aeon-suite-')).toBe(true);
  });
});
