// Writer AI contract — the routes must never answer a failure with empty content.
//
// The bug this pins: writer/api/writer.js used to POST to its own server at
// /api/kernel/llm over loopback carrying no session. With the auth guard armed
// the kernel answered 401, and the old client never read resp.statusCode — so
// the error body parsed as a result, result.text was undefined, and every
// handler fell back to ''. The frontend checked `if (d.error)`, which the
// backend never set, and ran setVal('').
//
// Net effect: Improve / Expand / Shorten / Casual / Professional REPLACED THE
// USER'S ENTIRE DOCUMENT WITH AN EMPTY STRING every time the AI call failed.
// Not "nothing happened" — silent data loss in a text editor.
//
// This drives the REAL writer module with a REAL express app and a kernelLLM
// stub that fails the way the kernel actually fails. It does not re-implement
// the handler (2026-07-29 rule: a test that re-implements its subject stays
// green while the feature is broken).
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mountWriter = require('../src/blocks/writer/api/writer.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-test-'));

/** Boot the real writer routes with a caller-supplied kernelLLM. */
function appWith(kernelLLM) {
  const app = express();
  app.use(express.json());
  mountWriter(app, {
    supabase: null,
    NOTES_FILE: path.join(TMP, 'notes.json'),
    getBlockDataFile: () => TMP,
    kernelLLM,
  });
  return app;
}

/** Minimal in-process request driver — no port, no network. */
function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: url, method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = JSON.parse(d); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, body: json, raw: d });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// The three shapes a real kernelLLM failure takes.
const REJECTS = {
  'no provider configured': () => {
    const e = new Error('No provider available for role "creative".');
    e.noProviderAvailable = true;
    return Promise.reject(e);
  },
  'provider threw': () => Promise.reject(new Error('upstream 500')),
  'returned empty text': () => Promise.resolve(''),
};

describe('writer AI routes never answer a failure with empty content', () => {
  // improve is the route that caused data loss: its result is written straight
  // back over the document, so an empty 200 here erases the user's work.
  for (const [label, impl] of Object.entries(REJECTS)) {
    it(`POST /api/writer/improve — ${label} → error status, no content key`, async () => {
      const app = appWith(impl);
      const r = await call(app, 'POST', '/api/writer/improve', {
        text: 'The original document the user would have lost.',
        action: 'improve',
      });

      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body).toBeTruthy();
      expect(typeof r.body.error).toBe('string');
      expect(r.body.error.length).toBeGreaterThan(0);

      // The regression itself: a 200 carrying content:'' is what destroyed documents.
      expect(r.body.content).toBeUndefined();
    });
  }

  it('POST /api/writer/generate — failure surfaces an error, not empty content', async () => {
    const app = appWith(REJECTS['no provider configured']);
    const r = await call(app, 'POST', '/api/writer/generate', { prompt: 'write something' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.content).toBeUndefined();
    expect(typeof r.body.error).toBe('string');
  });

  it('a missing kernelLLM dep is reported, not silently swallowed', async () => {
    const app = appWith(undefined);
    const r = await call(app, 'POST', '/api/writer/improve', { text: 'hello', action: 'improve' });
    expect(r.status).toBe(503);
    expect(r.body.aiUnavailable).toBe(true);
    expect(r.body.content).toBeUndefined();
  });

  it('the success path still returns content', async () => {
    const app = appWith(async () => 'rewritten text');
    const r = await call(app, 'POST', '/api/writer/improve', { text: 'original', action: 'improve' });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('rewritten text');
  });

  it('writer talks to the kernel in-process — no loopback HTTP to itself', async () => {
    // The transport was the root cause: an in-process block must not
    // authenticate to itself over the network.
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'blocks', 'writer', 'api', 'writer.js'), 'utf8');
    // Strip comments first — the file documents this bug on purpose, and the
    // explanation naming the old route must not fail the check that it is gone.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\/api\/kernel\/llm/);
    expect(code).not.toMatch(/http\.request\s*\(/);
  });
});

describe('writing DNA never overwrites a good profile with a failed analysis', () => {
  it('unparseable model output leaves the stored profile untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-dna-'));
    const styleFile = path.join(dir, '_style-profile.json');
    const good = { summary: 'A careful, direct voice.', traits: ['terse', 'concrete'] };
    fs.writeFileSync(styleFile, JSON.stringify(good));

    // One saved doc, so the route reaches the model instead of 400-ing early.
    fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify([{ id: 'd1', title: 'Doc' }]));
    fs.writeFileSync(path.join(dir, 'd1.md'), 'x'.repeat(200));

    const app = express();
    app.use(express.json());
    mountWriter(app, {
      supabase: null,
      NOTES_FILE: path.join(dir, 'notes.json'),
      getBlockDataFile: () => dir,
      kernelLLM: async () => 'this is not JSON at all',
    });

    const r = await call(app, 'POST', '/api/writer/style/analyze', {});
    expect(r.status).toBeGreaterThanOrEqual(400);

    const after = JSON.parse(fs.readFileSync(styleFile, 'utf8'));
    expect(after.summary).toBe(good.summary);
    expect(after.traits).toEqual(good.traits);
  });
});
