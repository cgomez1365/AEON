/**
 * Unreadable is not empty (kernel audit, 2026-09-28). Each of these stores
 * read a damaged file as "nothing here", and the next write replaced it:
 *
 *   - aeon-keyslots.json → ensureKeyslots() minted a new file over it,
 *     destroying the wrapped key and the recovery slot: every secret, gone.
 *   - aeon-vault.json (unparseable, or undecryptable) → the next setSecret
 *     wrote a vault holding only that one key.
 *   - aeon-endpoints.json → defaultRegistry(), and the next save wiped every
 *     connection and key ref.
 *
 * And hydration loaded only the first key of each connection's pool.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-no-wipe-'));
const savedDir = process.env.AEON_SECRETS_DIR;
const savedKey = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tmp;
process.env.AEON_VAULT_MASTER_KEY = 'no-silent-wipe-suite-key';
process.env.AEON_ENV_FILE = path.join(tmp, '.env');

const VAULT = path.join('..', 'src', 'kernel', 'vault.cjs');
const ENDPOINTS = path.join('..', 'src', 'kernel', 'endpoints.cjs');
for (const m of [VAULT, ENDPOINTS]) delete require.cache[require.resolve(m)];
const vault = require(VAULT);
const endpoints = require(ENDPOINTS);

const KEYSLOTS = path.join(tmp, 'aeon-keyslots.json');
const BLOB = path.join(tmp, 'aeon-vault.json');
const REG = path.join(tmp, 'aeon-endpoints.json');

beforeEach(() => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  vault.__resetForTest();
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedDir;
  if (savedKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedKey;
  delete process.env.AEON_ENV_FILE;
});

describe('a damaged keyslot file', () => {
  it('locks the vault and is never written over', () => {
    fs.writeFileSync(KEYSLOTS, '{"v":1,"slots":{"file":{"iv":"ab"'); // truncated
    const before = fs.readFileSync(KEYSLOTS, 'utf8');
    expect(vault.ensureKeyslots()).toMatchObject({ created: false, reason: 'corrupt' });
    expect(vault.isUnlocked()).toBe(false);
    expect(fs.readFileSync(KEYSLOTS, 'utf8')).toBe(before);
  });
});

describe('a damaged secrets file', () => {
  it('unparseable: setSecret refuses and the file is untouched', async () => {
    await vault.setSecret('a', 'one');
    fs.writeFileSync(BLOB, '{"v":1,"iv":"'); // truncated
    const before = fs.readFileSync(BLOB, 'utf8');
    await expect(vault.setSecret('b', 'two')).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(BLOB, 'utf8')).toBe(before);
  });

  it('undecryptable: setSecret refuses instead of replacing every key', async () => {
    await vault.setSecret('a', 'one');
    const blob = JSON.parse(fs.readFileSync(BLOB, 'utf8'));
    blob.tag = '00'.repeat(16);
    fs.writeFileSync(BLOB, JSON.stringify(blob));
    const before = fs.readFileSync(BLOB, 'utf8');
    await expect(vault.setSecret('b', 'two')).rejects.toThrow(/could not be decrypted/);
    expect(fs.readFileSync(BLOB, 'utf8')).toBe(before);
  });
});

describe('a damaged connections file', () => {
  it('a mutation refuses, the file is untouched, and readers see nothing configured', async () => {
    fs.writeFileSync(REG, '{"endpoints":[{"id":"x"'); // truncated
    const before = fs.readFileSync(REG, 'utf8');
    await expect(endpoints.assignRole('chat', 'x', 'm', null, null)).rejects.toThrow(/unreadable/);
    expect(fs.readFileSync(REG, 'utf8')).toBe(before);
    expect(endpoints.isProviderConfigured('groq')).toBe(false);
  });
});
