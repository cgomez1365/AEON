/**
 * services/ai.js — a generation stopped because the model finished writing a
 * tool call (agentTurn.cjs aborts with an AeonToolStop) is a clean stop:
 * not cancelled, recorded as a success, the provider stays healthy. An
 * operator stop is unchanged: cancelled.
 *
 * REAL services/ai.js against a fake OpenAI-compatible SSE endpoint that keeps
 * streaming until its socket is torn down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const { AeonToolStop } = require('../src/kernel/agentTurn.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-toolstop-'));
const savedCache = {};
const savedEnv = {};
const servers = [];
const audit = [];
let ai;
let savedSecrets;
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); }); });

beforeAll(async () => {
  savedSecrets = process.env.AEON_SECRETS_DIR;
  process.env.AEON_SECRETS_DIR = tempSecrets;
  for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  const fake = express();
  fake.use(express.json());
  fake.post('/v1/chat/completions', (req, res) => {
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
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: {
    isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [], status: () => ({ available: false }),
    plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  } };
  ai = require(AI_PATH)({
    supabase: null, aeonTerminalStream: null,
    writeOSAudit: (kind, line, status) => audit.push({ kind, line, status }),
    loadSettings: () => ({ models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} }),
    TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-toolstop-ledger-')), 'l.json'),
  });
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const p of Object.keys(savedCache)) { if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p]; }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
  try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
});

const streamUntil = async (n, reason) => {
  const ctl = new AbortController();
  let seen = 0;
  const r = await ai.kernelLLM.stream([{ role: 'user', content: 'hi' }], {
    role: 'chat', signal: ctl.signal,
    onToken: () => { seen++; if (seen === n) ctl.abort(reason()); },
  });
  return r;
};

describe('kernelLLM.stream — a stop for a tool call', () => {
  it('is not a cancel: cancelled false, stoppedFor "tool", the text so far, a successful record', async () => {
    audit.length = 0;
    const r = await streamUntil(3, () => new AeonToolStop());
    expect(r.cancelled).toBe(false);
    expect(r.stoppedFor).toBe('tool');
    expect(r.truncated).toBe(false);
    expect(r.text.startsWith('w1 w2 w3 ')).toBe(true);
    expect(r).toMatchObject({ provider: 'custom', model: 'fake-model' });
    const llm = audit.filter((a) => a.kind === 'LLM_CUSTOM');
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.every((a) => a.status === 200 && !/FAILED/.test(a.line))).toBe(true);
  });

  it('many tool stops in a row leave the provider healthy', async () => {
    for (let i = 0; i < 4; i++) await streamUntil(2, () => new AeonToolStop());
    const h = ai.getProviderHealth();
    expect(h.custom?.healthy ?? true).not.toBe(false);
    expect(h.custom?.blockedUntil || 0).toBeLessThanOrEqual(Date.now());
  });

  it('an operator stop is still cancelled', async () => {
    audit.length = 0;
    const r = await streamUntil(2, () => undefined);
    expect(r.cancelled).toBe(true);
    expect(r.stoppedFor).toBeUndefined();
  });
});
