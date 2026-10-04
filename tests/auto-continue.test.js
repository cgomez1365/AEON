/**
 * F1 — auto-continue (src/kernel/continuation.cjs + src/kernel/agentTurn.cjs).
 *
 * Free OpenRouter models stop at 1,024 output tokens; the operator typed
 * "continue" by hand, many times per long answer. Now, when (and only when)
 * the provider says it stopped for the output limit, AEON asks the model to
 * carry on and streams the parts as ONE answer, with no repeated text at the
 * seams, on the same provider/model and with the agent's privacy every time.
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
const continuation = require('../src/kernel/continuation.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

describe('the seam', () => {
  it('overlapLength: a repeated tail is found, with leading whitespace', () => {
    const prev = 'The vault keeps two halves of the key apart';
    expect(continuation.overlapLength(prev, 'two halves of the key apart, so a stolen drive')).toBe('two halves of the key apart'.length);
    expect(continuation.overlapLength(prev, '  halves of the key apart and')).toBe('  halves of the key apart'.length);
    expect(continuation.overlapLength(prev, ', so a stolen drive')).toBe(0);
    // Shorter than SEAM_MIN is not a repeat ("apart" happening twice is English).
    expect(continuation.overlapLength(prev, 'apart from that')).toBe(0);
  });

  it('restartedLength: the cut-off sentence written again from its start', () => {
    const prev = 'First point is done. The second point is that the operator';
    const head = 'The second point is that the operator keeps the key offline.';
    expect(continuation.restartedLength(prev, head)).toBe('The second point is that the operator'.length);
    expect(continuation.restartedLength(prev, ' keeps the key offline.')).toBe(0);
  });

  it('stripPreamble: "Continuing:" and "Sure, here is the rest:" are dropped', () => {
    expect(continuation.stripPreamble('Continuing: the rest')).toBe('the rest');
    expect(continuation.stripPreamble('(continued) the rest')).toBe('the rest');
    expect(continuation.stripPreamble('Sure, here is the rest: the rest')).toBe('the rest');
    expect(continuation.stripPreamble('Continue reading')).toBe('Continue reading');
  });

  it('a continuation that starts with the word "continued" as part of the answer keeps it', () => {
    // Review 2026-10-03: the preamble rule cut the word wherever it started a
    // part ("The project was" + " continued by the team" lost "continued").
    const stitch = (prev, head) => {
      const out = [];
      const seam = continuation.createSeam(prev, { onText: (t) => out.push(t) });
      seam.push(head);
      seam.end();
      return prev + out.join('');
    };
    expect(stitch('The project was', ' continued by the team in 2020.')).toBe('The project was continued by the team in 2020.');
    expect(stitch('The work went on and ', 'continuing education is part of it.')).toBe('The work went on and continuing education is part of it.');
    expect(stitch('the samples were', ' continuedly improving.')).toBe('the samples were continuedly improving.');
    expect(continuation.stripPreamble('Continued — the rest')).toBe('the rest');
    expect(continuation.stripPreamble('[continuing] the rest')).toBe('the rest');
    expect(continuation.stripPreamble('continued by the team')).toBe('continued by the team');
  });

  it('createSeam holds the head, then streams straight through', () => {
    const out = [];
    const seam = continuation.createSeam('alpha beta gamma delta epsilon', { onText: (t) => out.push(t), hold: 50 });
    seam.push('Continuing: gamma delta ');
    seam.push('epsilon zeta eta');
    expect(out).toEqual([]);
    seam.push(' theta iota');
    expect(out).toEqual([' zeta eta theta iota']);
    seam.push(' kappa');
    seam.end();
    expect(out.join('')).toBe(' zeta eta theta iota kappa');
  });

  // Review 2026-10-03 (round 2): a restart shorter than SEAM_MIN showed the
  // sentence twice, glued ("The firstThe first half"); a list item's "1. "
  // was read as a sentence end.
  const seamOf = (prev, head, chunk = 0) => {
    const out = [];
    const seam = continuation.createSeam(prev, { onText: (t) => out.push(t) });
    if (chunk) { for (let i = 0; i < head.length; i += chunk) seam.push(head.slice(i, i + chunk)); } else seam.push(head);
    seam.end();
    return prev + out.join('');
  };

  it('a short restarted sentence is not shown twice', () => {
    expect(seamOf('Keys are kept in two halves. The first', 'The first half lives in secrets/.'))
      .toBe('Keys are kept in two halves. The first half lives in secrets/.');
    expect(seamOf('Steps:\n1. Open the', '1. Open the vault.\n2. Read.')).toBe('Steps:\n1. Open the vault.\n2. Read.');
    expect(seamOf('Steps:\n- Open the', '- Open the vault.\n- Read.')).toBe('Steps:\n- Open the vault.\n- Read.');
    // A genuine mid-word continuation is left alone.
    expect(seamOf('It lives in sec', 'rets/ on this computer.')).toBe('It lives in secrets/ on this computer.');
    // Three characters is not a restart ("The" twice is English).
    expect(continuation.restartedLength('Done. The', 'The end.')).toBe(0);
  });

  it('a restarted paragraph longer than the first 200 characters is not shown twice', () => {
    const para = 'The long paragraph sentence one is here. '.repeat(8);
    const out = seamOf(`Intro.\n${para}And the cut`, `${para}And the cut off sentence ends.\nNext line.`, 7);
    expect(out).toBe(`Intro.\n${para}And the cut off sentence ends.\nNext line.`);
  });

  it('a continuation that rightly starts with a line equal to the last whole line keeps it', () => {
    expect(seamOf('Items:\n- [ ] TODO item\n- [ ] TODO item\n', '- [ ] TODO item\n- [ ] done item\n'))
      .toBe('Items:\n- [ ] TODO item\n- [ ] TODO item\n- [ ] TODO item\n- [ ] done item\n');
  });

  it('stripPreamble: the common long preambles are dropped too', () => {
    expect(continuation.stripPreamble('Continuing from where I left off: the rest')).toBe('the rest');
    expect(continuation.stripPreamble('Here is the continuation:\nthe rest')).toBe('the rest');
    expect(continuation.stripPreamble("Here's the rest of the answer: the rest")).toBe('the rest');
    expect(continuation.stripPreamble('Here is the rest of the config file you asked for.')).toBe('Here is the rest of the config file you asked for.');
  });

  it('clampParts: 0 to 8, default 4', () => {
    expect(continuation.clampParts(undefined)).toBe(4);
    expect(continuation.clampParts('x')).toBe(4);
    expect(continuation.clampParts(-3)).toBe(0);
    expect(continuation.clampParts(20)).toBe(8);
    expect(continuation.clampParts(2)).toBe(2);
  });
});

describe('runAgentTurn — continuation over a scripted stream', () => {
  const callOpts = { provider: 'local', model: 'agent-model', localOnly: true, localOnlyReason: 'r', localOnlyRemedy: 'm' };

  it('truncated 3x then stops → one answer, no duplicated seam text, parts 4, three continue events', async () => {
    const f = fakeStream([
      { tokens: ['One two three four ', 'five six seven eight'], truncated: true, provider: 'openrouter', model: 'free-a', fallback: true },
      // Repeats its tail ("five six seven eight") before carrying on.
      { tokens: ['five six seven eight', ' nine ten eleven twelve'], truncated: true },
      { tokens: ['Continuing: ', ' thirteen fourteen'], truncated: true },
      { tokens: [' fifteen. Done.'] },
    ]);
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'count' }], callOpts, emit: c.emit });
    expect(r.text).toBe('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen. Done.');
    expect(c.tokens()).toBe(r.text);
    expect(r).toMatchObject({ parts: 4, continued: 3, truncated: false, cancelled: false });
    expect(c.of('continue')).toEqual([
      { part: 2, max: 5, reason: 'max_tokens' },
      { part: 3, max: 5, reason: 'max_tokens' },
      { part: 4, max: 5, reason: 'max_tokens' },
    ]);
    // Round 1 was a fallback: every continuation stays on the round-1
    // provider/model (resolved through the registry), with the agent's privacy.
    expect(f.calls).toHaveLength(4);
    for (const call of f.calls.slice(1)) {
      expect(call.opts).toMatchObject({ provider: 'openrouter', model: 'free-a', _pinnedRound: true, localOnly: true });
    }
    expect(f.calls[0].opts).toMatchObject({ localOnly: true });
    // The model sees its own answer so far as ONE assistant turn, then the ask.
    const last = f.calls[3].messages;
    expect(last.at(-1)).toEqual({ role: 'user', content: continuation.CONTINUE_PROMPT });
    expect(last.at(-2).role).toBe('assistant');
    expect(last.at(-2).content).toBe('One two three four five six seven eight nine ten eleven twelve thirteen fourteen');
    expect(last.filter((m) => m.content === continuation.CONTINUE_PROMPT)).toHaveLength(1);
  });

  it('budget exhausted → truncated with the exhausted reason', async () => {
    const f = fakeStream([{ tokens: ['abc '], truncated: true }]);
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], emit: c.emit, continueParts: 2 });
    expect(r).toMatchObject({ parts: 3, continued: 2, truncated: true });
    expect(r.truncationReason).toBe('The answer was continued 2 times and still reached the model\'s output limit. Type "continue" for more.');
    expect(f.calls).toHaveLength(3);
  });

  it('auto-continue off → one part, the provider\'s own reason', async () => {
    const f = fakeStream([{ tokens: ['abc'], truncated: true }]);
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], autoContinue: false });
    expect(r).toMatchObject({ parts: 1, continued: 0, truncated: true, truncationReason: 'max_tokens' });
    expect(f.calls).toHaveLength(1);
  });

  it('a cancelled part is never continued', async () => {
    const ctl = new AbortController();
    const f = fakeStream([{ tokens: ['abc', 'def'], truncated: true, onCall: () => ctl.abort() }]);
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], signal: ctl.signal });
    expect(r.cancelled).toBe(true);
    expect(r.truncated).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it('a provider that sends no finish reason (not truncated) is never continued', async () => {
    const f = fakeStream([{ tokens: ['cut mid'] }]);
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }] });
    expect(r.parts).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
});

// ── Through the REAL services/ai.js and the REAL chat-stream route ────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_PATH = path.join(ROOT, 'src', 'kernel', 'endpoints.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');
const STREAM_PATH = path.join(ROOT, 'src', 'blocks', 'dashboard', 'api', 'chat-stream.cjs');

describe('through the real kernel: finish_reason "length" then "stop" → one stitched answer over SSE', () => {
  const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-autocontinue-'));
  const savedCache = {};
  const savedEnv = {};
  const servers = [];
  const seen = [];
  let apiPort;
  let tmpVault;
  let savedSecrets;
  let savedKernel;
  const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
  const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(s.address().port); }); });
  const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`);

  beforeAll(async () => {
    savedSecrets = process.env.AEON_SECRETS_DIR;
    savedKernel = process.env.AEON_KERNEL_URL;
    process.env.AEON_SECRETS_DIR = tempSecrets;
    for (const p of [ENDPOINTS_PATH, AI_PATH, LR_PATH, STREAM_PATH]) { savedCache[p] = require.cache[p]; delete require.cache[p]; }
    for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }

    const fake = express();
    fake.use(express.json());
    fake.post('/v1/chat/completions', (req, res) => {
      seen.push(req.body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (seen.length === 1) {
        sse(res, 'The key is split in two halves ');
        sse(res, 'that live apart', 'length');
      } else {
        // The model repeats its tail before carrying on.
        sse(res, 'halves that live apart');
        sse(res, ', so one stolen file opens nothing.', 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const fakePort = await listen(fake);
    fs.writeFileSync(path.join(tempSecrets, 'aeon-endpoints.json'), JSON.stringify({
      endpoints: [{ id: 'fake', provider: 'custom', base_url: `http://127.0.0.1:${fakePort}/v1`, auth_ref: null, reachable_from: ['local'], models: ['fake-model'] }],
      roles: { chat: { endpoint_id: 'fake', model: 'fake-model' } },
    }));
    require(ENDPOINTS_PATH);
    require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: {
      isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [], status: () => ({ available: false }),
      plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
    } };
    const loadSettings = () => ({ models: { chat: { provider: 'custom', model: 'fake-model' } }, prefs: {} });
    const ai = require(AI_PATH)({
      supabase: null, writeOSAudit: () => {}, loadSettings, aeonTerminalStream: null,
      TOKEN_LEDGER_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-autocontinue-ledger-')), 'l.json'),
    });
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-autocontinue-vault-'));
    const app = express();
    app.use(express.json());
    app.post('/api/crn/second-brain/retrieve', (_req, res) => res.json({ documents: [] }));
    app.use('/api', require(STREAM_PATH)({ kernelLLM: ai.kernelLLM, loadSettings, VAULT_ROOT: tmpVault }));
    apiPort = await listen(app);
    process.env.AEON_KERNEL_URL = `http://127.0.0.1:${apiPort}`;
  });

  afterAll(() => {
    for (const s of servers) { try { s.close(); } catch {} }
    for (const p of Object.keys(savedCache)) { if (savedCache[p]) require.cache[p] = savedCache[p]; else delete require.cache[p]; }
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
    if (savedSecrets === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecrets;
    if (savedKernel === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernel;
    for (const d of [tempSecrets, tmpVault]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('streams one answer and reports the parts', async () => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'how is the key kept?' }),
    });
    const events = (await r.text()).split('\n\n').filter(Boolean).map((b) => ({
      event: /event: (.*)/.exec(b)?.[1], data: JSON.parse(/data: (.*)/.exec(b)?.[1] || 'null'),
    }));
    const tokens = events.filter((e) => e.event === 'token').map((e) => e.data.t).join('');
    const done = events.find((e) => e.event === 'done').data;
    expect(tokens).toBe('The key is split in two halves that live apart, so one stolen file opens nothing.');
    expect(done.text).toBe(tokens);
    expect(done).toMatchObject({ parts: 2, continued: 1, truncated: false, provider: 'custom', model: 'fake-model' });
    expect(events.filter((e) => e.event === 'continue').map((e) => e.data)).toEqual([{ part: 2, max: 5, reason: 'max_tokens' }]);
    expect(events.find((e) => e.event === 'meta' && 'autoContinue' in e.data).data.autoContinue).toEqual({ on: true, maxParts: 4 });
    expect(seen).toHaveLength(2);
    expect(seen[1].messages.at(-1)).toEqual({ role: 'user', content: continuation.CONTINUE_PROMPT });
    expect(seen[1].messages.at(-2)).toEqual({ role: 'assistant', content: 'The key is split in two halves that live apart' });
    expect(seen[1].model).toBe('fake-model');
  });
});
