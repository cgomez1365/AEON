import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// Point the vault at an isolated secrets dir BEFORE loading it, so keyslot writes
// never touch the real secrets/. (createRequire runs after this assignment.)
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-vault-slots-'));
process.env.AEON_SECRETS_DIR = SECRETS;
// recoverWithCode() reissues the .env half of the "file" protector. Without
// redirecting it too, these tests rewrite AEON_VAULT_MASTER_KEY in the real
// install's .env — silently rotating the developer's live vault key on every
// `npm test`, orphaning any secret sealed under the previous one.
process.env.AEON_ENV_FILE = path.join(SECRETS, '.env');
delete process.env.VERCEL;
const vault = require('../src/kernel/vault.cjs');

const KEYSLOTS = path.join(SECRETS, 'aeon-keyslots.json');

describe('vault envelope keyslots (decision gate — installable anywhere)', () => {
  beforeEach(() => {
    process.env.AEON_VAULT_MASTER_KEY = 'base-env-key';
    vault.__resetForTest();
    for (const f of [KEYSLOTS, KEYSLOTS + '.tmp']) { try { fs.rmSync(f); } catch {} }
  });

  afterEach(() => { vault.__resetForTest(); });
  afterAll(() => {
    delete process.env.AEON_SECRETS_DIR;
    delete process.env.AEON_ENV_FILE;
    try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch {}
  });

  it('is backward compatible: seal/unseal work and write NO keyslots on their own', () => {
    const blob = vault.seal({ hello: 'world' });
    expect(vault.unseal(blob)).toEqual({ hello: 'world' });
    expect(fs.existsSync(KEYSLOTS)).toBe(false); // only ensureKeyslots() writes
  });

  it('wrap/unwrap round-trips the DEK and rejects a wrong KEK', () => {
    const crypto = require('crypto');
    const dek = crypto.randomBytes(32);
    const kek = crypto.randomBytes(32);
    const slot = vault.wrapDEK(dek, kek);
    expect(vault.unwrapDEK(slot, kek).equals(dek)).toBe(true);
    expect(() => vault.unwrapDEK(slot, crypto.randomBytes(32))).toThrow();
  });

  it('ensureKeyslots creates file + recovery slots, reveals a one-time code, and keeps data readable', () => {
    const before = vault.seal({ secret: 42 }); // encrypted under the current DEK
    const res = vault.ensureKeyslots();
    expect(res.created).toBe(true);

    const status = vault.getRecoveryStatus();
    expect(status.hasKeyslots).toBe(true);
    expect(status.protectors).toEqual(expect.arrayContaining(['file', 'recovery']));

    const code = vault.consumePendingRecoveryCode();
    expect(code).toMatch(/^AEON-/);
    expect(vault.consumePendingRecoveryCode()).toBeNull(); // shown exactly once

    // DEK is unchanged → data sealed before the envelope still decrypts.
    expect(vault.unseal(before)).toEqual({ secret: 42 });

    // The plaintext recovery code is never persisted in the keyslots file.
    expect(fs.readFileSync(KEYSLOTS, 'utf8')).not.toContain(code);
    expect(fs.readFileSync(KEYSLOTS, 'utf8')).not.toContain(code.replace(/-/g, ''));
  });

  it('recovers with the code when the .env key is lost, reissues it, and preserves all data', () => {
    const sealed = vault.seal({ apiKey: 'gsk_live' });
    vault.ensureKeyslots();
    const code = vault.consumePendingRecoveryCode();

    // Simulate a lost/rotated .env: a wrong env key cannot unwrap the file slot.
    process.env.AEON_VAULT_MASTER_KEY = 'the-wrong-key';
    vault.__resetForTest();
    expect(vault.isUnlocked()).toBe(false);

    const rec = vault.recoverWithCode(code);
    expect(rec.ok).toBe(true);
    expect(vault.isUnlocked()).toBe(true);

    // The env key was reissued to a fresh value…
    expect(process.env.AEON_VAULT_MASTER_KEY).not.toBe('the-wrong-key');
    expect(process.env.AEON_VAULT_MASTER_KEY).not.toBe('base-env-key');
    // …and the data sealed before recovery is still readable (DEK preserved).
    expect(vault.unseal(sealed)).toEqual({ apiKey: 'gsk_live' });
  });

  it('rejects a wrong recovery code without altering the keyslots or env key', () => {
    vault.ensureKeyslots();
    vault.consumePendingRecoveryCode();
    const before = fs.readFileSync(KEYSLOTS);
    const envBefore = process.env.AEON_VAULT_MASTER_KEY;

    const rec = vault.recoverWithCode('AEON-0000-0000-0000-0000');
    expect(rec.ok).toBe(false);
    expect(rec.error).toBe('invalid-code');
    expect(fs.readFileSync(KEYSLOTS).equals(before)).toBe(true);
    expect(process.env.AEON_VAULT_MASTER_KEY).toBe(envBefore);
  });

  it('ensureKeyslots is idempotent — a second call does not overwrite existing slots', () => {
    vault.ensureKeyslots();
    const first = fs.readFileSync(KEYSLOTS);
    const second = vault.ensureKeyslots();
    expect(second.created).toBe(false);
    expect(second.reason).toBe('exists');
    expect(fs.readFileSync(KEYSLOTS).equals(first)).toBe(true);
  });
});
