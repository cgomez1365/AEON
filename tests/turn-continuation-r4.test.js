/**
 * 3.3.0 review round 4 — the turn engine and the scanner, each a regression
 * test that failed before its fix:
 *
 *   R4-5  a continuation the provider called too large was retried trimmed;
 *         the trim dropped the cut-off answer and the question, and the
 *         model's reply to the bare "continue" prompt was stitched on
 *   R4-6  a continuation that came back empty at the limit (a reasoning model
 *         that spent its budget thinking) ended the turn with a provider
 *         error and no done
 *   R4-7  a cut-off part ending in inline code ("`npm") carried that tail into
 *         the next part, and a restarted line was glued after it
 *   R4-4  the scanner re-read held text on every character: a long line of
 *         backticks blocked the server for seconds
 *
 * R4-5 runs the REAL services/ai.js against a fake OpenAI-compatible server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');
const protocol = require('../src/kernel/toolProtocol.cjs');

const CONT = /Your previous reply was cut off by the output limit/;
const PART1 = `The migration has three phases. ${'Phase one moves the tables one by one with care. '.repeat(400)}Phase two moves the`;

describe('R4-5 a continuation is never retried trimmed (real services/ai.js)', () => {
  const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cont-r4-'));
  const savedCache = {};
  const savedEnv = {};
  const servers = [];
  const requests = [];
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
    fake.use(express.json({ limit: '5mb' }));
    fake.post('/v1/chat/completions', async (req, res) => {
      const msgs = req.body.messages || [];
      const isCont = CONT.test(String(msgs.at(-1)?.content || ''));
      requests.push({ cont: isCont, partial: msgs.some((m) => m.role === 'assistant') });
      // Any request that still carries the cut-off answer is over the limit.
      if (isCont && msgs.some((m) => m.role === 'assistant')) {
        res.status(413).json({ error: { message: 'Request too large for model fake-model. Limit 6000, Requested 7000' } });
        return;
      }
      const text = isCont ? 'TRIMMED-REPLY.' : PART1;
      const finish = isCont ? 'stop' : 'length';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < text.length; i += 500) {
        const last = i + 500 >= text.length;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 500) }, ...(last ? { finish_reason: finish } : {}) }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
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
      supabase: null, aeonTerminalStream: null, writeOSAudit: () => {},
      loadSettings: () => ({ models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} }),
      TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cont-r4-ledger-')), 'l.json'),
    });
  });

  afterAll(() => {
    for (const s of servers) { try { s.close(); } catch {} }
    for (const p of Object.keys(savedCache)) { if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p]; }
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
    if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
    try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {}
  });

  it('a too-large continuation ends the answer where it stopped; no reply to a context-free prompt is stitched on', async () => {
    const c = collector();
    const r = await runAgentTurn({
      kernelLLM: ai.kernelLLM,
      messages: [{ role: 'system', content: 'You are AEON.' }, { role: 'user', content: 'Explain the migration in detail.' }],
      emit: c.emit,
    });
    expect(r.text).not.toContain('TRIMMED-REPLY');
    expect(r.text).toBe(PART1);
    expect(r.truncated).toBe(true);
    expect(r.truncationReason).toMatch(/too long for this model to continue automatically/);
    expect(c.of('notice').some((n) => n.code === 'continue-stopped')).toBe(true);
    // The continuation was never sent without the answer it continues.
    expect(requests.filter((q) => q.cont && !q.partial)).toEqual([]);
    expect(requests.filter((q) => q.cont).length).toBe(1);
  });
});

describe('R4-6 a continuation that cannot be fetched ends the answer cleanly', () => {
  it('an empty part at the limit (reasoning budget) → done, truncated, the cause in a notice', async () => {
    const budget = new Error('The model used its whole output budget (4096 tokens) before it answered (finish_reason "length").');
    budget.reasoningExhausted = true;
    const chain = new Error('No provider could answer right now — custom unavailable. Add a key or credits in Settings, or try again shortly.');
    chain.cause = budget;
    const fs1 = fakeStream([{ tokens: ['Some text before'], truncated: true }, { throw: chain }]);
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream: fs1.stream }, messages: [{ role: 'user', content: 'q' }], emit: c.emit });
    expect(r.text).toBe('Some text before');
    expect(r.truncated).toBe(true);
    expect(r.parts).toBe(2);
    const n = c.of('notice').find((x) => x.code === 'continue-stopped');
    expect(n.message).toMatch(/whole output budget/);
    expect(n.message).not.toMatch(/Add a key/);
    // Every continuation round asks the kernel not to trim it.
    expect(fs1.calls[1].opts.noTrimRetry).toBe(true);
    expect(fs1.calls[0].opts.noTrimRetry).toBeUndefined();
  });

  it('a failure before any part was shown still throws, as before', async () => {
    const fs1 = fakeStream([{ throw: new Error('down') }]);
    await expect(runAgentTurn({ kernelLLM: { stream: fs1.stream }, messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow('down');
  });
});

describe('R4-7 only a possible tool opener is carried across a cut', () => {
  const toolbox = {
    callsLeft: () => 6, writesLeft: () => 3, outcomes: () => [], nonce: '',
    run: async () => ({ id: 't1', n: 1, tool: 'vault_list', ok: true, status: 'ok', text: 'x' }),
  };
  const turn = async (rounds) => {
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream: fakeStream(rounds).stream }, messages: [{ role: 'user', content: 'q' }], toolbox, emit: c.emit });
    return r.text;
  };

  it('inline code at the cut, then the line restarted, reads once', async () => {
    expect(await turn([{ tokens: ['Run `npm'], truncated: true }, { tokens: ['Run `npm ci` now.'] }])).toBe('Run `npm ci` now.');
    expect(await turn([{ tokens: ['Use the `'], truncated: true }, { tokens: ['Use the `npm ci` command.'] }])).toBe('Use the `npm ci` command.');
    expect(await turn([{ tokens: ['Use the `'], truncated: true }, { tokens: ['npm ci` command.'] }])).toBe('Use the `npm ci` command.');
  });

  it('an opener cut mid-word is still carried and run', async () => {
    const ran = [];
    const tb = { ...toolbox, run: async (call) => { ran.push(call); return { id: 't1', n: 1, tool: call.tool, ok: true, status: 'ok', text: 'x' }; }, callsLeft: () => 6 - ran.length };
    const c = collector();
    await runAgentTurn({
      kernelLLM: { stream: fakeStream([
        { tokens: ['Let me look.\n```aeon-to'], truncated: true },
        { tokens: ['ol\n{"tool": "vault_list", "path": "Notes"}\n```\n'] },
        { tokens: ['Done.'] },
      ]).stream },
      messages: [{ role: 'user', content: 'q' }], toolbox: tb, emit: c.emit,
    });
    expect(ran.map((x) => x.tool)).toEqual(['vault_list']);
    expect(c.tokens()).not.toContain('aeon-to');
  });

  it('CARRY_RE: a fence of three and a start of "aeon-tool", nothing else', () => {
    for (const t of ['```', '```aeon-to', '~~~aeon', '``` aeon_tool', '```aeon-tool {"tool": "x', '````aeon tool']) expect(protocol.CARRY_RE.test(t)).toBe(true);
    for (const t of ['`npm', '``', '`', '```js', '```aeon-tooling']) expect(protocol.CARRY_RE.test(t)).toBe(false);
  });
});

describe('R4-4 the scanner is linear in the length of a line', () => {
  const time = (s) => {
    const sc = protocol.createScanner({ onText: () => {} });
    const t0 = Date.now();
    for (const ch of s) sc.push(ch);
    sc.end({});
    return Date.now() - t0;
  };

  it('100,000 backticks, one at a time, scan in well under a second', () => {
    expect(time('`'.repeat(100000))).toBeLessThan(1000);
    expect(time('~'.repeat(100000))).toBeLessThan(1000);
    expect(time(`\`\`\`${' '.repeat(100000)}`)).toBeLessThan(1000);
    expect(time(`\`\`\`aeon-tool {${'x'.repeat(100000)}`)).toBeLessThan(1000);
  });

  it('a too-long held line is shown as text and never run; a normal call still is', () => {
    let shown = '';
    const sc = protocol.createScanner({ onText: (t) => { shown += t; } });
    const long = `\`\`\`aeon-tool {"tool": "vault_list", "path": "${'x'.repeat(protocol.HOLD_LINE_MAX)}"}\`\`\`\n`;
    let hit = null;
    for (const ch of long) hit = hit || sc.push(ch);
    expect(hit).toBeNull();
    expect(shown).toContain('aeon-tool');
    const sc2 = protocol.createScanner({ onText: () => {} });
    expect(sc2.push('```aeon-tool {"tool": "vault_list", "path": "Notes"}```\n')).toMatchObject({ block: { header: '{"tool": "vault_list", "path": "Notes"}' } });
  });
});
