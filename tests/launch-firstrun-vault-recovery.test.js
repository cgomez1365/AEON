/**
 * A045 / A017 — the vault recovery code had nowhere to go.
 *
 * vault.ensureKeyslots() wraps the data key under the .env key AND under a
 * recovery code it prints once. README, the sealed-vault message and the
 * printed banner all told the customer to rely on that code, but nothing in
 * AEON called vault.recoverWithCode: no route, no command, no screen. And the
 * launcher made the case worse than "sealed": with .env lost it minted a fresh
 * AEON_VAULT_MASTER_KEY over the existing keyslots, so the vault stayed locked
 * and server.js — which refuses only when the key is MISSING — never said so.
 *
 * Fixed in the launcher, which runs before the server in the same window the
 * code was printed in:
 *   - vaultKeyPlan() tells a first run (mint) from a vault the .env key cannot
 *     open (recover / sealed), and only 'mint' writes a key;
 *   - recoverVault() asks for the code and calls vault.recoverWithCode, which
 *     writes a new key to .env and leaves every stored secret readable;
 *   - createKeyslots() makes the slots in the launcher, so it can stop on the
 *     printed code before the browser opens over it.
 *
 * Everything runs against a temp secrets dir and a temp .env.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const saved = Object.fromEntries(['AEON_HOME', 'AEON_SECRETS_DIR', 'AEON_ENV_FILE', 'AEON_VAULT_MASTER_KEY'].map((k) => [k, process.env[k]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-launch-recover-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
delete process.env.AEON_VAULT_MASTER_KEY;
delete process.env.VERCEL;
// vault.cjs resolves its secrets dir and .env path at module scope: load a
// copy that sees the temp ones, whatever this worker loaded before.
delete require.cache[require.resolve(path.join(ROOT, 'src/kernel/vault.cjs'))];
const vault = require(path.join(ROOT, 'src/kernel/vault.cjs'));
const launcher = require(path.join(ROOT, 'launch.js'));
const { sealedMessage } = require(path.join(ROOT, 'src/kernel/vaultBootGuard.cjs'));

const SECRETS = process.env.AEON_SECRETS_DIR;
const ENV = process.env.AEON_ENV_FILE;
const KEYSLOTS = path.join(SECRETS, 'aeon-keyslots.json');
const ORIGINAL = 'a'.repeat(64);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vault.__resetForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(SECRETS, { recursive: true, force: true });
  fs.mkdirSync(SECRETS, { recursive: true });
  try { fs.rmSync(ENV); } catch { /* none yet */ }
  delete process.env.AEON_VAULT_MASTER_KEY;
  vault.__resetForTest();
});

// A vault made the way a first run makes it, holding one provider key.
async function existingVault() {
  fs.writeFileSync(ENV, `AEON_VAULT_MASTER_KEY=${ORIGINAL}\nPORT=3001\n`);
  process.env.AEON_VAULT_MASTER_KEY = ORIGINAL;
  expect(vault.ensureKeyslots()).toMatchObject({ created: true });
  const code = vault.consumePendingRecoveryCode();
  await vault.setSecret('groq-main', 'sk-fixture-groq', null);
  delete process.env.AEON_VAULT_MASTER_KEY;
  vault.__resetForTest();
  return code;
}

describe('the launcher tells a first run from a vault the .env key cannot open', () => {
  it('no vault and no key: a first run, so a key is made', () => {
    expect(launcher.vaultKeyPlan({ envText: 'PORT=3001\n', vault })).toBe('mint');
  });

  it('a vault whose .env lost its key: recovery, never a new key', async () => {
    await existingVault();
    const envText = 'PORT=3001\n';
    expect(launcher.vaultKeyPlan({ envText, vault })).toBe('recover');
    // What the launcher did before: fill the missing key, which opens nothing.
    expect(launcher.ensureEnvKey(envText, 'AEON_VAULT_MASTER_KEY', () => 'b'.repeat(64)).added).toBe(true);
  });

  it('a vault whose .env holds a different key (one minted over it): recovery', async () => {
    await existingVault();
    expect(launcher.vaultKeyPlan({ envText: `AEON_VAULT_MASTER_KEY=${'b'.repeat(64)}\n`, vault })).toBe('recover');
  });

  it('the right key: nothing to do', async () => {
    await existingVault();
    expect(launcher.vaultKeyPlan({ envText: `AEON_VAULT_MASTER_KEY=${ORIGINAL}\n`, vault })).toBe('keep');
  });

  it('an unreadable keyslot file: sealed, with no code to ask for and no key minted', async () => {
    await existingVault();
    fs.writeFileSync(KEYSLOTS, '{ not json');
    expect(launcher.vaultKeyPlan({ envText: 'PORT=3001\n', vault })).toBe('sealed');
  });
});

describe('the recovery code reopens the vault', () => {
  it('a wrong code is refused, the right one rewrites .env, and the stored key reads again', async () => {
    const code = await existingVault();
    fs.writeFileSync(ENV, 'PORT=3001\n'); // .env lost its key
    const answers = ['AEON-0000-0000-0000-0000-0000', code];
    const said = [];
    const r = await launcher.recoverVault({ vault, ask: async () => answers.shift(), say: (m) => said.push(m) });
    expect(r).toMatchObject({ ok: true, envKeyReissued: true });
    expect(said.join(' ')).toMatch(/does not open this vault/);

    const envText = fs.readFileSync(ENV, 'utf8');
    const newKey = launcher.envValue(envText, 'AEON_VAULT_MASTER_KEY');
    expect(newKey).toMatch(/^[0-9a-f]{64}$/);
    expect(newKey).not.toBe(ORIGINAL);
    expect(envText).toMatch(/^PORT=3001$/m); // the rest of .env is kept

    // A fresh process with only the new .env reads the old secret.
    delete process.env.AEON_VAULT_MASTER_KEY;
    vault.__resetForTest();
    expect(launcher.vaultKeyPlan({ envText, vault })).toBe('keep');
    process.env.AEON_VAULT_MASTER_KEY = newKey;
    expect(await vault.getSecret('groq-main', null)).toBe('sk-fixture-groq');
  });

  it('Enter skips: nothing is written and the vault stays as it was', async () => {
    await existingVault();
    fs.writeFileSync(ENV, 'PORT=3001\n');
    const r = await launcher.recoverVault({ vault, ask: async () => '' });
    expect(r).toMatchObject({ ok: false, error: 'skipped' });
    expect(fs.readFileSync(ENV, 'utf8')).toBe('PORT=3001\n');
    expect(process.env.AEON_VAULT_MASTER_KEY).toBeUndefined();
  });

  it('gives up after three wrong codes', async () => {
    await existingVault();
    let asked = 0;
    const r = await launcher.recoverVault({ vault, ask: async () => { asked++; return 'AEON-WRONG'; } });
    expect(r).toMatchObject({ ok: false, error: 'invalid-code' });
    expect(asked).toBe(3);
  });
});

describe('the code is made where the launcher can stop on it', () => {
  it('createKeyslots makes the slots once and hands back the code', () => {
    const envText = `AEON_VAULT_MASTER_KEY=${ORIGINAL}\n`;
    const code = launcher.createKeyslots({ vault, envText });
    expect(code).toMatch(/^AEON-[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    expect(fs.existsSync(KEYSLOTS)).toBe(true);
    expect(launcher.createKeyslots({ vault, envText })).toBeNull(); // already there
    // The key was lent for the call only.
    expect(process.env.AEON_VAULT_MASTER_KEY).toBeUndefined();
  });

  it('no key, no slots: nothing is made', () => {
    expect(launcher.createKeyslots({ vault, envText: 'PORT=3001\n' })).toBeNull();
    expect(fs.existsSync(KEYSLOTS)).toBe(false);
  });
});

describe('`node launch.js --recover-vault`: the code on every layout', () => {
  // The carried drive's and USB builds' launchers run `node server.cjs`, never
  // launch.js, so "start AEON with its launcher and paste the code" was not
  // true there (review 2026-09-30). This mode is the recovery step alone.
  const quiet = () => {
    const lines = [];
    return { lines, log: { ok: (m) => lines.push(`ok ${m}`), info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) } };
  };

  it('reopens a vault whose .env lost its key', async () => {
    const code = await existingVault();
    fs.writeFileSync(ENV, 'PORT=3001\n');
    const { lines, log } = quiet();
    const exit = await launcher.recoverOnly({ vault, envText: 'PORT=3001\n', ask: async () => code, log });
    expect(exit).toBe(0);
    expect(lines.join('\n')).toMatch(/Vault reopened/);
    const newKey = launcher.envValue(fs.readFileSync(ENV, 'utf8'), 'AEON_VAULT_MASTER_KEY');
    delete process.env.AEON_VAULT_MASTER_KEY;
    vault.__resetForTest();
    process.env.AEON_VAULT_MASTER_KEY = newKey;
    expect(await vault.getSecret('groq-main', null)).toBe('sk-fixture-groq');
  });

  it('a key that already opens the vault: nothing to do, nothing asked', async () => {
    await existingVault();
    let asked = false;
    const { lines, log } = quiet();
    const exit = await launcher.recoverOnly({ vault, envText: `AEON_VAULT_MASTER_KEY=${ORIGINAL}\n`, ask: async () => { asked = true; return ''; }, log });
    expect(exit).toBe(0);
    expect(asked).toBe(false);
    expect(lines.join('\n')).toMatch(/already opens this vault/);
  });

  it('no vault yet: nothing to recover, and no key is made', async () => {
    const { log } = quiet();
    expect(await launcher.recoverOnly({ vault, envText: '', ask: async () => 'x', log })).toBe(0);
    expect(fs.existsSync(KEYSLOTS)).toBe(false);
    expect(fs.existsSync(ENV)).toBe(false);
  });

  it('an unreadable keyslot file: says the code cannot help, writes nothing', async () => {
    await existingVault();
    fs.writeFileSync(KEYSLOTS, '{ not json');
    fs.writeFileSync(ENV, 'PORT=3001\n');
    const { lines, log } = quiet();
    expect(await launcher.recoverOnly({ vault, envText: 'PORT=3001\n', ask: async () => 'x', log })).toBe(1);
    expect(lines.join('\n')).toMatch(/recovery code cannot open it/);
    expect(fs.readFileSync(ENV, 'utf8')).toBe('PORT=3001\n');
  });

  it('skipped: exit 1, .env untouched', async () => {
    await existingVault();
    fs.writeFileSync(ENV, 'PORT=3001\n');
    const { log } = quiet();
    expect(await launcher.recoverOnly({ vault, envText: 'PORT=3001\n', ask: async () => '', log })).toBe(1);
    expect(fs.readFileSync(ENV, 'utf8')).toBe('PORT=3001\n');
  });

  it('the launcher runs it before anything else, and honours a portable build\'s .env', () => {
    const src = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');
    const main = src.slice(src.indexOf('async function main()'));
    expect(main.indexOf('if (recoverMode) {')).toBeGreaterThan(-1);
    expect(main.indexOf('if (recoverMode) {')).toBeLessThan(main.indexOf('const running = runningAeon('));
    expect(main).toMatch(/for \(const f of \['\.env', '\.env\.usb'\]\)/);
    expect(main.indexOf("envValue(fs.readFileSync(path.join(ROOT, f), 'utf8'), 'AEON_PORTABLE')")).toBeGreaterThan(-1);
    expect(main.indexOf("envValue(fs.readFileSync(path.join(ROOT, f), 'utf8'), 'AEON_PORTABLE')")).toBeLessThan(main.indexOf('prepareHome({'));
  });
});

describe('every message points at a path that exists', () => {
  it('the sealed-vault message gives the command, this install\'s folder and its Node', () => {
    const m = sealedMessage({ appRoot: '/Volumes/AEON/AEON', execPath: '/Volumes/AEON/runtime/node/mac/arm64/node' });
    expect(m).toMatch(/node launch\.js --recover-vault/);
    expect(m).toContain('/Volumes/AEON/AEON');
    expect(m).toContain('/Volumes/AEON/runtime/node/mac/arm64/node');
    expect(m).not.toMatch(/It was printed once/);
    // The defaults are this install and the Node running it.
    expect(sealedMessage()).toContain(ROOT);
    expect(sealedMessage()).toContain(process.execPath);
    expect(fs.existsSync(path.join(ROOT, 'launch.js'))).toBe(true);
  });

  it('the banner printed with the code says where to use it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/kernel/vault.cjs'), 'utf8');
    expect(src).not.toMatch(/Restores vault access if this device or its \.env is lost/);
    expect(src).toMatch(/node launch\.js --recover-vault/);
    expect(src).toMatch(/paste this code when it asks/);
  });

  it('the launcher only mints a master key on a first run', () => {
    const src = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');
    expect(src).toMatch(/const madeVault = plan === 'mint' && ensure\('AEON_VAULT_MASTER_KEY'/);
  });
});
