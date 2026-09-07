/**
 * BO-EMB — `embed` is a role, and it never borrows the chat model.
 *
 * Before this build order the Aeon Matrix embedded by calling one vendor's API
 * by name, with its own key pool read straight from process.env. The fix moves
 * the decision to the kernel — but the kernel's own resolver had a fall-through
 * that made the fix dangerous:
 *
 *     let mapping = reg.roles[role] || reg.roles['chat'];
 *
 * Every other role degrades sensibly to chat. Embedding does not. A chat model
 * asked to embed returns no vector, or a vector in a space nothing else can be
 * compared against — which surfaces as an empty search reported as success.
 * That is the silent-wrong-answer class §08 exists to forbid, so it is asserted
 * here rather than trusted.
 *
 * These drive the REAL kernel predicates against a REAL registry file.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Set BEFORE the require — endpoints.cjs resolves its registry path at module
// scope. (Test isolation rule: never touch the live install.)
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-role-'));
process.env.AEON_SECRETS_DIR = tempSecrets;

const endpoints = require('../src/kernel/endpoints.cjs');
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const writeRegistry = (reg) => fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));

afterAll(() => { try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {} });
afterEach(() => { try { fs.rmSync(REG_FILE, { force: true }); } catch {} });

const CHAT_ENDPOINT = {
  id: 'ep-chat',
  provider: 'groq',
  base_url: 'https://api.groq.com/openai/v1',
  auth_ref: 'vault:groq',
  reachable_from: ['local'],
  models: ['llama-3.3-70b-versatile', 'whisper-large-v3'],
};

const EMBED_ENDPOINT = {
  id: 'ep-embed',
  provider: 'custom',
  base_url: 'https://embeddings.example.test/v1',
  auth_ref: 'vault:custom',
  reachable_from: ['local'],
  models: ['text-embedding-3-small', 'gpt-4o-mini'],
};

describe('embed never falls through to the chat mapping', () => {
  it('does NOT resolve to the chat model when only chat is assigned', async () => {
    writeRegistry({
      endpoints: [CHAT_ENDPOINT],
      roles: { chat: { endpoint_id: 'ep-chat', model: 'llama-3.3-70b-versatile' } },
    });

    const r = await endpoints.resolveForRole('embed');

    // The defect this test exists to prevent: a chat model silently serving
    // the embed role and returning vectors nothing can be compared against.
    expect(r.model).not.toBe('llama-3.3-70b-versatile');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_embed_model');
  });

  it('still lets other roles degrade to chat, unchanged', async () => {
    writeRegistry({
      endpoints: [CHAT_ENDPOINT],
      roles: { chat: { endpoint_id: 'ep-chat', model: 'llama-3.3-70b-versatile' } },
    });

    const r = await endpoints.resolveForRole('creative');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('llama-3.3-70b-versatile');
  });

  it('resolves an explicit embed assignment', async () => {
    writeRegistry({
      endpoints: [EMBED_ENDPOINT],
      roles: { embed: { endpoint_id: 'ep-embed', model: 'text-embedding-3-small' } },
    });

    const r = await endpoints.resolveForRole('embed');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('text-embedding-3-small');
    expect(r.role).toBe('embed');
  });

  it('auto-picks only a model that looks like an embedder', async () => {
    // No explicit assignment. The endpoint serves both shapes; auto-pick must
    // take the embedding one, not the first in the list.
    writeRegistry({ endpoints: [EMBED_ENDPOINT], roles: {} });

    const r = await endpoints.resolveForRole('embed');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('text-embedding-3-small');
  });

  it('refuses to guess when no model on the endpoint looks like an embedder', async () => {
    writeRegistry({ endpoints: [CHAT_ENDPOINT], roles: {} });

    const r = await endpoints.resolveForRole('embed');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_embed_model');
    // §08 — an error must name the remedy, cheapest first.
    expect(r.error).toMatch(/Cookbook/);
  });
});

describe('readiness mirrors the resolver', () => {
  // If these two disagree, the badge promises what the router will not deliver
  // — the BO-F3 defect. Same inputs, same answer.
  it('reports no_embed_model when only chat is assigned', () => {
    writeRegistry({
      endpoints: [CHAT_ENDPOINT],
      roles: { chat: { endpoint_id: 'ep-chat', model: 'llama-3.3-70b-versatile' } },
    });
    expect(endpoints.describeRoleLocal('embed')).toMatchObject({ ok: false, reason: 'no_embed_model' });
  });

  it('reports ok for an explicit embed assignment', () => {
    writeRegistry({
      endpoints: [EMBED_ENDPOINT],
      roles: { embed: { endpoint_id: 'ep-embed', model: 'text-embedding-3-small' } },
    });
    expect(endpoints.describeRoleLocal('embed')).toMatchObject({ ok: true, model: 'text-embedding-3-small' });
  });

  it('does not answer an embed enquiry from the env-var chat fallback', () => {
    // ENV_PROVIDER_FALLBACK names chat models on chat transports. Answering
    // from it would report ready, then hand the indexer a model that cannot
    // embed. No registry file at all is the state of a fresh install.
    const saved = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_test_key_not_real';
    try {
      expect(endpoints.describeRoleLocal('embed')).toMatchObject({ ok: false, reason: 'no_embed_model' });
      // The same fresh install CAN serve chat from the environment — proving
      // the guard is specific to embed, not a blanket refusal.
      expect(endpoints.describeRoleLocal('chat').ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = saved;
    }
  });
});

describe('the embed-model predicate', () => {
  it('recognises the naming convention providers actually use', () => {
    expect(endpoints.isEmbedModelName('text-embedding-3-small')).toBe(true);
    expect(endpoints.isEmbedModelName('nomic-embed-text-v1.5')).toBe(true);
    expect(endpoints.isEmbedModelName('embed-english-v3.0')).toBe(true);
    expect(endpoints.isEmbedModelName('gpt-4o-mini')).toBe(false);
    expect(endpoints.isEmbedModelName('llama-3.3-70b-versatile')).toBe(false);
    expect(endpoints.isEmbedModelName(null)).toBe(false);
  });

  it('returns null rather than a guess when nothing matches', () => {
    expect(endpoints.pickEmbedModel(['gpt-4o-mini', 'llama-3.3-70b'])).toBe(null);
    expect(endpoints.pickEmbedModel([])).toBe(null);
    expect(endpoints.pickEmbedModel(undefined)).toBe(null);
  });
});

describe('portable mode never reaches for a hosted embedder', () => {
  it('returns no_embed_model, and makes zero outbound requests', async () => {
    // Portable mode's whole promise is that it does not phone home. An embed
    // role with no local model must fail honestly rather than fall back.
    const savedPortable = process.env.AEON_PORTABLE;
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args) => { calls++; return realFetch(...args); };
    process.env.AEON_PORTABLE = 'true';

    try {
      writeRegistry({
        endpoints: [EMBED_ENDPOINT],
        roles: { embed: { endpoint_id: 'ep-embed', model: 'text-embedding-3-small' } },
      });

      const r = await endpoints.resolveForRole('embed');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('no_embed_model');
      expect(r.error).toMatch(/portable/i);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (savedPortable === undefined) delete process.env.AEON_PORTABLE;
      else process.env.AEON_PORTABLE = savedPortable;
    }
  });
});
