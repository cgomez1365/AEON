/**
 * <AEON home>/.env holds AEON_VAULT_MASTER_KEY — one of the two halves that
 * unlock every stored API key (the other is secrets/aeon-keyslots.json). The
 * launcher created it with fs.copyFileSync from .env.example (mode 0644) and
 * rewrote it with a bare fs.writeFileSync, so on macOS/Linux any other local
 * account could read the master key. Measured 2026-09-23: .env.example in the
 * checkout is 0644, and copyFileSync carries that mode to the new file.
 *
 * Required: a new .env is written 0600, and an existing one is tightened to
 * 0600 on every launch (an install from before this fix keeps its 0644 file
 * until something changes it — the launcher is that something).
 *
 * launch.js runs the whole first-run wizard at top level. It must be safe to
 * require (it exports its helpers and runs nothing), or this test would boot a
 * server. The first assertion checks that from the SOURCE, so on the old code
 * the test fails without ever executing the launcher.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(__dirname, '..', 'launch.js');
const src = fs.readFileSync(LAUNCH, 'utf8');
const requirable = /if\s*\(\s*require\.main\s*!==\s*module\s*\)/.test(src);
const launcher = requirable ? require(LAUNCH) : {};

const POSIX = process.platform !== 'win32';
const modeOf = (f) => fs.statSync(f).mode & 0o777;

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-envmode-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('launch.js can be required without launching', () => {
  it('guards its top-level work behind require.main', () => {
    expect(requirable, 'requiring launch.js would run the wizard and boot a server').toBe(true);
  });

  it('exports the .env writers', () => {
    expect(typeof launcher.writeEnvFile).toBe('function');
    expect(typeof launcher.secureEnvFile).toBe('function');
  });
});

describe.runIf(POSIX)('.env is owner-only (0600)', () => {
  it('a new .env is created 0600', () => {
    const f = path.join(tmp(), '.env');
    launcher.writeEnvFile(f, 'AEON_VAULT_MASTER_KEY=fixture\n');
    expect(modeOf(f).toString(8)).toBe('600');
    expect(fs.readFileSync(f, 'utf8')).toBe('AEON_VAULT_MASTER_KEY=fixture\n');
  });

  it('rewriting an existing 0644 .env leaves it 0600', () => {
    const f = path.join(tmp(), '.env');
    fs.writeFileSync(f, 'OLD=1\n', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    launcher.writeEnvFile(f, 'NEW=1\n');
    expect(modeOf(f).toString(8)).toBe('600');
  });

  it('a .env copied from the 0644 template is tightened, and says what it changed', () => {
    const d = tmp();
    const example = path.join(d, '.env.example');
    fs.writeFileSync(example, 'X=\n');
    fs.chmodSync(example, 0o644);
    const f = path.join(d, '.env');
    fs.copyFileSync(example, f);
    expect(modeOf(f).toString(8)).toBe('644'); // the defect's starting point
    const r = launcher.secureEnvFile(f);
    expect(modeOf(f).toString(8)).toBe('600');
    expect(r).toMatchObject({ changed: true, from: '644' });
  });

  it('an already-private .env is left alone and reported unchanged', () => {
    const f = path.join(tmp(), '.env');
    fs.writeFileSync(f, 'X=1\n', { mode: 0o600 });
    expect(launcher.secureEnvFile(f)).toMatchObject({ changed: false });
    expect(modeOf(f).toString(8)).toBe('600');
  });

  it('a missing file is reported, not thrown', () => {
    const r = launcher.secureEnvFile(path.join(tmp(), 'nope', '.env'));
    expect(r.changed).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('the launcher uses them on every path that writes .env', () => {
  it('no bare fs.writeFileSync(ENV_PATH, …) remains', () => {
    expect(src).not.toMatch(/fs\.writeFileSync\(\s*ENV_PATH/);
  });

  it('tightens the file on every launch, not only when it creates one', () => {
    expect(src).toMatch(/secureEnvFile\(\s*ENV_PATH\s*\)/);
  });
});

describe('the server writes .env owner-only too (npm run server skips the launcher)', () => {
  it('the first-run vault key write in server.js sets mode 0600', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const at = src.indexOf('console.log(`[FIRST RUN] Vault master key generated');
    expect(at).toBeGreaterThan(-1);
    const write = src.slice(src.lastIndexOf('fs.writeFileSync(envFile', at), at);
    expect(write).toMatch(/fs\.writeFileSync\(envFile, env, \{ mode: 0o600 \}\)/);
    expect(write).toMatch(/chmodSync\(envFile, 0o600\)/);
  });
});
