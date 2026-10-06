/**
 * The operator's requests-per-minute limit, on the wire.
 *
 * Before: only the generic "custom" provider paced at all. Gemini and Claude
 * streamed unpaced, so a limit the operator set on them would have changed
 * nothing in the terminal, and when AEON did have to give up waiting
 * (pace() throws err.localThrottle) nothing read the flag: the failover rested
 * the whole provider after three in a row, printed "gemini unavailable", and
 * told the operator to "add a key or credits".
 *
 * These drive the REAL services/ai.js against fake providers on 127.0.0.1 (and
 * a stubbed fetch for the two Anthropic transports, whose host is fixed). Only
 * the clock is faked, so a per-minute limit is proved without a minute passing.
 * The limits used here (1, 2) belong to no provider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const PACING_PATH = path.join(ROOT, 'src', 'kernel', 'pacing.cjs');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pacing-failover-'));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pacing-failover-ledger-'));
const savedSecretsDir = process.env.AEON_SECRETS_DIR;
const savedMaster = process.env.AEON_VAULT_MASTER_KEY;
process.env.AEON_SECRETS_DIR = tempSecrets;
process.env.AEON_VAULT_MASTER_KEY = 'pacing-failover-suite-key';
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const savedCache = {};
for (const p of [ENDPOINTS_PATH, VAULT_PATH, POOL_PATH, PACING_PATH, AI_PATH, LR_PATH]) {
  savedCache[p] = require.cache[p];
  delete require.cache[p];
}
const KEY_RE = /^(GROQ_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GROK_API_KEY|GEMINI_PAID_KEY|GEMINI_API_KEY|GEMINI_FREE_KEY_\d+)(_\d+)?$/;
const savedEnv = {};
for (const k of Object.keys(process.env)) {
  if (KEY_RE.test(k)) { savedEnv[k] = process.env[k]; delete process.env[k]; }
}

// Local fakes pass through; the Anthropic host answers from here; everything
// else is refused. Nothing leaves this machine.
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
let anthropicHits = 0;
globalThis.fetch = (url, init) => {
  const u = new URL(typeof url === 'string' ? url : url.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, init);
  if (u.hostname === 'api.anthropic.com') {
    anthropicHits++;
    const body = JSON.parse(init.body);
    if (body.stream) {
      const sse = [
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'claude streamed' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return Promise.resolve(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: 'claude answered' }], usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ error: { message: 'stubbed: no network in tests' } }), { status: 503 }));
};

// ── fake providers ────────────────────────────────────────────────────
let geminiHits = 0;
let customHits = 0;
let groqHits = 0;
const gemini = express();
gemini.use(express.json());
gemini.post(/:(stream)?[gG]enerateContent$/, (req, res) => {
  geminiHits++;
  if (/streamGenerateContent$/.test(req.path)) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini streamed' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } })}\n\n`);
    return res.end();
  }
  return res.json({ candidates: [{ content: { parts: [{ text: 'gemini answered' }] } }], usageMetadata: { totalTokenCount: 5 } });
});
const openai = (counter, word) => {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    counter();
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} streamed` }, finish_reason: 'stop' }], usage: { total_tokens: 4 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.json({ choices: [{ message: { content: `${word} answered` } }], usage: { total_tokens: 4 } });
  });
  return app;
};

const lrStub = {
  isAvailable: () => false, defaultModel: () => null, listReadyModels: () => [],
  status: () => ({ available: false, readyModels: [] }),
  plannedContext: async () => ({ contextTokens: 8192 }), cancelAll: () => 0,
  infer: async () => { throw new Error('no local runtime in this test'); },
  inferStream: async () => { throw new Error('no local runtime in this test'); },
};

const servers = [];
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }); });

let ai;
let pacing;
let endpoints;
let ports;
const logLines = [];
let settings = { models: { chat: { provider: 'gemini', model: 'gemini-flash-latest' } }, prefs: {} };

const writeRegistry = (rows, roles) => fs.writeFileSync(REG_FILE, JSON.stringify({ endpoints: rows, roles }, null, 2));
const geminiRow = (rpm_limit) => ({
  id: 'gem', provider: 'gemini', label: 'Gemini', base_url: `http://127.0.0.1:${ports.gemini}/v1beta`,
  auth_ref: 'gem-k1', auth_refs: ['gem-k1'], reachable_from: ['local'], models: ['gemini-flash-latest'], rpm_limit,
});
const groqRow = () => ({
  id: 'grq', provider: 'groq', label: 'Groq', base_url: `http://127.0.0.1:${ports.groq}/v1`,
  auth_ref: 'grq-k1', auth_refs: ['grq-k1'], reachable_from: ['local'], models: ['openai/gpt-oss-120b'], rpm_limit: 0,
});
const customRow = (rpm_limit) => ({
  id: 'cus', provider: 'custom', label: 'Mine', base_url: `http://127.0.0.1:${ports.custom}/v1`,
  auth_ref: 'cus-k1', auth_refs: ['cus-k1'], reachable_from: ['local'], models: ['m'], rpm_limit,
});
const claudeRow = (rpm_limit) => ({
  id: 'cla', provider: 'claude', label: 'Claude', base_url: 'https://api.anthropic.com/v1',
  auth_ref: 'cla-k1', auth_refs: ['cla-k1'], reachable_from: ['local'], models: ['claude-sonnet-5'], rpm_limit,
});
const use = (rows, provider, model) => {
  writeRegistry(rows, { chat: { endpoint_id: rows[0].id, model } });
  settings = { models: { chat: { provider, model } }, prefs: {} };
};

beforeAll(async () => {
  ports = { gemini: await listen(gemini), custom: await listen(openai(() => customHits++, 'custom')), groq: await listen(openai(() => groqHits++, 'groq')) };
  const vault = require(VAULT_PATH);
  for (const ref of ['gem-k1', 'gem-k2', 'grq-k1', 'cus-k1', 'cla-k1']) await vault.setSecret(ref, `test-only-${ref}`);
  endpoints = require(ENDPOINTS_PATH);
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: lrStub };
  pacing = require(PACING_PATH);
  ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ledgerDir, 'token_ledger.json'),
    loadSettings: () => settings,
    aeonTerminalStream: { emit: (_t, e) => logLines.push(e?.message || '') },
  });
  await ai.envHydrated;
});

beforeEach(() => {
  require(POOL_PATH)._reset();
  pacing._reset();
  ai._resetProviderHealth?.();
  geminiHits = customHits = groqHits = anthropicHits = 0;
  logLines.length = 0;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => { vi.useRealTimers(); });

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const s of servers) { try { s.close(); } catch {} }
  for (const [p, mod] of Object.entries(savedCache)) {
    if (mod) require.cache[p] = mod; else delete require.cache[p];
  }
  for (const k of Object.keys(process.env)) if (KEY_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (savedSecretsDir === undefined) delete process.env.AEON_SECRETS_DIR; else process.env.AEON_SECRETS_DIR = savedSecretsDir;
  if (savedMaster === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedMaster;
  for (const d of [tempSecrets, ledgerDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

// Run a call to completion while the faked clock moves on: a paced call sleeps
// on setTimeout, so the real event loop alone would never wake it. Real
// network time still passes between steps (realSetTimeout), so a fake server
// answers; `stepMs` is how much faked time each step adds (0 = a call that
// should not be delayed at all).
const nap = (ms = 5) => new Promise((r) => realSetTimeout(r, ms));
const settle = async (promise, stepMs = 1000) => {
  let done = false;
  let out;
  let failure;
  promise.then((v) => { out = v; done = true; }, (e) => { failure = e; done = true; });
  const deadline = performance.now() + 15_000;
  while (!done && performance.now() < deadline) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await nap();
  }
  if (!done) throw new Error('the call never finished');
  if (failure) throw failure;
  return out;
};
const idle = async (ms) => { await vi.advanceTimersByTimeAsync(ms); await nap(); };

const stream = (extra = {}) => {
  const notices = [];
  const tokens = [];
  const run = () => ai.kernelLLMStream([{ role: 'user', content: 'hello' }], { role: 'chat', onToken: (t) => tokens.push(t), onNotice: (m) => notices.push(m), ...extra });
  return { run, notices, tokens };
};
const WAIT = /pacing: waiting \d+s for (\w+) \(your limit: (\d+)\/min/;

describe('a limit the operator set actually paces the transport', () => {
  it('Gemini, streamed: the call over the limit waits, says so, and runs after the window', async () => {
    use([geminiRow(2)], 'gemini', 'gemini-flash-latest');
    for (let i = 0; i < 2; i++) await settle(stream().run(), 0);
    // The first two went straight through.
    expect(geminiHits).toBe(2);

    const third = stream();
    let finished = false;
    const p = third.run().then((r) => { finished = true; return r; });
    await idle(20_000);
    expect(finished, 'a third call inside the minute was not delayed').toBe(false);
    expect(geminiHits, 'the provider saw a third request inside the window').toBe(2);
    expect(third.notices.join('\n')).toMatch(/pacing: waiting \d+s for gemini \(your limit: 2\/min/);
    // The same line reaches the system log feed.
    expect(logLines.join('\n')).toMatch(WAIT);

    const r = await settle(p);
    expect(String(r.text)).toBe('gemini streamed');
    expect(geminiHits).toBe(3);
  });

  it('Gemini, blocking: the same limit applies to a non-streaming call', async () => {
    use([geminiRow(2)], 'gemini', 'gemini-flash-latest');
    for (let i = 0; i < 2; i++) await settle(ai.kernelLLM(`q${i}`, { role: 'chat' }), 0);
    expect(geminiHits).toBe(2);
    let finished = false;
    const notices = [];
    const p = ai.kernelLLM('q3', { role: 'chat', onNotice: (m) => notices.push(m) }).then((t) => { finished = true; return t; });
    await idle(20_000);
    expect(finished).toBe(false);
    expect(geminiHits).toBe(2);
    expect(notices.join('\n')).toMatch(WAIT);
    expect(await settle(p)).toBe('gemini answered');
  });

  it('a generic OpenAI-compatible endpoint, streamed', async () => {
    use([customRow(1)], 'custom', 'm');
    await settle(stream().run(), 0);
    const second = stream();
    let finished = false;
    const p = second.run().then((r) => { finished = true; return r; });
    await idle(10_000);
    expect(finished).toBe(false);
    expect(customHits).toBe(1);
    expect(second.notices.join('\n')).toMatch(/pacing: waiting \d+s for custom \(your limit: 1\/min/);
    await settle(p);
    expect(customHits).toBe(2);
  });

  it('Claude, streamed and blocking: both were unpaced before', async () => {
    use([claudeRow(1)], 'claude', 'claude-sonnet-5');
    await settle(stream().run(), 0);
    expect(anthropicHits).toBe(1);
    const s = stream();
    let streamed = false;
    const ps = s.run().then((r) => { streamed = true; return r; });
    await idle(10_000);
    expect(streamed, 'streamClaude ignored the limit').toBe(false);
    expect(anthropicHits).toBe(1);
    expect(s.notices.join('\n')).toMatch(/pacing: waiting \d+s for claude \(your limit: 1\/min/);
    await settle(ps);
    expect(anthropicHits).toBe(2);

    // The window is full again (the streamed call just took the slot).
    let blocked = false;
    const pb = ai.kernelLLM('q', { role: 'chat' }).then((t) => { blocked = true; return t; });
    await idle(10_000);
    expect(blocked, 'claudeRequest ignored the limit').toBe(false);
    expect(anthropicHits).toBe(2);
    expect(await settle(pb)).toBe('claude answered');
  });

  it('limit 0 and no limit never wait', async () => {
    use([geminiRow(0)], 'gemini', 'gemini-flash-latest');
    for (let i = 0; i < 6; i++) {
      const s = stream();
      await settle(s.run(), 0);
      expect(s.notices).toEqual([]);
    }
    expect(geminiHits).toBe(6);
    use([geminiRow(null)], 'gemini', 'gemini-flash-latest');
    await settle(stream().run(), 0);
    expect(geminiHits).toBe(7);
  });

  it('Stop during a wait ends it at once, with no request sent', async () => {
    use([geminiRow(1)], 'gemini', 'gemini-flash-latest');
    await settle(stream().run(), 0);
    const ac = new AbortController();
    const s = stream({ signal: ac.signal });
    const p = s.run();
    await idle(5_000);
    ac.abort();
    const r = await settle(p);
    expect(r.cancelled).toBe(true);
    expect(geminiHits).toBe(1);
  });
});

describe('a change in Settings applies to the next call, no restart', () => {
  it('raising the limit through the registry frees the next call', async () => {
    use([geminiRow(1)], 'gemini', 'gemini-flash-latest');
    await settle(stream().run(), 0);
    // The operator raises it (what POST /api/connections/gem/rpm does).
    await endpoints.setRpmLimit('gem', 5);
    const s = stream();
    await settle(s.run(), 0);
    expect(s.notices).toEqual([]);
    expect(geminiHits).toBe(2);
  });
});

describe('when AEON gives up waiting, that is the operator\'s limit, not an outage', () => {
  // pace() gives up only when the bucket fills again while a caller waits (a
  // burst). Simulated by taking the slot the waiter was waiting for.
  const key = () => pacing.paceKey(`http://127.0.0.1:${ports.gemini}/v1beta`, 'gemini', 'gem-k1');

  const giveUpOnce = async (s) => {
    pacing._reset();
    await pacing.pace(key(), 1000);   // the one slot is taken, a moment ago
    const p = s.run();
    await idle(3_000);
    await pacing.pace(key(), 1000);   // another caller takes the slot this one was waiting for
    return settle(p);
  };

  it('moves to the next provider and names the setting; the provider is not rested', async () => {
    writeRegistry([geminiRow(1), groqRow()], { chat: { endpoint_id: 'gem', model: 'gemini-flash-latest' } });
    settings = { models: { chat: { provider: 'gemini', model: 'gemini-flash-latest' } }, prefs: {} };

    const reasons = [];
    // Four in a row: more than the three consecutive failures that rest a provider.
    for (let i = 0; i < 4; i++) {
      const s = stream({ onFallback: (f) => reasons.push(f.reason) });
      const r = await giveUpOnce(s);
      expect(r.provider, `round ${i}: should have been answered by the next provider`).toBe('groq');
      expect(String(r.text)).toBe('groq streamed');
    }
    expect(geminiHits, 'gemini was never asked').toBe(0);
    expect(groqHits).toBe(4);
    for (const reason of reasons) {
      expect(reason).toMatch(/at your limit of 1 requests\/min \(Settings → Keys\)/);
      expect(reason).not.toMatch(/unavailable|failing repeatedly/);
    }
    expect(ai.getProviderHealth?.().gemini?.blockedUntil || 0, 'gemini was rested as if it were down').toBeLessThanOrEqual(Date.now());
    expect(logLines.join('\n')).not.toMatch(/resting|failing repeatedly/);
  });

  it('the blocking chain says the same in its notice', async () => {
    writeRegistry([geminiRow(1), groqRow()], { chat: { endpoint_id: 'gem', model: 'gemini-flash-latest' } });
    settings = { models: { chat: { provider: 'gemini', model: 'gemini-flash-latest' } }, prefs: {} };
    pacing._reset();
    await pacing.pace(key(), 1000);
    const p = ai.kernelLLM('second', { role: 'chat' });
    await idle(3_000);
    await pacing.pace(key(), 1000);
    expect(await settle(p)).toBe('groq answered');
    expect(logLines.join('\n')).toMatch(/gemini at your limit of 1 requests\/min \(Settings → Keys\) — trying the next provider/);
    expect(logLines.join('\n')).not.toMatch(/gemini unavailable/);
  });

  it('with nowhere to go, the error names the setting, not "add a key or credits"', async () => {
    use([geminiRow(1)], 'gemini', 'gemini-flash-latest');
    const err = await giveUpOnce(stream()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/gemini is at your limit of 1 requests\/min/);
    expect(err.message).toMatch(/Raise or clear the requests-per-minute limit on gemini in Settings → Keys/);
    expect(err.message).not.toMatch(/Add a key or credits/);
    expect(err.rateLimited).toBe(true);
    expect(err.retryable).toBe(true);
  });
});

// ── review round: what the first pass left open ───────────────────────

// The first slot of this connection's credential, taken a moment ago, and the
// second taken while a caller waits for it: the shape of a burst, after which
// pace() gives up (see giveUpOnce above).
const burstKey = (base, provider, ref) => pacing.paceKey(base, provider, ref);

describe('the limit is not a key\'s fault: no rotation to the next key', () => {
  it('a limit of 429 (a number that reads like an HTTP status) still does not rotate', async () => {
    const two = { ...geminiRow(429), auth_ref: 'gem-k1', auth_refs: ['gem-k1', 'gem-k2'] };
    writeRegistry([two, groqRow()], { chat: { endpoint_id: 'gem', model: 'gemini-flash-latest' } });
    settings = { models: { chat: { provider: 'gemini', model: 'gemini-flash-latest' } }, prefs: {} };
    pacing._reset();
    const key = burstKey(`http://127.0.0.1:${ports.gemini}/v1beta`, 'gemini', 'gem-k1');
    for (let i = 0; i < 429; i++) await pacing.pace(key, 1000);   // the key's whole minute, spent
    const s = stream();
    const p = s.run();
    await idle(3_000);
    // Other callers spend the next minute's budget too, so the wait cannot end.
    for (let i = 0; i < 429; i++) await pacing.pace(key, 1000);
    const r = await settle(p);
    expect(logLines.join('\n')).not.toMatch(/switching to key|rotated to key/);
    expect(geminiHits, 'the limit was read as a bad key and the request went out on another').toBe(0);
    expect(r.provider).toBe('groq');
  });
});

describe('Claude assigned in Settings: the legacy branch cannot bypass the limit', () => {
  it('after the registry gave up on the limit, Claude is not called again unpaced', async () => {
    use([claudeRow(1)], 'claude', 'claude-sonnet-5');
    // The legacy branch would find this key; the bug sent the request with it.
    process.env.ANTHROPIC_API_KEY = 'test-only-legacy-claude';
    try {
      const key = burstKey('https://api.anthropic.com/v1', 'claude', 'cla-k1');
      pacing._reset();
      await pacing.pace(key, 1000);
      const p = ai.kernelLLM('second', { role: 'chat' }).catch((e) => e);
      await idle(3_000);
      await pacing.pace(key, 1000);
      const err = await settle(p);
      expect(anthropicHits, 'a request went out past the operator\'s limit').toBe(0);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/claude is at your limit of 1 requests\/min/);
      // One line about the limit; no "trying the next provider" followed by Claude again.
      const trying = logLines.filter((l) => /claude .*trying the next provider/.test(l));
      expect(trying.length).toBeLessThanOrEqual(1);
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });
});

describe('the closing step names the limit even when a local floor failed too', () => {
  it('a limit plus a local runtime with no chat model ends on the limit\'s remedy', async () => {
    const saved = { isAvailable: lrStub.isAvailable, infer: lrStub.infer };
    lrStub.isAvailable = () => true;
    lrStub.infer = async () => { throw new Error('No local model is installed'); };
    try {
      use([geminiRow(1)], 'gemini', 'gemini-flash-latest');
      const key = burstKey(`http://127.0.0.1:${ports.gemini}/v1beta`, 'gemini', 'gem-k1');
      pacing._reset();
      await pacing.pace(key, 1000);
      const p = ai.kernelLLM('second', { role: 'chat' }).catch((e) => e);
      await idle(3_000);
      await pacing.pace(key, 1000);
      const err = await settle(p);
      expect(err.message).toMatch(/gemini is at your limit of 1 requests\/min/);
      expect(err.message).toMatch(/Raise or clear the requests-per-minute limit on gemini in Settings → Keys/);
      expect(err.message, 'the closing step sent the operator to keys and credits').not.toMatch(/Check the local model|add a key or credits/i);
    } finally { Object.assign(lrStub, saved); }
  });
});

describe('the notice is one line per burst, and never swallowed by a caller who could not show it', () => {
  const take = async () => {
    use([geminiRow(1)], 'gemini', 'gemini-flash-latest');
    await settle(stream().run(), 0); // the one slot of this minute
  };

  it('a background call with no notice channel does not silence the next chat turn', async () => {
    await take();
    const ac = new AbortController();
    const bg = ai.kernelLLM('index this', { role: 'chat', signal: ac.signal }).catch(() => null); // no onNotice
    await idle(2_000);
    const chat = stream({ signal: ac.signal });
    const pc = chat.run();
    await idle(2_000);
    expect(chat.notices.join('\n'), 'the chat paused with no explanation').toMatch(WAIT);
    ac.abort();
    await settle(bg); await settle(pc);
  });

  it('two chat streams each hear about their own wait', async () => {
    await take();
    const ac = new AbortController();
    const a = stream({ signal: ac.signal });
    const b = stream({ signal: ac.signal });
    const pa = a.run(); const pb = b.run();
    await idle(2_000);
    expect(a.notices.join('\n')).toMatch(WAIT);
    expect(b.notices.join('\n')).toMatch(WAIT);
    ac.abort();
    await settle(pa); await settle(pb);
  });

  it('a burst through one channel prints one line, and prints again once the window has passed', async () => {
    await take();
    const ac = new AbortController();
    const notices = [];
    const onNotice = (m) => notices.push(m);
    const run = () => ai.kernelLLM('q', { role: 'chat', signal: ac.signal, onNotice }).catch(() => null);
    const burst = [run(), run(), run()];
    await idle(3_000);
    expect(notices, 'three waiting calls printed a line each').toHaveLength(1);
    await idle(12_000);
    const later = run();
    await idle(1_000);
    expect(notices, 'a wait ten seconds later should be announced again').toHaveLength(2);
    ac.abort();
    await settle(Promise.all([...burst, later]));
  });
});
