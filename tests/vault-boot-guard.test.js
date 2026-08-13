/**
 * The vault must never be sealed by AEON's own first-run guard.
 *
 * Audit 2026-08-11 P0-01. The guard minted a fresh master key whenever the env
 * key was absent, without asking whether a vault already existed. On an install
 * whose .env was lost, that wrote a key which unwraps nothing and printed
 * "[FIRST RUN] Vault master key generated" — a reassuring message at the exact
 * moment access was destroyed.
 *
 * The standing rule this violated: `secrets/aeon-keyslots.json` and the .env
 * master key are two halves of one key. Move both or neither.
 *
 * The end-to-end half — that a real vault written under key K stays sealed and
 * is NOT silently re-keyed — is asserted below against the real vault module in
 * an isolated AEON_SECRETS_DIR. AEON_SECRETS_DIR is set before the require,
 * because vault.cjs resolves it at module scope.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  decideKeyGuard,
  sealedMessage,
  MINT,
  REFUSE,
  SKIP,
} from '../src/kernel/vaultBootGuard.cjs';

describe('vault boot guard decision', () => {
  it('mints on a genuine first run', () => {
    expect(decideKeyGuard({ isCloud: false, hasEnvKey: false, hasKeyslots: false })).toBe(MINT);
  });

  // The defect, as a test. Before the fix this path minted a key.
  it('REFUSES when keyslots exist but the env key is gone', () => {
    expect(decideKeyGuard({ isCloud: false, hasEnvKey: false, hasKeyslots: true })).toBe(REFUSE);
  });

  it('does nothing when the env key is present', () => {
    expect(decideKeyGuard({ isCloud: false, hasEnvKey: true, hasKeyslots: true })).toBe(SKIP);
    expect(decideKeyGuard({ isCloud: false, hasEnvKey: true, hasKeyslots: false })).toBe(SKIP);
  });

  it('does nothing on cloud, where the FS is read-only', () => {
    expect(decideKeyGuard({ isCloud: true, hasEnvKey: false, hasKeyslots: true })).toBe(SKIP);
  });

  // A refusal the operator cannot act on is only half a fix.
  it('names the cause and the way out', () => {
    const m = sealedMessage();
    expect(m).toMatch(/aeon-keyslots\.json/);
    expect(m).toMatch(/AEON_VAULT_MASTER_KEY/);
    expect(m).toMatch(/recovery code/i);
    expect(m).toMatch(/not generated/i);
  });
});

describe('an existing vault is not re-keyed by the guard', () => {
  let dir;
  let vault;
  const KEY_K = 'a'.repeat(64);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-vault-guard-'));
    // Set BEFORE the require — vault.cjs resolves SECRETS_DIR at module scope.
    process.env.AEON_SECRETS_DIR = dir;
    process.env.AEON_VAULT_MASTER_KEY = KEY_K;
    vault = require('../src/kernel/vault.cjs');
    vault.ensureKeyslots();
    vault.setSecret('BO_SHIP_PROBE', 'value-under-key-K');
  });

  it('wrote keyslots with both a file and a recovery protector', () => {
    const status = vault.getRecoveryStatus();
    expect(status.hasKeyslots).toBe(true);
    expect(status.hasRecoverySlot).toBe(true);
  });

  it('decides REFUSE for that vault once the env key is gone', () => {
    const hasKeyslots = vault.getRecoveryStatus().hasKeyslots;
    expect(decideKeyGuard({ isCloud: false, hasEnvKey: false, hasKeyslots })).toBe(REFUSE);
  });

  it('leaves the keyslot file byte-identical — no silent re-key', () => {
    const file = path.join(dir, 'aeon-keyslots.json');
    const before = fs.readFileSync(file);
    // ensureKeyslots() is idempotent and must not rewrite an existing envelope.
    vault.ensureKeyslots();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
