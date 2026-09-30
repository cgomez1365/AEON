/**
 * Compare shows each pane's own model, or says it could not answer.
 *
 * Council's Compare asks the kernel for a NAMED provider per pane. When that
 * provider failed, the kernel's chain answered from the next provider, and
 * Compare showed that text under the pane's model: compared and voted on as
 * the wrong model's work (sweep follow-up to C35, older than it). callModel
 * now asks for returnMeta and reports a substitute instead of showing it.
 *
 * The real router, a stub kernelLLM; no model is asked anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const API = require.resolve('../src/blocks/council/api/index.cjs');

let scratch, server, base, asked;
beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-compare-'));
  asked = [];
  delete require.cache[API];
  const router = require(API)({
    getDataFile: (name) => { const p = path.join(scratch, name); fs.mkdirSync(p, { recursive: true }); return p; },
    // groq fails and the chain answers from local; gemini answers itself.
    kernelLLM: async (_prompt, opts) => {
      asked.push(opts);
      if (opts.provider === 'groq') return { text: 'the local model\'s words', provider: 'local', model: 'qwen3-1.7b', fallback: true };
      return opts.returnMeta ? { text: 'gemini\'s own words', provider: 'gemini', model: opts.model } : 'gemini\'s own words';
    },
    VAULT_ROOT: path.join(scratch, 'vault'),
    _endpoints: { load: async () => ({ endpoints: [], roles: {} }) },
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('POST /compare/start', () => {
  it('a pane whose provider failed shows no substitute\'s text, and says who answered instead', async () => {
    const r = await fetch(`${base}/compare/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Which is better?', is_blind: false, models: [
        { id: 'openai/gpt-oss-120b', engine: 'groq', name: 'GPT-OSS' },
        { id: 'gemini-2.5-flash', engine: 'gemini', name: 'Gemini' },
      ] }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    const panes = Object.fromEntries((body.panes || body.comparison?.panes || []).map((p) => [p.engine, p]));
    expect(panes.groq.text).toBe('');
    expect(panes.groq.error).toMatch(/groq could not answer; local\/qwen3-1\.7b answered instead/);
    expect(panes.gemini).toMatchObject({ text: 'gemini\'s own words', error: null });
    expect(asked.every((o) => o.returnMeta === true)).toBe(true);
  });
});
