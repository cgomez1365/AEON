import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);

// Isolate the vault file to a temp dir so tests never touch the real secrets/.
//
// AEON_SECRETS_DIR must be set BEFORE vault.cjs is required: it resolves
// SECRETS_DIR once at module scope. Previously this temp dir was created and
// deleted but never actually wired up, so the suite read and wrote the real
// secrets/ directory and only passed because that directory happened to be
// empty. Booting the server once — which generates a keyslot store under the
// .env key — made every test here fail with a decryption error.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-vault-test-'));
process.env.AEON_SECRETS_DIR = TMP;

describe('vault.cjs — AES-256-GCM secret store', () => {
  let vault;

  beforeAll(() => {
    process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-deterministic';
    delete process.env.VERCEL;
    vault = require('../src/kernel/vault.cjs');
  });

  afterAll(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('reports unlocked when a master key is present', () => {
    expect(vault.isUnlocked()).toBe(true);
  });

  it('round-trips a secret through encrypt → decrypt', async () => {
    await vault.setSecret('groq-test', 'gsk_secret_value', null);
    const got = await vault.getSecret('groq-test', null);
    expect(got).toBe('gsk_secret_value');
  });

  it('lists ref ids but never values', async () => {
    const refs = await vault.listRefs(null);
    expect(refs).toContain('groq-test');
    // listRefs returns keys only — assert no value leaked into the array
    expect(refs.every((r) => typeof r === 'string' && !r.includes('gsk_'))).toBe(true);
  });

  it('removes a secret', async () => {
    await vault.removeSecret('groq-test', null);
    const got = await vault.getSecret('groq-test', null);
    expect(got).toBeNull();
  });
});

describe('vault.cjs — locked state', () => {
  it('reports locked when no master key', () => {
    // Re-require in a child by clearing the cache + env
    const saved = process.env.AEON_VAULT_MASTER_KEY;
    delete process.env.AEON_VAULT_MASTER_KEY;
    delete require.cache[require.resolve('../src/kernel/vault.cjs')];
    const v = require('../src/kernel/vault.cjs');
    expect(v.isUnlocked()).toBe(false);
    process.env.AEON_VAULT_MASTER_KEY = saved;
    delete require.cache[require.resolve('../src/kernel/vault.cjs')];
  });
});
