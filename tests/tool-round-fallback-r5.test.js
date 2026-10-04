/**
 * 3.3.0 review round 5 — a round after a tool result is never retried
 * TRIMMED (the trim keeps only the system head and the wrapped tool result,
 * dropping the ## TOOLS rules), but it still FALLS BACK to the next provider
 * with the full request. Only a continuation round stops at the first
 * provider. REAL services/ai.js + REAL agentTools + runAgentTurn; a fake Groq
 * (primary) and a fake OpenRouter (fallback) on 127.0.0.1.
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
const VAULT_PATH = path.join(ROOT, 'src', 'kernel', 'vault.cjs');
const POOL_PATH = path.join(ROOT, 'src', 'kernel', 'keyPool.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-r5-tr-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-r5-tr-ledger-'));
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-r5-tr-vault-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'r5-probe-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');
const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, AI_PATH, LR_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }

const sse = (res, content, finish = 'stop') => {
  res.status(200).set('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const TOOL = '```aeon-tool\n{"tool": "vault_read", "path": "Notes/plan.md"}\n```\n';
let groqMode = 'too-large';
let orMode = 'answer';
const groqSeen = [];
const orSeen = [];
const fakeGroq = express();
fakeGroq.use(express.json({ limit: '5mb' }));
fakeGroq.post('/v1/chat/completions', (req, res) => {
  const body = JSON.stringify(req.body.messages);
  const last = req.body.messages[req.body.messages.length - 1];
  const afterTool = String(last && last.content || '').startsWith('<<<AEON-TOOL-RESULT');
  groqSeen.push({ afterTool, trimmed: body.includes('Context trimmed') });
  if (!afterTool) return sse(res, `Let me look.\n${TOOL}`);
  if (groqMode === 'too-large') {
    return res.status(413).json({ error: { message: 'Request too large for model `openai/gpt-oss-120b` in organization `org_test` on tokens per minute (TPM): Limit 6000, Requested 9000, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } });
  }
  return sse(res, '', 'length');    // a reasoning model that spent its budget thinking
});
const fakeOR = express();
fakeOR.use(express.json({ limit: '5mb' }));
fakeOR.post('/v1/chat/completions', (req, res) => {
  orSeen.push({ model: req.body.model, trimmed: JSON.stringify(req.body.messages).includes('Context trimmed'), hasTools: JSON.stringify(req.body.messages).includes('## TOOLS') });
  if (orMode === 'too-large') return res.status(413).json({ error: { message: 'Request too large for this model.', type: 'tokens', code: 'request_too_large' } });
  return sse(res, 'The plan says ship on Friday.');
});

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [], status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local'); }, inferStream: async () => { throw new Error('no local'); },
};

const servers = [];
let ai;
let keyPool;
const settingsNow = { models: { chat: { provider: 'groq', model: 'openai/gpt-oss-120b' } }, roulette: false, prefs: {} };

beforeAll(async () => {
  const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });
  const groqPort = await listen(fakeGroq);
  const orPort = await listen(fakeOR);
  const vault = require(VAULT_PATH);
  await vault.setSecret('groq-key', 'gsk_r5_probe_0000');
  await vault.setSecret('or-key', 'sk-or-v1-r5probe0000');
  fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: [
    { id: 'groq-fake', provider: 'groq', base_url: `http://127.0.0.1:${groqPort}/v1`, auth_ref: 'groq-key', reachable_from: ['local'], models: ['openai/gpt-oss-120b'], rpm_limit: 0 },
    { id: 'or-fake', provider: 'openrouter', base_url: `http://127.0.0.1:${orPort}/v1`, auth_ref: 'or-key', reachable_from: ['local'], models: ['openrouter/free'], rpm_limit: 0 },
  ], roles: {} }, null, 2));
  require(ENDPOINTS_PATH);
  keyPool = require(POOL_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  ai = require(AI_PATH)({ supabase: null, writeOSAudit: () => {}, TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'), loadSettings: () => settingsNow, aeonTerminalStream: { emit: () => {} } });
  await ai.envHydrated;
  fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'Notes', 'plan.md'), 'Ship on Friday.');
});

afterAll(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) { if (mod) require.cache[p] = mod; else delete require.cache[p]; }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir, vaultDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

beforeEach(() => { keyPool._reset(); ai._resetProviderHealth(); groqSeen.length = 0; orSeen.length = 0; orMode = 'answer'; });

async function turn(runAgentTurn) {
  const agentTools = require('../src/kernel/agentTools.cjs');
  const tb = agentTools.createToolbox({ vaultRoot: vaultDir, contextTokens: 32768 });
  const notices = [];
  const r = await runAgentTurn({
    kernelLLM: { stream: ai.kernelLLMStream }, role: 'chat', toolbox: tb,
    messages: [{ role: 'system', content: `You are AEON.\n\n${tb.promptText()}` }, { role: 'user', content: 'when do we ship?' }],
    emit: (ev, d) => { if (ev === 'notice') notices.push(d.code); },
  }).catch((e) => ({ thrown: e.message }));
  return { r, notices };
}


const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

for (const mode of ['too-large', 'reasoning']) {
  describe(`a round after a tool result, primary answers ${mode}`, () => {
    it('is not trimmed, and the next provider answers it with the full request', async () => {
      groqMode = mode;
      const { r, notices } = await turn(runAgentTurn);
      expect(r.thrown).toBeUndefined();
      expect(r.text).toContain('ship on Friday');
      expect(notices).not.toContain('tool-round-stopped');
      // Groq saw the tool round once, untrimmed; OpenRouter got it whole, rules included.
      expect(groqSeen.filter((g) => g.afterTool)).toEqual([{ afterTool: true, trimmed: false }]);
      expect(orSeen.length).toBe(1);
      expect(orSeen[0]).toMatchObject({ trimmed: false, hasTools: true });
    });
  });
}

describe('a round after a tool result that no provider can take', () => {
  it('keeps what was shown and says why, never a trimmed retry', async () => {
    groqMode = 'too-large';
    orMode = 'too-large';
    const { r, notices } = await turn(runAgentTurn);
    expect(notices).toContain('tool-round-stopped');
    expect(r.text).toContain('Let me look.');
    expect(groqSeen.some((g) => g.trimmed)).toBe(false);
    expect(orSeen.some((o) => o.trimmed)).toBe(false);
  });
});
