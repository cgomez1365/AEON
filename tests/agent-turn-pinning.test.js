/**
 * Later rounds of one chat turn (a tool round, a continuation) go through the
 * same connection as round 1: its address, key pool and pacing.
 *
 * Review 2026-10-03: every later round was pinned to {provider, model} from
 * round 1. For a provider with a legacy name (groq, gemini, openrouter,
 * claude) that took services/ai.js's override path — the profile's default
 * host and the env key, no registry pool, no rpm pacing — so a turn's round 2
 * left the connection the operator configured.
 *
 * REAL services/ai.js against a fake OpenAI-compatible endpoint registered as
 * provider "groq" at a non-default address.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pin-'));
const savedCache = {};
const savedEnv = {};
const servers = [];
const hits = [];
let ai;
let savedSecrets;
let port;
let replies = [];
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); }); });

beforeAll(async () => {
  savedSecrets = process.env.AEON_SECRETS_DIR;
  process.env.AEON_SECRETS_DIR = tempSecrets;
  for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // A key in the environment too: the override path would use it and the
  // default Groq host; the registry connection must win.
  process.env.GROQ_API_KEY = 'test-key-not-real';
  const fake = express();
  fake.use(express.json());
  fake.post('/fake-groq/v1/chat/completions', (req, res) => {
    hits.push(req.path);
    const [text, finish] = replies.shift() || ['done.', 'stop'];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  port = await listen(fake);
  fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
    endpoints: [{ id: 'g', provider: 'groq', base_url: `http://127.0.0.1:${port}/fake-groq/v1`, auth_ref: null, reachable_from: ['local'], models: ['openai/gpt-oss-20b'], rpm_limit: 600 }],
    roles: { chat: { endpoint_id: 'g', model: 'openai/gpt-oss-20b' } },
  }));
  require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: {
    isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [], status: () => ({ available: false }),
    plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  } };
  ai = require(AI_PATH)({
    supabase: null, aeonTerminalStream: null, writeOSAudit: () => {},
    loadSettings: () => ({ models: { chat: { provider: 'groq', model: 'openai/gpt-oss-20b' } }, prefs: {} }),
    TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pin-ledger-')), 'l.json'),
  });
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const p of Object.keys(savedCache)) { if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p]; }
  delete process.env.GROQ_API_KEY;
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
});

describe('later rounds keep round 1\'s connection', () => {
  it('a continued answer: both rounds reach the registry address of a groq connection', async () => {
    hits.length = 0;
    replies = [['The answer starts here and', 'length'], [' ends here.', 'stop']];
    const r = await runAgentTurn({
      kernelLLM: ai.kernelLLM, messages: [{ role: 'user', content: 'hi' }], emit: () => {},
    });
    expect(r.parts).toBe(2);
    expect(r.text).toBe('The answer starts here and ends here.');
    expect(hits).toEqual(['/fake-groq/v1/chat/completions', '/fake-groq/v1/chat/completions']);
  });

  it('a pinned round (after a fallback) resolves a legacy-named provider through the registry', async () => {
    hits.length = 0;
    replies = [['ok', 'stop']];
    const r = await ai.kernelLLM.stream([{ role: 'user', content: 'hi' }], {
      role: 'chat', provider: 'groq', model: 'openai/gpt-oss-20b', _pinnedRound: true, onToken() {},
    });
    expect(r.provider).toBe('groq');
    expect(hits).toEqual(['/fake-groq/v1/chat/completions']);
  });
});

describe('the turn engine pins only a fallback', () => {
  it('round 1 served by the role\'s own primary: later rounds carry no provider override', async () => {
    const f = fakeStream([
      { tokens: ['part one and'], truncated: true, provider: 'groq', model: 'm' },
      { tokens: [' part two.'] },
    ]);
    await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], emit: () => {} });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].opts.provider).toBeUndefined();
    expect(f.calls[1].opts._pinnedRound).toBeUndefined();
  });

  it('round 1 served by a fallback: later rounds stay on it', async () => {
    const f = fakeStream([
      { tokens: ['part one and'], truncated: true, provider: 'openrouter', model: 'free-a', fallback: true },
      { tokens: [' part two.'] },
    ]);
    await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], emit: () => {} });
    expect(f.calls[1].opts).toMatchObject({ provider: 'openrouter', model: 'free-a', _pinnedRound: true });
  });
});
