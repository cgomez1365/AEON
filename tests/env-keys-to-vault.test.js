/**
 * One home for keys (CEO, 2026-09-28: "if env can be merged seamlessly into
 * settings and kernel go for it"). Provider and search keys found in .env
 * move into the encrypted vault Settings manages; bootstrap values stay.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-env-move-'));
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
const savedKey = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_VAULT_MASTER_KEY = 'env-move-suite-key';

const settings = require('../services/settings.js');
const vault = require('../src/kernel/vault.cjs');

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedKey;
});

const ENV = [
  'AEON_VAULT_MASTER_KEY=keep-this-half',
  'GROQ_API_KEY=gsk_live_one',
  'export TAVILY_API_KEY="tvly-two"',
  'AEON_RATE_MAX=300',
  'NOT_A_KEY_API_KEY=stays',
  '',
].join('\n');

describe('migrateEnvKeysToVault', () => {
  const envFile = path.join(tmp, '.env');
  const store = settings.createProviderCredentialStore({ file: path.join(tmp, 'provider_credentials.json') });

  it('moves provider/search keys into the vault and comments them out; bootstrap stays', () => {
    fs.writeFileSync(envFile, ENV);
    const r = settings.migrateEnvKeysToVault(envFile, { store, date: new Date('2026-09-28T12:00:00Z') });
    expect(r.moved.sort()).toEqual(['GROQ_API_KEY', 'TAVILY_API_KEY']);
    const out = fs.readFileSync(envFile, 'utf8');
    expect(out).toMatch(/^AEON_VAULT_MASTER_KEY=keep-this-half$/m);
    expect(out).toMatch(/^AEON_RATE_MAX=300$/m);
    expect(out).toMatch(/^NOT_A_KEY_API_KEY=stays$/m);
    expect(out).toMatch(/^# GROQ_API_KEY moved to the encrypted vault 2026-09-28/m);
    expect(out).not.toMatch(/gsk_live_one|tvly-two/);
    const env = {};
    store.hydrate(env);
    expect(env).toMatchObject({ GROQ_API_KEY: 'gsk_live_one', TAVILY_API_KEY: 'tvly-two' });
  });

  it('a second run changes nothing', () => {
    const before = fs.readFileSync(envFile, 'utf8');
    expect(settings.migrateEnvKeysToVault(envFile, { store }).moved).toEqual([]);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
  });

  // The vault copy still runs (it always won at boot), but a .env value that
  // differs is not erased: it may be the operator's hand-rotated key, and
  // commenting it out as "moved" lost it from disk (sweep C11).
  it('a key the vault already holds is not overwritten by the .env copy, and the differing line is left as written', () => {
    fs.writeFileSync(envFile, 'GROQ_API_KEY=stale-env-copy\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = settings.migrateEnvKeysToVault(envFile, { store });
      expect(r.differs).toEqual(['GROQ_API_KEY']);
    } finally { warn.mockRestore(); }
    const env = {};
    store.hydrate(env);
    expect(env.GROQ_API_KEY).toBe('gsk_live_one');
    expect(fs.readFileSync(envFile, 'utf8')).toBe('GROQ_API_KEY=stale-env-copy\n');
  });

  it('a locked vault leaves .env exactly as it is', () => {
    fs.writeFileSync(envFile, 'OPENROUTER_API_KEY=or-three\n');
    delete process.env.AEON_VAULT_MASTER_KEY;
    vault.__resetForTest();
    try {
      expect(settings.migrateEnvKeysToVault(envFile, { store }).skipped).toBe('vault-locked');
      expect(fs.readFileSync(envFile, 'utf8')).toBe('OPENROUTER_API_KEY=or-three\n');
    } finally { process.env.AEON_VAULT_MASTER_KEY = 'env-move-suite-key'; vault.__resetForTest(); }
  });
});

describe('placeholder lines and the repair (2026-09-28)', () => {
  const envFile = path.join(tmp, '.env-heal');
  const store = settings.createProviderCredentialStore({ file: path.join(tmp, 'provider-heal.json') });

  it('a placeholder with only an inline comment is empty, as dotenv reads it — not moved', () => {
    fs.writeFileSync(envFile, 'SERPER_API_KEY=   # optional — get one at serper.dev\n');
    expect(settings.migrateEnvKeysToVault(envFile, { store }).moved).toEqual([]);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('SERPER_API_KEY=   # optional — get one at serper.dev\n');
  });

  it('a real key followed by an inline comment moves without the comment', () => {
    fs.writeFileSync(envFile, 'BRAVE_API_KEY=BSA-real-key   # privacy-first\n');
    settings.migrateEnvKeysToVault(envFile, { store });
    const env = {};
    store.hydrate(env);
    expect(env.BRAVE_API_KEY).toBe('BSA-real-key');
  });

  it('a comment the first version stored as a key is removed and its line restored', () => {
    // save() now refuses a value with spaces (sweep C05), so the sealed file is
    // written as the first version left it, keeping what the store holds.
    const held = {};
    store.hydrate(held);
    fs.writeFileSync(path.join(tmp, 'provider-heal.json'), JSON.stringify(
      vault.seal({ version: 1, secrets: { ...held, TAVILY_API_KEY: '# optional — AI-native search' } }), null, 2));
    fs.writeFileSync(envFile, '# TAVILY_API_KEY moved to the encrypted vault 2026-09-28 — manage it in Settings\n');
    const r = settings.migrateEnvKeysToVault(envFile, { store });
    expect(r.healed).toEqual(['TAVILY_API_KEY']);
    const env = {};
    store.hydrate(env);
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.BRAVE_API_KEY).toBe('BSA-real-key'); // real keys untouched
    expect(fs.readFileSync(envFile, 'utf8')).toBe('TAVILY_API_KEY=   # optional — AI-native search\n');
  });
});
