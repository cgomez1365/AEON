/**
 * The boot move of .env keys into the vault (services/settings.js
 * migrateEnvKeysToVault) — three defects, one function.
 *
 * C11: a .env value that DIFFERS from the vault's copy was commented out as
 *   "moved" and never imported: an operator rotating a revoked key by editing
 *   .env lost the new key from disk while the old one kept serving, and the log
 *   said "Moved". launch.js appending AEON_MOBILE_SECRET each launch fed the
 *   same path. The vault copy still runs (it always won at boot); the .env line
 *   now stays exactly as written and the log says which copy runs.
 *
 * C23: the first version's own parser stored a real key WITH its trailing
 *   comment or quotes ("gsk_live1 # main — acct", "\"sk-or-1\" # free"). The
 *   repair only removed values starting with "#". Keys the move took (their
 *   .env line carries the marker) are re-read the way dotenv reads them.
 *
 * C05: a .env value that cannot be sent is left in .env, not imported.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-migrate-'));
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
const savedKey = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_VAULT_MASTER_KEY = 'sweep-keys-migrate-master';

const settings = require('../services/settings.js');
const vault = require('../src/kernel/vault.cjs');

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedKey;
});
afterEach(() => { vi.restoreAllMocks(); });

const MARK = (k) => `# ${k} moved to the encrypted vault 2026-09-28 — manage it in Settings`;
let n = 0;
const fresh = () => {
  n++;
  const file = path.join(tmp, `provider-${n}.json`);
  return { store: settings.createProviderCredentialStore({ file }), file, envFile: path.join(tmp, `.env-${n}`) };
};
// What the first version wrote: values the validated save() now refuses, so
// the sealed file is written directly, as that version left it.
const plant = (file, secrets) => fs.writeFileSync(file, JSON.stringify(vault.seal({ version: 1, secrets }), null, 2));
const held = (store) => { const o = {}; store.hydrate(o); return o; };

describe('C11 — a .env value that differs from the vault copy', () => {
  it('is left untouched, the vault copy keeps running, and the log says so', () => {
    const { store, envFile } = fresh();
    store.save({ GROQ_API_KEY: 'gsk_old_in_vault' });
    fs.writeFileSync(envFile, 'AEON_VAULT_MASTER_KEY=x\nGROQ_API_KEY=gsk_rotated_by_hand\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = settings.migrateEnvKeysToVault(envFile, { store });

    expect(fs.readFileSync(envFile, 'utf8')).toBe('AEON_VAULT_MASTER_KEY=x\nGROQ_API_KEY=gsk_rotated_by_hand\n');
    expect(r.moved).toEqual([]);
    expect(r.differs).toEqual(['GROQ_API_KEY']);
    expect(held(store).GROQ_API_KEY).toBe('gsk_old_in_vault');
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toMatch(/GROQ_API_KEY in \.env differs from the copy in the encrypted vault — the vault copy is what runs/);
    expect(said).not.toContain('gsk_');
  });

  it('launch.js appending AEON_MOBILE_SECRET no longer grows a "moved" comment per launch', () => {
    const { store, envFile } = fresh();
    store.save({ AEON_MOBILE_SECRET: 'a'.repeat(48) });
    fs.writeFileSync(envFile, `${MARK('AEON_MOBILE_SECRET')}\nAEON_MOBILE_SECRET=${'b'.repeat(48)}\n`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) settings.migrateEnvKeysToVault(envFile, { store });
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text.match(/moved to the encrypted vault/g)).toHaveLength(1);
    expect(text).toMatch(new RegExp(`^AEON_MOBILE_SECRET=${'b'.repeat(48)}$`, 'm'));
  });

  it('a .env copy EQUAL to the vault copy is still retired as a duplicate', () => {
    const { store, envFile } = fresh();
    store.save({ BRAVE_API_KEY: 'BSA-same' });
    fs.writeFileSync(envFile, 'BRAVE_API_KEY=BSA-same\n');
    const r = settings.migrateEnvKeysToVault(envFile, { store, date: new Date('2026-09-28T12:00:00Z') });
    expect(r.moved).toEqual(['BRAVE_API_KEY']);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`${MARK('BRAVE_API_KEY')}\n`);
  });
});

describe('C23 — keys the first parser stored with their comment or quotes', () => {
  it('are re-read the way dotenv reads the line, and stored clean', () => {
    const { store, file, envFile } = fresh();
    plant(file, {
      GROQ_API_KEY: 'gsk_live1 # main — acct',
      OPENROUTER_API_KEY: '"sk-or-1" # free',
      BRAVE_API_KEY: 'BSAabc123          # search.brave.com/search/api',
      TAVILY_API_KEY: '"tvly-abc"#c',
      SERPER_API_KEY: 'serper-clean',
      // Saved in Settings, never in .env (no marker): not this repair's business.
      ANTHROPIC_API_KEY: 'sk-ant-never-in-env # note',
    });
    const env = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY'].map(MARK).join('\n') + '\n';
    fs.writeFileSync(envFile, env);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const r = settings.migrateEnvKeysToVault(envFile, { store });

    expect(r.repaired.sort()).toEqual(['BRAVE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'TAVILY_API_KEY']);
    expect(held(store)).toEqual({
      GROQ_API_KEY: 'gsk_live1',
      OPENROUTER_API_KEY: 'sk-or-1',
      BRAVE_API_KEY: 'BSAabc123',
      TAVILY_API_KEY: 'tvly-abc',
      SERPER_API_KEY: 'serper-clean',
      ANTHROPIC_API_KEY: 'sk-ant-never-in-env # note',
    });
    expect(fs.readFileSync(envFile, 'utf8')).toBe(env); // still in the vault: markers stay

    // Idempotent.
    expect(settings.migrateEnvKeysToVault(envFile, { store }).repaired).toEqual([]);
  });

  it('a key saved in Settings since (the marker stays), holding a bare "#", is left exactly as saved', () => {
    const { store, envFile } = fresh();
    store.save({ CANVA_CLIENT_SECRET: 'cnv#fixture-secret' });
    fs.writeFileSync(envFile, `${MARK('CANVA_CLIENT_SECRET')}\n`);
    const r = settings.migrateEnvKeysToVault(envFile, { store });
    expect(r.repaired).toEqual([]);
    expect(r.healed).toEqual([]);
    expect(held(store).CANVA_CLIENT_SECRET).toBe('cnv#fixture-secret');
  });

  // Review follow-up: "KEY=gsk_abc#main" — no space before the '#'. dotenv
  // reads gsk_abc; the first parser stored the lot, and nothing re-read it.
  it('a provider key with a comment glued on by "#" is re-read too', () => {
    const { store, file, envFile } = fresh();
    plant(file, { GROQ_API_KEY: 'gsk_live2#main', OPENROUTER_API_KEY: 'sk-or-v1-abc#free' });
    fs.writeFileSync(envFile, `${MARK('GROQ_API_KEY')}\n${MARK('OPENROUTER_API_KEY')}\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = settings.migrateEnvKeysToVault(envFile, { store });
    expect(r.repaired.sort()).toEqual(['GROQ_API_KEY', 'OPENROUTER_API_KEY']);
    expect(held(store)).toEqual({ GROQ_API_KEY: 'gsk_live2', OPENROUTER_API_KEY: 'sk-or-v1-abc' });
  });

  it('one that reads as empty is a placeholder: removed, and its line restored', () => {
    const { store, file, envFile } = fresh();
    plant(file, { GROQ_API_KEY: "'' # paste yours here" });
    fs.writeFileSync(envFile, `${MARK('GROQ_API_KEY')}\n`);
    const r = settings.migrateEnvKeysToVault(envFile, { store });
    expect(r.healed).toEqual(['GROQ_API_KEY']);
    expect(held(store).GROQ_API_KEY).toBeUndefined();
    expect(fs.readFileSync(envFile, 'utf8')).toBe("GROQ_API_KEY=   '' # paste yours here\n");
  });
});

describe('C05 — a .env value that cannot be sent', () => {
  it('stays in .env where it can be seen, and is not imported', () => {
    const { store, envFile } = fresh();
    fs.writeFileSync(envFile, 'GROQ_API_KEY=gsk_abc​\nOPENAI_API_KEY=sk-fine\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = settings.migrateEnvKeysToVault(envFile, { store });
    expect(r.moved).toEqual(['OPENAI_API_KEY']);
    expect(held(store)).toEqual({ OPENAI_API_KEY: 'sk-fine' });
    expect(fs.readFileSync(envFile, 'utf8')).toMatch(/^GROQ_API_KEY=gsk_abc​$/m);
    expect(warn.mock.calls.join(' ')).toMatch(/GROQ_API_KEY in \.env is not a usable key/);
  });
});
