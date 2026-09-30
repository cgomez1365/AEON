/**
 * C22 — launch.js sees AEON_MOBILE_SECRET once the server moved it into the
 * vault.
 *
 * The boot move leaves "# AEON_MOBILE_SECRET moved to the encrypted vault …"
 * in .env. The launcher's ensure() and rotateCompromised() read only `KEY=`
 * lines, so from then on every launch appended a fresh secret the server could
 * not use (the vault copy wins at boot), and a known-exposed value sitting in
 * the vault was never rotated again (BO-A3b). The launcher now asks the vault:
 * it rotates an exposed copy there, and adds no second copy to .env.
 */
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-launch-'));
const ENV_NAMES = ['AEON_HOME', 'AEON_SECRETS_DIR', 'AEON_ENV_FILE', 'VAULT_PATH', 'AEON_VAULT_MASTER_KEY'];
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
process.env.VAULT_PATH = path.join(tmp, 'Vault');
delete process.env.AEON_VAULT_MASTER_KEY;
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const LAUNCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'launch.js');
const launcher = require(LAUNCH);
const settings = require('../services/settings.js');

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const MASTER = 'sweep-keys-launch-master';
const EXPOSED = 'e'.repeat(48);
const REPLACEMENT = 'f'.repeat(48);
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const listFile = path.join(tmp, 'compromised-credentials.json');
fs.writeFileSync(listFile, JSON.stringify({ credentials: [
  { key: 'AEON_MOBILE_SECRET', sha256: sha(EXPOSED) },
  { key: 'GROQ_API_KEY', sha256: sha('gsk_exposed_fixture') },
] }));
const MOVED = '# AEON_MOBILE_SECRET moved to the encrypted vault 2026-09-29 — manage it in Settings';
const withMaster = (fn) => {
  process.env.AEON_VAULT_MASTER_KEY = MASTER;
  try { return fn(); } finally { delete process.env.AEON_VAULT_MASTER_KEY; }
};
const heldNow = () => withMaster(() => { const o = {}; settings.createProviderCredentialStore().hydrate(o); return o; });

describe('the launcher reads the provider vault', () => {
  it('rotates a known-exposed AEON_MOBILE_SECRET held there, and names an exposed key it cannot mint', () => {
    withMaster(() => settings.createProviderCredentialStore().save({ AEON_MOBILE_SECRET: EXPOSED, GROQ_API_KEY: 'gsk_exposed_fixture' }));

    const generate = (key) => (key === 'AEON_MOBILE_SECRET' ? REPLACEMENT : null);
    const r = launcher.checkProviderVault({ envText: `AEON_VAULT_MASTER_KEY=${MASTER}\n${MOVED}\n`, listFile, generate });

    expect(r.rotated).toEqual(['AEON_MOBILE_SECRET']);
    expect(r.exposed.sort()).toEqual(['AEON_MOBILE_SECRET', 'GROQ_API_KEY']);
    expect(r.holds('AEON_MOBILE_SECRET')).toBe(true);
    // The master key was lent for the call only — the launcher never loads .env.
    expect(process.env.AEON_VAULT_MASTER_KEY).toBeUndefined();
    expect(heldNow()).toEqual({ AEON_MOBILE_SECRET: REPLACEMENT, GROQ_API_KEY: 'gsk_exposed_fixture' });

    // Nothing left to rotate on the next launch.
    const again = launcher.checkProviderVault({ envText: `AEON_VAULT_MASTER_KEY=${MASTER}\n`, listFile, generate });
    expect(again).toMatchObject({ rotated: [], exposed: ['GROQ_API_KEY'] });
    expect(heldNow().AEON_MOBILE_SECRET).toBe(REPLACEMENT);
  });

  it('is null when the vault cannot be read here, and the launcher then behaves as before', () => {
    expect(launcher.checkProviderVault({ envText: 'PORT=3001\n', listFile, generate: () => 'x' })).toBeNull();
    expect(launcher.checkProviderVault({ envText: 'AEON_VAULT_MASTER_KEY=not-this-vaults-key\n', listFile, generate: () => 'x' })).toBeNull();
  });
});

describe('ensure() for a key the vault holds', () => {
  const env = `AEON_VAULT_MASTER_KEY=${MASTER}\n${MOVED}\n`;

  it('adds no second, dead copy to .env', () => {
    expect(launcher.ensureEnvKey(env, 'AEON_MOBILE_SECRET', () => REPLACEMENT, { heldInVault: true }))
      .toEqual({ env, added: false });
  });

  it('still fills a key that is nowhere, and leaves a present one alone', () => {
    const r = launcher.ensureEnvKey(env, 'AEON_MOBILE_SECRET', () => REPLACEMENT);
    expect(r.added).toBe(true);
    expect(r.env).toBe(`${env}\nAEON_MOBILE_SECRET=${REPLACEMENT}`);
    const present = 'AEON_MOBILE_SECRET=abc\n';
    expect(launcher.ensureEnvKey(present, 'AEON_MOBILE_SECRET', () => REPLACEMENT)).toEqual({ env: present, added: false });
  });

  it('main() asks the vault before it fills AEON_MOBILE_SECRET', () => {
    const src = fs.readFileSync(LAUNCH, 'utf8');
    const asked = src.indexOf('const inVault = checkProviderVault({');
    const filled = src.indexOf("ensure('AEON_MOBILE_SECRET', newMobile, { heldInVault:");
    expect(asked).toBeGreaterThan(-1);
    expect(filled).toBeGreaterThan(asked);
  });
});
