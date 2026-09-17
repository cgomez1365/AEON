/**
 * Key rotation, on the path a chat turn actually takes.
 *
 * CEO, 2026-09-17: rotation is the feature Hope's CEO singled out — "make a
 * handful of free accounts, hand AEON every key, and it keeps working." The
 * code for it existed and had never once run for a registry-resolved turn:
 *
 *   - endpoints.cjs resolved exactly ONE credential (`ep.auth_ref`) for all
 *     ten roles, and services/ai.js consumed that single key.
 *   - the rotation that did exist read process.env and was Gemini-shaped, so
 *     no other provider had one and no registry turn entered it.
 *   - pacing.cjs keyed the requests-per-minute budget by HOST, so three keys
 *     on one provider shared one key's budget — rotating bought nothing.
 *   - services/settings.js allow-listed exact names, admitting three Gemini
 *     keys and exactly one of everything else, so the UI could not store a
 *     second key for any other provider.
 *
 * These drive the real modules. Each test states which of those four it fails
 * on if the fix is undone.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Set BEFORE the requires — both modules resolve their paths at module scope,
// and a test must never read or write the operator's own install.
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-key-rotation-'));
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'test-master-key-for-rotation-suite';

const keyPool = require('../src/kernel/keyPool.cjs');
const endpoints = require('../src/kernel/endpoints.cjs');
const vault = require('../src/kernel/vault.cjs');
const { paceKey } = require('../src/kernel/pacing.cjs');
const { isProviderSecretKey } = require('../services/settings.js');

const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');
const writeRegistry = (eps, roles = {}) =>
  fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: eps, roles }, null, 2));

beforeEach(() => { keyPool._reset(); });
afterEach(() => { try { fs.rmSync(REG_FILE, { force: true }); } catch {} });
afterAll(() => { try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {} });

// ── 1. the pool itself ────────────────────────────────────────────────
describe('the credential pool spreads calls and rests what fails', () => {
  const refs = ['acct-a', 'acct-b', 'acct-c'];

  it('round-robins, so three accounts carry three accounts of traffic', () => {
    // Sticky-until-429 would answer a,a,a,a here and leave two keys idle.
    const taken = [0, 1, 2, 3, 4, 5].map(() => keyPool.acquire('ep1', refs).ref);
    expect(taken).toEqual(['acct-a', 'acct-b', 'acct-c', 'acct-a', 'acct-b', 'acct-c']);
  });

  it('a rate-limited account sits out and the others keep serving', () => {
    keyPool.penalize('ep1', 'acct-b', { status: 429 });
    const taken = [0, 1, 2, 3].map(() => keyPool.acquire('ep1', refs).ref);
    expect(taken).not.toContain('acct-b');
    expect(new Set(taken)).toEqual(new Set(['acct-a', 'acct-c']));
    expect(keyPool.snapshot('ep1', refs).available).toBe(2);
  });

  it('honours the provider\'s own Retry-After rather than guessing', () => {
    const rec = keyPool.penalize('ep1', 'acct-a', { status: 429, retryAfterMs: 5000 });
    expect(rec.until - Date.now()).toBeGreaterThan(3500);
    expect(rec.until - Date.now()).toBeLessThanOrEqual(5000);
  });

  it('a 500 or a timeout does NOT bench a good key — that is the provider, not the account', () => {
    expect(keyPool.penalize('ep1', 'acct-a', { status: 500 })).toBeNull();
    expect(keyPool.penalize('ep1', 'acct-a', {})).toBeNull();
    expect(keyPool.snapshot('ep1', refs).available).toBe(3);
  });

  it('when every account is resting it still returns one, flagged, rather than inventing an error', () => {
    for (const r of refs) keyPool.penalize('ep1', r, { status: 429 });
    const pick = keyPool.acquire('ep1', refs);
    expect(pick).not.toBeNull();
    expect(pick.healthy).toBe(false);
    expect(pick.retryInMs).toBeGreaterThan(0);
  });

  it('a cooldown that has expired makes the account ordinary again', () => {
    keyPool.penalize('ep1', 'acct-a', { status: 429, retryAfterMs: 1 });
    return new Promise((done) => setTimeout(() => {
      expect(keyPool.snapshot('ep1', refs).available).toBe(3);
      done();
    }, 15));
  });

  it('never reports key material — a snapshot carries refs and state only', () => {
    keyPool.penalize('ep1', 'acct-a', { status: 402, message: 'sk-live-THIS-IS-A-KEY out of credit' });
    const snap = JSON.stringify(keyPool.snapshot('ep1', refs));
    expect(snap).toContain('acct-a');
    // The reason is the provider's sentence, which is quoted, not a secret we
    // hold — but the snapshot must never be built FROM a key.
    expect(snap).not.toMatch(/"key"\s*:/);
  });
});

// ── 2. the resolver hands a different account to each turn ────────────
describe('resolveForRole rotates across an endpoint\'s accounts', () => {
  it('three turns use three different keys', async () => {
    await vault.setSecret('groq-k1', 'KEY-ONE');
    await vault.setSecret('groq-k2', 'KEY-TWO');
    await vault.setSecret('groq-k3', 'KEY-THREE');
    writeRegistry(
      [{
        id: 'groq-pool', provider: 'groq', base_url: 'https://api.groq.com/openai/v1',
        auth_ref: 'groq-k1', auth_refs: ['groq-k1', 'groq-k2', 'groq-k3'],
        models: ['llama-3.3-70b-versatile'], reachable_from: ['local'],
      }],
      { chat: { endpoint_id: 'groq-pool', model: 'llama-3.3-70b-versatile' } },
    );

    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await endpoints.resolveForRole('chat');
      expect(r.ok).toBe(true);
      seen.push(r.apiKey);
      expect(r.credential_count).toBe(3);
      expect(r.credential_ref).toBeTruthy();
    }
    // Before the fix this was ['KEY-ONE','KEY-ONE','KEY-ONE'].
    expect(new Set(seen)).toEqual(new Set(['KEY-ONE', 'KEY-TWO', 'KEY-THREE']));
  });

  it('a registry written before pools existed still resolves its single key', async () => {
    await vault.setSecret('legacy-ref', 'OLD-KEY');
    writeRegistry(
      [{ id: 'legacy', provider: 'groq', base_url: 'https://api.groq.com/openai/v1', auth_ref: 'legacy-ref', models: ['m'], reachable_from: ['local'] }],
      { chat: { endpoint_id: 'legacy', model: 'm' } },
    );
    const r = await endpoints.resolveForRole('chat');
    expect(r.apiKey).toBe('OLD-KEY');
    expect(r.credential_count).toBe(1);
  });

  it('rotateCredential benches the refused key and returns a different one', async () => {
    await vault.setSecret('g1', 'KEY-ONE');
    await vault.setSecret('g2', 'KEY-TWO');
    writeRegistry([{
      id: 'gem', provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta',
      auth_ref: 'g1', auth_refs: ['g1', 'g2'], models: ['gemini-2.5-flash'], reachable_from: ['local'],
    }], { chat: { endpoint_id: 'gem', model: 'gemini-2.5-flash' } });

    const first = await endpoints.resolveForRole('chat');
    const next = await endpoints.rotateCredential('gem', first.credential_ref, { status: 429 });
    expect(next).not.toBeNull();
    expect(next.credential_ref).not.toBe(first.credential_ref);
    expect(next.apiKey).not.toBe(first.apiKey);
    expect(keyPool.snapshot('gem', ['g1', 'g2']).available).toBe(1);
  });

  it('with only one account there is nothing to rotate to, and it says so', async () => {
    await vault.setSecret('solo', 'ONLY-KEY');
    writeRegistry([{ id: 'one', provider: 'groq', base_url: 'https://api.groq.com/openai/v1', auth_ref: 'solo', auth_refs: ['solo'], models: ['m'], reachable_from: ['local'] }]);
    expect(await endpoints.rotateCredential('one', 'solo', { status: 429 })).toBeNull();
  });
});

// ── 3. adding and removing accounts ──────────────────────────────────
describe('a connection holds a pool the operator can edit', () => {
  it('addEndpoint keeps the keys already on a connection when only the label changes', async () => {
    writeRegistry([{
      id: 'or', provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1',
      auth_ref: 'or-1', auth_refs: ['or-1', 'or-2'], models: ['x'], reachable_from: ['local', 'cloud'],
    }]);
    // The Add-connection form re-saves with a single auth_ref. Before the
    // merge, this silently dropped the operator's second account.
    const ep = await endpoints.addEndpoint({ id: 'or', provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', label: 'Renamed', auth_ref: 'or-1', models: ['x'] });
    expect(ep.auth_refs).toEqual(['or-1', 'or-2']);
  });

  it('saving a new key on an existing connection ADDS it to the pool', async () => {
    writeRegistry([{ id: 'or', provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', auth_ref: 'or-1', auth_refs: ['or-1'], models: ['x'], reachable_from: ['local', 'cloud'] }]);
    const ep = await endpoints.addEndpoint({ id: 'or', provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', auth_ref: 'or-2', models: ['x'] });
    expect(ep.auth_refs).toEqual(['or-1', 'or-2']);
    expect(ep.auth_ref).toBe('or-1');
  });

  it('removing the last key is refused — a keyless connection just fails later', async () => {
    writeRegistry([{ id: 'solo', provider: 'groq', base_url: 'https://api.groq.com/openai/v1', auth_ref: 'k1', auth_refs: ['k1'], models: ['m'], reachable_from: ['local'] }]);
    await expect(endpoints.removeCredential('solo', 'k1')).rejects.toThrow(/only key/i);
  });

  it('removing one of several leaves the rest, and auth_ref follows', async () => {
    writeRegistry([{ id: 'p', provider: 'groq', base_url: 'https://api.groq.com/openai/v1', auth_ref: 'k1', auth_refs: ['k1', 'k2'], models: ['m'], reachable_from: ['local'] }]);
    const ep = await endpoints.removeCredential('p', 'k1');
    expect(ep.auth_refs).toEqual(['k2']);
    expect(ep.auth_ref).toBe('k2');
  });

  it('a pooled endpoint counts as configured', () => {
    writeRegistry([{ id: 'p', provider: 'groq', auth_refs: ['k1', 'k2'], reachable_from: ['local'], models: [] }]);
    expect(endpoints.isProviderConfigured('groq')).toBe(true);
  });
});

// ── 4. the two things that made rotation pointless ───────────────────
describe('a rotated key gets its own rate budget', () => {
  it('two accounts on one host are two buckets, not one', () => {
    const url = 'https://generativelanguage.googleapis.com/v1beta';
    expect(paceKey(url, 'gemini', 'acct-1')).not.toBe(paceKey(url, 'gemini', 'acct-2'));
  });

  it('an endpoint with no credential paces exactly as it always did', () => {
    const url = 'https://api.groq.com/openai/v1';
    expect(paceKey(url, 'groq')).toBe('https://api.groq.com');
  });
});

describe('the credential allow-list admits a pool, for every provider', () => {
  it('a second key is storable for providers that previously allowed only one', () => {
    for (const name of ['GROQ_API_KEY_2', 'OPENROUTER_API_KEY_2', 'ANTHROPIC_API_KEY_3', 'OPENAI_API_KEY_5']) {
      expect(isProviderSecretKey(name)).toBe(true);
    }
  });

  it('Gemini is no longer capped at three', () => {
    expect(isProviderSecretKey('GEMINI_FREE_KEY_4')).toBe(true);
    expect(isProviderSecretKey('GEMINI_FREE_KEY_17')).toBe(true);
  });

  it('it is still an allow-list — an unlisted name, or a non-numeric suffix, is refused', () => {
    for (const name of ['EVIL_KEY', 'GROQ_API_KEY_X', 'GROQ_API_KEY_', 'GROQ_API_KEY_0', 'PATH', 'AWS_SECRET_ACCESS_KEY']) {
      expect(isProviderSecretKey(name)).toBe(false);
    }
  });
});
