/**
 * Writer — a rewrite the model cut off must never replace the document.
 *
 * Measured live 2026-09-23 (agent C2, stub model on the creative role that
 * answers finish_reason "length", the free-tier 1024-token cap):
 *
 *   POST /api/writer/improve { action: 'professional', text: <3 paragraphs> }
 *   → 200 { content: "…And the final recommendation is that you should" }
 *
 * The editor assigns `content` over the whole document, and autosave persists
 * it 2.5 s later. The operator's closing paragraphs were replaced by a
 * sentence that stops mid-way, with nothing on screen saying so. kernelLLM's
 * blocking call returns text only; its streaming form reports truncation, so
 * Writer asks that and refuses to hand back a cut-off rewrite of the
 * operator's own text. New content (write / continue) and feedback come back
 * flagged `truncated` so the editor can say so.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-trunc-'));
delete process.env.VERCEL;
const mountWriter = require_('../src/blocks/writer/api/writer.js');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

function appWith(answer, { withStream = true } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'w-'));
  const calls = [];
  const kernelLLM = async (prompt, opts) => { calls.push({ opts }); return (await answer()).text; };
  if (withStream) kernelLLM.stream = async (messages, opts) => { calls.push({ opts, stream: true, messages }); return answer(); };
  const app = express();
  app.use(express.json());
  mountWriter(app, { supabase: null, kernelLLM, getBlockDataFile: () => dir, VAULT_ROOT: path.join(dir, 'Vault') });
  return { app, calls };
}

function call(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(d) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload); req.end();
    });
  });
}

const CUT = async () => ({ text: '<p>Paragraph one, rewritten.</p><p>And the final recommendation is that you should', truncated: true, truncationReason: 'max_tokens' });
const WHOLE = async () => ({ text: '<p>All three paragraphs, rewritten.</p>', truncated: false });
const DOC = '<p>Paragraph one.</p><p>Paragraph two.</p><p>The important ending paragraph.</p>';

describe('a cut-off rewrite never replaces the operator\'s text', () => {
  it('improve refuses a truncated whole-document rewrite and says the document is unchanged', async () => {
    const { app } = appWith(CUT);
    const r = await call(app, '/api/writer/improve', { text: DOC, action: 'professional' });
    expect(r.status).toBe(502);
    expect(r.body.truncated).toBe(true);
    expect(r.body.content).toBeUndefined();
    expect(r.body.error).toMatch(/output limit/);
    expect(r.body.error).toMatch(/not changed/);
  });

  it('improve refuses a truncated selection rewrite too', async () => {
    const { app } = appWith(CUT);
    const r = await call(app, '/api/writer/improve', { text: DOC, action: 'shorten', selection: 'Paragraph two.' });
    expect(r.status).toBe(502);
    expect(r.body.truncated).toBe(true);
  });

  it('a brain-dump restructure that was cut off is refused — it would drop the operator\'s later ideas', async () => {
    const { app } = appWith(CUT);
    const r = await call(app, '/api/writer/generate', { mode: 'braindump', prompt: 'idea one, idea two, idea three' });
    expect(r.status).toBe(502);
    expect(r.body.truncated).toBe(true);
  });

  it('a whole rewrite still comes back as before', async () => {
    const { app, calls } = appWith(WHOLE);
    const r = await call(app, '/api/writer/improve', { text: DOC, action: 'professional' });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('<p>All three paragraphs, rewritten.</p>');
    expect(calls[0].stream).toBe(true);
    expect(calls[0].opts.role).toBe('creative');
  });
});

describe('new content and feedback come back flagged, not refused', () => {
  it('generate (write) returns the text with truncated: true', async () => {
    const { app } = appWith(CUT);
    const r = await call(app, '/api/writer/generate', { mode: 'write', prompt: 'a launch note' });
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.content).toMatch(/you should$/);
  });

  it('critique and co-write carry the flag', async () => {
    const { app } = appWith(CUT);
    const c = await call(app, '/api/writer/improve', { text: DOC, action: 'critique' });
    expect(c.status).toBe(200);
    expect(c.body.truncated).toBe(true);
    const w = await call(app, '/api/writer/cowrite', { prompt: 'How is the tone?', draft: 'We are moving the launch.' });
    expect(w.status).toBe(200);
    expect(w.body.truncated).toBe(true);
  });

  it('bounds the stream in time, and a rewrite stopped by the bound is refused like a cut-off one', async () => {
    const { app, calls } = appWith(async () => ({ text: '<p>Half a rewrite', cancelled: true }));
    const r = await call(app, '/api/writer/improve', { text: DOC, action: 'professional' });
    expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
    expect(r.status).toBe(502);
    expect(r.body.truncated).toBe(true);
  });

  it('with no streaming transport it behaves as before (truncation unknown)', async () => {
    const { app, calls } = appWith(WHOLE, { withStream: false });
    const r = await call(app, '/api/writer/improve', { text: DOC, action: 'professional' });
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBeUndefined();
    expect(calls[0].opts.role).toBe('creative');
  });
});

// CodeQL js/type-confusion-through-parameter-tampering (alert 186): JSON lets
// prompt/draft/tone/length/mode arrive as arrays. Refused, the model never called.
describe('Writer generate refuses non-string fields', () => {
  for (const field of ['prompt', 'draft', 'tone', 'length', 'mode']) {
    it(`${field} as an array → 400`, async () => {
      const { app, calls } = appWith(WHOLE);
      const r = await call(app, '/api/writer/generate', { prompt: 'a note', [field]: ['a', 'b'] });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(new RegExp(`${field} must be a string`));
      expect(calls.length).toBe(0);
    });
  }

  it('plain strings still work', async () => {
    const { app } = appWith(WHOLE);
    const r = await call(app, '/api/writer/generate', { mode: 'write', prompt: 'a note', tone: 'warm', length: 'short' });
    expect(r.status).toBe(200);
  });

  it('a JSON array body is read as no fields, not as its length', async () => {
    const { app, calls } = appWith(WHOLE);
    const r = await call(app, '/api/writer/generate', ['a', 'b', 'c']);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/prompt is required/);
    expect(calls.length).toBe(0);
  });
});

describe('critique strips script and style blocks in linear time', () => {
  const sentText = (calls) => JSON.stringify(calls.at(-1).messages);

  it('drops <script>/<style> blocks and keeps the prose around them', async () => {
    const { app, calls } = appWith(WHOLE);
    const text = '<p>Before.</p><STYLE type="x">p{color:red}</STYLE><p>Middle.</p><script>alert(1)</script><p>After.</p>';
    const r = await call(app, '/api/writer/improve', { text, action: 'critique' });
    expect(r.status).toBe(200);
    const sent = sentText(calls);
    expect(sent).toMatch(/Before\.[\s\S]*Middle\.[\s\S]*After\./);
    expect(sent).not.toMatch(/color:red|alert\(1\)/);
  });

  it('leaves no tag behind nested tags, and decodes each entity once', async () => {
    const { app, calls } = appWith(WHOLE);
    const text = '<p><<b>script>x</p><p>a &amp;lt; b &lt; c &amp; d</p>';
    const r = await call(app, '/api/writer/improve', { text, action: 'critique' });
    expect(r.status).toBe(200);
    const sent = sentText(calls);
    expect(sent).not.toMatch(/<script/);
    expect(sent).toContain('a &lt; b < c & d');
  });

  it("a long run of unclosed '<style' (CodeQL polynomial regex) stays fast", async () => {
    const { app, calls } = appWith(WHOLE);
    // 96 KB, under express.json's 100 KB default. The old regex took ~1.1 s on
    // this alone (2026-10-31, M-series Mac); the scanner takes milliseconds.
    const text = '<style'.repeat(16_000) + '<p>tail</p>';
    const t0 = Date.now();
    const r = await call(app, '/api/writer/improve', { text, action: 'critique' });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(sentText(calls)).toMatch(/tail/);
  });
});
