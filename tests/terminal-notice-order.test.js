/**
 * A fallback notice reads ABOVE the answer it explains (CEO screenshot,
 * 2026-09-30 20:55).
 *
 * The terminal pushed the answer's bubble first and appended each notice as
 * it arrived, so when every provider failed the screen read: the error
 * ("No provider could answer right now — …"), THEN "↪ openrouter out of
 * credits → groq", THEN "↪ groq request too large for it → local" — the
 * causes under their own conclusion.
 *
 * The component cannot be rendered here (environment: 'node'), so the
 * placement is a pure function, tested here, and the last block checks the
 * component uses it. The route test checks the kernel's own words for a retry
 * on the same connection reach the terminal unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

import { insertBefore } from '../src/components/Terminal2.jsx';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal2.jsx'), 'utf8');
const STREAM_PATH = path.join(ROOT, 'src', 'blocks', 'dashboard', 'api', 'chat-stream.cjs');

describe('insertBefore — a notice goes above the entry it explains', () => {
  const feed = [
    { id: 1, type: 'msg', role: 'user', content: 'hi' },
    { id: 2, type: 'msg', role: 'assistant', content: '', streaming: true },
  ];

  it('lands between the question and the answer bubble', () => {
    const a = insertBefore(feed, 2, { id: 3, role: 'system', content: '↪ openrouter out of credits → groq' });
    const b = insertBefore(a, 2, { id: 4, role: 'system', content: '↪ groq request too large for it → local' });
    expect(b.map((e) => e.id)).toEqual([1, 3, 4, 2]);
  });

  it('the answer bubble, patched into an error later, still reads after its causes', () => {
    const withNotice = insertBefore(feed, 2, { id: 3, role: 'system', content: '↪ groq request too large for it → local' });
    const failed = withNotice.map((e) => (e.id === 2 ? { ...e, role: 'error', content: 'No provider could answer right now — …', streaming: false } : e));
    expect(failed.map((e) => e.role)).toEqual(['user', 'system', 'error']);
  });

  it('with no such entry the notice goes at the end, and the feed is never mutated', () => {
    const out = insertBefore(feed, 99, { id: 5 });
    expect(out.map((e) => e.id)).toEqual([1, 2, 5]);
    expect(feed.map((e) => e.id)).toEqual([1, 2]);
  });

  it('the terminal places fallback notices with it, before the streaming message', () => {
    expect(SRC).toMatch(/if \(payload\.notice\) pushBefore\(msgId, \{ type: 'msg', role: 'system'/);
    expect(SRC).not.toMatch(/if \(payload\.notice\) push\(\{/);
    expect(SRC).toMatch(/setFeed\(prev => insertBefore\(prev, beforeId,/);
  });
});

describe('POST /api/chat/stream relays the kernel\'s own notice', () => {
  let server;
  let tmpVault;
  const savedKernelUrl = process.env.AEON_KERNEL_URL;
  const savedCache = require.cache[STREAM_PATH];

  beforeAll(async () => {
    delete require.cache[STREAM_PATH];
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-notice-order-vault-'));
    const kernelLLM = async () => '';
    kernelLLM.describeRole = async () => ({ provider: 'openrouter', model: 'anthropic/claude-opus-4.6', contextTokens: 8192 });
    kernelLLM.stream = async (_messages, o) => {
      o.onAttempt?.({ provider: 'openrouter', model: 'anthropic/claude-opus-4.6', fallback: false });
      o.onFallback?.({
        from: 'openrouter', to: 'openrouter', model: 'openrouter/free', reason: 'out of credits',
        notice: 'openrouter (anthropic/claude-opus-4.6) out of credits → openrouter free model',
      });
      o.onFallback?.({ from: 'openrouter', to: 'groq', model: 'openai/gpt-oss-120b', reason: 'rate-limited' });
      o.onToken('ok');
      return { text: 'ok', tokens: 1, latencyMs: 1, provider: 'groq', model: 'openai/gpt-oss-120b' };
    };
    const app = express();
    app.use(express.json());
    app.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [] }));
    app.use('/api', require(STREAM_PATH)({
      kernelLLM, loadSettings: () => ({ models: {}, prefs: {} }), VAULT_ROOT: tmpVault, writeOSAudit() {}, _trackLLM() {},
    }));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    process.env.AEON_KERNEL_URL = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => {
    try { server.close(); } catch {}
    if (savedKernelUrl === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = savedKernelUrl;
    if (savedCache) require.cache[STREAM_PATH] = savedCache; else delete require.cache[STREAM_PATH];
    try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch {}
  });

  it('a same-connection retry keeps its words; a provider switch keeps the "from reason → to" line', async () => {
    const r = await fetch(`${process.env.AEON_KERNEL_URL}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
    });
    const text = await r.text();
    const notices = text.split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l.slice(6)).notice; } catch { return undefined; } })
      .filter(Boolean);
    expect(notices).toEqual([
      'openrouter (anthropic/claude-opus-4.6) out of credits → openrouter free model',
      'openrouter rate-limited → groq',
    ]);
  });
});
