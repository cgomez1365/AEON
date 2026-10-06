/**
 * services/ai.js — an operator Stop is recorded as what it was, and a bare
 * number in an error message is not read as an HTTP status.
 *
 * Real drive log rows: `LLM_LOCAL 500 llama3-8b-q4 "20 tok | 826172ms | FAILED"`
 * and `"0 tok | 11237ms | FAILED"`. A Stop wrote success:false with no cause,
 * the audit line said FAILED with a made-up 500, and every error counter
 * counted the operator's own click as a provider failure (R-05: no silent
 * failures; a Stop is not one either).
 *
 * REAL services/ai.js: a fake OpenAI-compatible SSE endpoint that keeps
 * streaming (cloud path), and a local-runtime stub that answers a stop the
 * way the real runtime does, with { cancelled: true } (local path).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const { createLedger } = require('../src/kernel/llm-ledger.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-opstop-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-opstop-ledger-'));
const savedCache = {};
const savedEnv = {};
const servers = [];
const audit = [];
let ai;
let savedSecrets;
let chat = { provider: 'custom', model: 'fake-model' };
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); }); });
const ledgerRows = () => {
  const f = path.join(ledgerDir, 'llm_calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// A local runtime that honours Stop the way the real one does: it answers with
// what had arrived and cancelled:true instead of throwing.
const lrStub = {
  isAvailable: () => true, defaultModel: () => 'llama3-8b-q4', listReadyModels: () => [{ id: 'llama3-8b-q4' }],
  status: () => ({ available: true, readyModels: [{ id: 'llama3-8b-q4' }] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  inferStream: async (_p, o, onToken) => {
    onToken('Half an ');
    await new Promise((r) => setTimeout(r, 30));
    return { text: 'Half an ', tokens: 20, model: 'llama3-8b-q4', cancelled: !!o.signal?.aborted, complete: false };
  },
};

beforeAll(async () => {
  savedSecrets = process.env.AEON_SECRETS_DIR;
  process.env.AEON_SECRETS_DIR = tempSecrets;
  for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  const fake = express();
  fake.use(express.json());
  fake.post('/v1/chat/completions', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const tick = setInterval(() => {
      i++;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${i} ` } }] })}\n\n`);
      if (i > 200) { clearInterval(tick); res.end(); }
    }, 5);
    res.on('close', () => clearInterval(tick));
  });
  const port = await listen(fake);
  fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
    endpoints: [{ id: 'fake', provider: 'custom', base_url: `http://127.0.0.1:${port}/v1`, auth_ref: null, reachable_from: ['local'], models: ['fake-model'] }],
    roles: { chat: { endpoint_id: 'fake', model: 'fake-model' } },
  }));
  require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({
    supabase: null, aeonTerminalStream: null,
    writeOSAudit: (kind, line, status) => audit.push({ kind, line, status }),
    loadSettings: () => ({ models: { chat }, prefs: {} }),
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
  });
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const p of Object.keys(savedCache)) { if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p]; }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => {
  audit.length = 0;
  ai._resetProviderHealth?.();
  try { fs.rmSync(path.join(ledgerDir, 'llm_calls.jsonl'), { force: true }); } catch {}
});

const stopAfter = async (n) => {
  const ctl = new AbortController();
  let seen = 0;
  return ai.kernelLLM.stream([{ role: 'user', content: 'hi' }], {
    role: 'chat', signal: ctl.signal,
    onToken: () => { seen++; if (seen === n) ctl.abort(); },
  });
};

const expectRecordedAsOperatorStop = (provider) => {
  const rows = ledgerRows().filter((r) => r.provider === provider);
  expect(rows).toHaveLength(1);
  expect(rows[0].error).toBe('cancelled by operator');
  expect(rows[0].cancelled).toBe(true);
  expect(rows[0].status).toBeUndefined(); // no HTTP status it never had
  const line = audit.find((a) => a.kind === `LLM_${provider.toUpperCase()}`);
  expect(line.line).toContain('cancelled by operator');
  expect(line.status).not.toBe(500); // not a made-up server error
  expect(line.status).not.toBe(200); // and not a success either
};

describe('an operator Stop on a cloud stream', () => {
  it('is recorded with its cause, not as a bare FAILED with a fake 500', async () => {
    chat = { provider: 'custom', model: 'fake-model' };
    const r = await stopAfter(3);
    expect(r.cancelled).toBe(true);
    expectRecordedAsOperatorStop('custom');
  });

  it('is not a provider failure: no health strike, no rest, however many times', async () => {
    chat = { provider: 'custom', model: 'fake-model' };
    for (let i = 0; i < 6; i++) await stopAfter(2);
    const h = ai.getProviderHealth();
    expect(h.custom?.healthy ?? true).not.toBe(false);
    expect(h.custom?.blockedUntil || 0).toBeLessThanOrEqual(Date.now());
  });

  it('is not counted as an error by the ledger totals', async () => {
    chat = { provider: 'custom', model: 'fake-model' };
    await stopAfter(2);
    const ledger = createLedger({ file: path.join(ledgerDir, 'llm_calls.jsonl') });
    expect(ledger.totals().requests).toBe(1);
    expect(ledger.totals().errors).toBe(0);
    expect(Object.values(ledger.byModel())[0].errors).toBe(0);
    expect(Object.values(ledger.byDay())[0].errors).toBe(0);
  });
});

describe('an operator Stop on the local runtime', () => {
  it('is recorded with its cause and tokens, not as a bare FAILED 500', async () => {
    chat = { provider: 'local', model: 'llama3-8b-q4' };
    const r = await stopAfter(1);
    expect(r.cancelled).toBe(true);
    expect(r.provider).toBe('local');
    expectRecordedAsOperatorStop('local');
    expect(ledgerRows()[0].tokens).toBe(20);
  });
});

describe('a real failure is still a failure', () => {
  it('a local error stays success:false with its own words and no cancelled mark', async () => {
    chat = { provider: 'local', model: 'llama3-8b-q4' };
    const saved = lrStub.inferStream;
    lrStub.inferStream = async () => { const e = new Error('llama-server exited'); e.status = 500; throw e; };
    try {
      await ai.kernelLLM.stream([{ role: 'user', content: 'hi' }], { role: 'chat', onToken: () => {} }).catch(() => {});
    } finally { lrStub.inferStream = saved; }
    const row = ledgerRows().find((r) => r.provider === 'local' && r.success === false);
    expect(row).toBeTruthy();
    expect(row.cancelled).toBeUndefined();
    expect(row.error).not.toBe('cancelled by operator');
  });
});

describe('_failureStatus reads a status only where it is a standalone HTTP status', () => {
  const st = (message, extra = {}) => ai._failureStatus(Object.assign(new Error(message), extra));

  it('keeps every shape a real rate limit arrives in', () => {
    expect(st('Rate limit hit (429)')).toBe(429);
    expect(st('429')).toBe(429);
    expect(st('upstream said 429 Too Many Requests')).toBe(429);
    expect(st('custom is rate-limited right now (HTTP 429). This is temporary')).toBe(429);
    expect(st('Provider returned 429.')).toBe(429);
    expect(st('Groq API error 429')).toBe(429);
    expect(st('You exceeded your quota: 402 Payment Required')).toBe(402);
    expect(st('failed: HTTP 402, insufficient credits')).toBe(402);
    expect(st('anything', { status: 429 })).toBe(429);
  });

  it('does not read a size or a longer number as a status', () => {
    expect(st('Requested 14290 tokens, limit is 8000')).toBeNull();
    expect(st('Request too big: 4,429 tokens')).toBeNull();
    expect(st('Request too big: 4.429 tokens')).toBeNull();
    expect(st('prompt is 1,402 tokens over')).toBeNull();
    expect(st('about 429 tokens in the window')).toBeNull();
    expect(st('about 402 bytes were lost')).toBeNull();
    expect(st('id 4290 not found')).toBeNull();
    expect(st('order 24029')).toBeNull();
  });

  it('a cloud error naming a size does not rest the provider', () => {
    // The bare scrape is what rested a provider and moved the turn elsewhere.
    expect(st('Requested 14290 tokens')).not.toBe(429);
    expect(st('Request too large: 4,429 tokens')).not.toBe(429);
  });
});
