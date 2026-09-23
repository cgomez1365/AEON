/**
 * Council — reaching a model, and saying when its answer was cut off.
 *
 * Found live 2026-09-23 (agent C2) on a throwaway install whose only provider
 * was an OpenAI-compatible endpoint registered in Settings (provider "custom",
 * assigned to the chat role — the shape of LM Studio, a LAN box, or the CEO's
 * own "custom" connection):
 *
 *   GET /api/council/models  → { models: [] }   ("No models are reachable")
 *   GET /api/council/members → { members: [] }, and members.json saved as []
 *                              so it never re-seeded once a model appeared
 *   POST /api/ai {provider:"custom", model} → 503 "No local model is installed
 *                              and no cloud provider is configured"
 *
 * engineAlive() knows six provider names, and kernelLLM's explicit-provider
 * path can only dispatch those six — a registry endpoint is reachable only by
 * ROLE. Council now offers each role assigned in Settings as a member that
 * follows that role, and dispatches it by role.
 *
 * And /api/ai returns { text, role } only: a free model cut off at 1024 tokens
 * (finish_reason "length") read as a complete answer. /api/council/speak asks
 * kernelLLM.stream, which reports truncated/truncationReason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REGISTRY = {
  endpoints: [{ id: 'custom-lan', label: '192.168.1.20:1234', provider: 'custom', base_url: 'http://192.168.1.20:1234/v1', models: ['qwen3-8b', 'nomic-embed'], reachable_from: ['local'] }],
  roles: {
    chat: { endpoint_id: 'custom-lan', model: 'qwen3-8b' },
    research: { endpoint_id: 'custom-lan', model: 'qwen3-8b' },
    embed: { endpoint_id: 'custom-lan', model: 'nomic-embed' },
  },
};

let scratch, server, base, streamCalls, llmCalls, indexed, streamImpl;

async function mount({ registry = REGISTRY, withStream = true } = {}) {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-council-speak-'));
  streamCalls = []; llmCalls = []; indexed = [];
  const kernelLLM = async (prompt, opts) => { llmCalls.push({ prompt, opts }); return 'plain answer'; };
  if (withStream) {
    kernelLLM.stream = async (messages, opts) => {
      streamCalls.push({ messages, opts });
      if (streamImpl) return streamImpl(messages, opts);
      return { text: 'streamed answer', truncated: false, truncationReason: null, provider: 'custom', model: 'qwen3-8b', fallback: false };
    };
  }
  const factory = require_(path.join(ROOT, 'src', 'blocks', 'council', 'api', 'index.cjs'));
  const router = factory({
    getDataFile: (name) => { const p = path.join(scratch, name); fs.mkdirSync(p, { recursive: true }); return p; },
    kernelLLM,
    VAULT_ROOT: path.join(scratch, 'Vault'),
    requestIndex: (change) => indexed.push(change),
    _endpoints: { load: async () => registry },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}

const api = async (method, url, body) => {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeEach(() => { streamImpl = null; });
afterEach(async () => {
  if (server) await new Promise((res) => server.close(res));
  server = null;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('a registry-only install can build a council', () => {
  it('offers every assigned chat-capable role as a member that follows it', async () => {
    await mount();
    const { body } = await api('GET', '/council/models');
    const engines = body.models.map((m) => m.engine);
    expect(engines).toContain('role:chat');
    expect(engines).toContain('role:research');
    // An embedding model cannot deliberate.
    expect(engines).not.toContain('role:embed');
    const chat = body.models.find((m) => m.engine === 'role:chat');
    expect(chat.id).toBe('qwen3-8b');
    expect(chat.name).toMatch(/chat/);
  });

  it('seeds a roster from those roles on first open', async () => {
    await mount();
    const { body } = await api('GET', '/council/members');
    expect(body.members.length).toBeGreaterThanOrEqual(2);
    expect(body.members.filter((m) => m.chair)).toHaveLength(1);
    expect(body.members.every((m) => m.provider.startsWith('role:'))).toBe(true);
  });

  it('one reachable model still seats two councilors, so CONVENE works on a fresh install', async () => {
    await mount({ registry: { endpoints: REGISTRY.endpoints, roles: { chat: REGISTRY.roles.chat } } });
    const { body } = await api('GET', '/council/members');
    expect(body.members.filter((m) => !m.chair)).toHaveLength(2);
    expect(new Set(body.members.map((m) => m.label)).size).toBe(body.members.length);
  });

  it('an empty seed is not saved, so the roster fills in once a model appears', async () => {
    await mount({ registry: { endpoints: [], roles: {} } });
    const first = await api('GET', '/council/members');
    expect(first.body.members).toEqual([]);
    expect(fs.existsSync(path.join(scratch, 'council', 'members.json'))).toBe(false);
  });
});

describe('POST /council/speak', () => {
  it('dispatches a role member by role, never as an explicit provider', async () => {
    await mount();
    const r = await api('POST', '/council/speak', { prompt: 'Should we?', provider: 'role:research', model: 'qwen3-8b' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('streamed answer');
    expect(streamCalls[0].opts.role).toBe('research');
    expect(streamCalls[0].opts.provider).toBeUndefined();
    expect(streamCalls[0].messages.at(-1)).toEqual({ role: 'user', content: 'Should we?' });
  });

  it('a member saved with no provider follows the chat role', async () => {
    await mount();
    await api('POST', '/council/speak', { prompt: 'x', provider: '', model: '' });
    expect(streamCalls[0].opts.role).toBe('chat');
    expect(streamCalls[0].opts.provider).toBeUndefined();
  });

  it('an explicit provider member keeps its provider and model', async () => {
    await mount();
    await api('POST', '/council/speak', { prompt: 'x', provider: 'openrouter', model: 'meta/llama:free' });
    expect(streamCalls[0].opts).toMatchObject({ provider: 'openrouter', model: 'meta/llama:free' });
  });

  it('reports an answer cut off at the output limit', async () => {
    streamImpl = async () => ({ text: 'Point 1 … and the final recommendation is that you should', truncated: true, truncationReason: 'max_tokens', provider: 'openrouter', model: 'x:free', fallback: false });
    await mount();
    const r = await api('POST', '/council/speak', { prompt: 'x', provider: 'openrouter', model: 'x:free' });
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.truncationReason).toBe('max_tokens');
  });

  it('a rate limit is a 429 the UI can name, not a 500', async () => {
    streamImpl = async () => { const e = new Error('custom is rate-limited right now (HTTP 429). This is temporary'); e.rateLimited = true; throw e; };
    await mount();
    const r = await api('POST', '/council/speak', { prompt: 'x', provider: 'role:chat' });
    expect(r.status).toBe(429);
    expect(r.body.rateLimited).toBe(true);
    expect(r.body.error).toMatch(/rate-limited/);
  });

  it('keeps text that streamed before a failure', async () => {
    streamImpl = async () => { const e = new Error('socket hang up'); e.partialText = 'half an answer'; throw e; };
    await mount();
    const r = await api('POST', '/council/speak', { prompt: 'x', provider: 'role:chat' });
    expect(r.status).toBe(502);
    expect(r.body.partialText).toBe('half an answer');
  });

  it('without a streaming kernel it still answers, and says truncation is unknown', async () => {
    await mount({ withStream: false });
    const r = await api('POST', '/council/speak', { prompt: 'x', provider: 'role:chat' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('plain answer');
    expect(r.body.truncated).toBeNull();
    expect(llmCalls[0].opts.role).toBe('chat');
  });
});

describe('the Vault transcript', () => {
  it('records cut-off answers and a missing verdict, and asks the Matrix to index it', async () => {
    await mount();
    const r = await api('POST', '/council/debate/save', {
      question: 'Hire or contract?',
      verdict: '',
      verdictError: 'The chair could not write a verdict: Endpoint error 502',
      opinions: [{ label: 'The Pragmatist', opening: 'Contract it', revised: 'Contract, 8 weeks and you should', openingTruncated: false, revisedTruncated: true }],
    });
    expect(r.status).toBe(200);
    const md = fs.readFileSync(path.join(scratch, 'Vault', 'Agents', 'council', 'debates', `${r.body.id}.md`), 'utf8');
    expect(md).toMatch(/\*Final:\* Contract, 8 weeks and you should\s*\n\s*_\(cut off/);
    expect(md).toMatch(/## Verdict\n\n_No verdict — The chair could not write a verdict: Endpoint error 502_/);
    expect(indexed).toHaveLength(1);
    expect(indexed[0].path).toBe(`Agents/council/debates/${r.body.id}.md`);
  });

  it('still refuses a save with neither a verdict nor a reason there is none', async () => {
    await mount();
    const r = await api('POST', '/council/debate/save', { question: 'Q', opinions: [] });
    expect(r.status).toBe(400);
  });
});
