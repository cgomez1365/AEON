/**
 * BO-H3 + BO-H8 — refuse a download that cannot work; survive a bad upload.
 *
 * The probe tests use a local HTTPS-shaped stub rather than the real
 * HuggingFace API: a test that needs the network is a test that goes red when
 * an unrelated service has a bad afternoon.
 *
 * The most important case here is `fails open`. A preflight that turns a
 * network blip into "you may not install this" is a worse defect than the one
 * it prevents, so that behaviour is pinned deliberately.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const https = require('https');
const { ggufProbe, isGguf } = require('../src/blocks/cookbook/api/_ggufProbe.cjs');

/** Stub https.get with a canned JSON body (or a failure). */
function stubHttps(handler) {
  return vi.spyOn(https, 'get').mockImplementation((url, _opts, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = () => {};
    const result = handler(String(url));
    if (result === null) { setImmediate(() => req.emit('error', new Error('ECONNREFUSED'))); return req; }
    const res = new EventEmitter();
    res.statusCode = result.status ?? 200;
    res.resume = () => {};
    setImmediate(() => {
      cb(res);
      if (res.statusCode === 200) res.emit('data', JSON.stringify(result.body));
      res.emit('end');
    });
    return req;
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('isGguf', () => {
  it('matches only .gguf, case-insensitively', () => {
    expect(isGguf('model-Q4_K_M.gguf')).toBe(true);
    expect(isGguf('MODEL.GGUF')).toBe(true);
    expect(isGguf('model.safetensors')).toBe(false);
    expect(isGguf('gguf-notes.txt')).toBe(false);
    expect(isGguf(undefined)).toBe(false);
  });
});

describe('ggufProbe', () => {
  it('passes a repo that ships GGUF', async () => {
    stubHttps(() => ({ body: { siblings: [{ rfilename: 'Qwen3-1.7B-Q8_0.gguf' }, { rfilename: 'README.md' }] } }));
    const r = await ggufProbe('Qwen/Qwen3-1.7B-GGUF');
    expect(r.ok).toBe(true);
    expect(r.hasGguf).toBe(true);
    expect(r.ggufFiles).toContain('Qwen3-1.7B-Q8_0.gguf');
  });

  it('refuses a safetensors-only repo — the Qwen3-14B case', async () => {
    stubHttps((url) => {
      if (url.includes('/api/models/')) {
        return { body: { siblings: [
          { rfilename: 'model-00001-of-00008.safetensors' },
          { rfilename: 'generation_config.json' },
          { rfilename: 'merges.txt' },
        ] } };
      }
      return { body: [] }; // no alternative found
    });
    const r = await ggufProbe('Qwen/Qwen3-14B');
    expect(r.ok).toBe(true);
    expect(r.hasGguf).toBe(false);
  });

  it('names the GGUF build that would have worked', async () => {
    stubHttps((url) => {
      if (url.includes('/api/models/Qwen/Qwen3-14B')) {
        return { body: { siblings: [{ rfilename: 'model.safetensors' }] } };
      }
      return { body: [{ modelId: 'Qwen/Qwen3-14B-GGUF', downloads: 9000 }] };
    });
    const r = await ggufProbe('Qwen/Qwen3-14B');
    expect(r.hasGguf).toBe(false);
    expect(r.suggestion).toBe('Qwen/Qwen3-14B-GGUF');
  });

  it('FAILS OPEN when the API is unreachable — a blip is not a refusal', async () => {
    stubHttps(() => null);
    const r = await ggufProbe('any/repo');
    expect(r.ok).toBe(false);
    expect(r.hasGguf).toBeUndefined();
  });

  it('fails open on a gated repo (401/403) rather than calling it empty', async () => {
    stubHttps(() => ({ status: 401, body: {} }));
    const r = await ggufProbe('meta-llama/Llama-3.1-8B');
    expect(r.ok).toBe(false);
  });

  it('fails open when the file list is missing — unknown is not empty', async () => {
    stubHttps(() => ({ body: { id: 'x/y' } }));
    const r = await ggufProbe('x/y');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/file list/);
  });

  it('fails open on malformed JSON', async () => {
    vi.spyOn(https, 'get').mockImplementation((url, _opts, cb) => {
      const req = new EventEmitter();
      req.destroy = () => {}; req.setTimeout = () => {};
      const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
      setImmediate(() => { cb(res); res.emit('data', '{not json'); res.emit('end'); });
      return req;
    });
    const r = await ggufProbe('x/y');
    expect(r.ok).toBe(false);
  });

  it('returns not-ok for a missing repo id instead of throwing', async () => {
    expect((await ggufProbe(null)).ok).toBe(false);
    expect((await ggufProbe('')).ok).toBe(false);
  });
});

describe('BO-H8 — a bad upload must not kill the kernel', () => {
  const storage = require('../services/storage.js');

  it('hands an unwritable destination to multer instead of throwing', () => {
    const engine = storage.upload.storage;
    // A path that cannot be created on Windows or POSIX.
    const req = { body: { targetDir: '\0:/definitely/not/creatable' } };
    let cbErr = 'NOT_CALLED';
    expect(() => {
      engine.getDestination(req, { originalname: 'x.txt' }, (err) => { cbErr = err; });
    }).not.toThrow();
    expect(cbErr).toBeInstanceOf(Error);
    expect(cbErr.message).toMatch(/cannot write to upload target/);
  });

  it('still resolves a valid destination', () => {
    // BO-SHIP P5.1 — audit P0-03. This passed path.join(__dirname,'..','data'):
    // the REAL checkout data root. The destination callback mkdirSync's its
    // target, so an ordinary `npm test` created operational state inside the
    // install it was running from. On a clone pointed at a live install, the
    // suite had write authority over the product's data.
    //
    // The home directory proves the same property and is better still: it is
    // inside the upload boundary, it already exists, so the callback's
    // mkdirSync is never reached and the test writes nothing at all. A scratch
    // dir under os.tmpdir() no longer works here — see the containment case
    // below, which is the reason why.
    const engine = storage.upload.storage;
    const req = { body: { targetDir: os.homedir() } };
    let dest = null; let err = 'NOT_CALLED';
    engine.getDestination(req, { originalname: 'x.txt' }, (e, d) => { err = e; dest = d; });
    expect(err).toBeNull();
    expect(dest).toBeTruthy();
  });

  it('refuses a destination outside the operator\'s own area', () => {
    // The security property, pinned. `targetDir` arrives in the request body
    // and was previously trusted verbatim, so an upload could be aimed at any
    // path the process could write — including the directories that execute
    // what is placed in them (LaunchAgents, a shell profile, Startup). The
    // destination must land inside the home directory, workspace, or vault.
    const engine = storage.upload.storage;
    for (const evil of ['/tmp/aeon-escape', '/etc', path.join(os.tmpdir(), 'x')]) {
      let err = 'NOT_CALLED';
      engine.getDestination({ body: { targetDir: evil } }, { originalname: 'x.txt' }, (e) => { err = e; });
      expect(err, `${evil} should have been refused`).toBeInstanceOf(Error);
      expect(err.message).toMatch(/outside the allowed area/);
    }
  });

  it('refuses a destination that climbs out with ../', () => {
    // Containment is judged after resolution, so the traversal is already
    // collapsed. Testing the raw string instead would let this through.
    const engine = storage.upload.storage;
    let err = 'NOT_CALLED';
    const escape = path.join(os.homedir(), '..', '..', '..', 'etc');
    engine.getDestination({ body: { targetDir: escape } }, { originalname: 'x.txt' }, (e) => { err = e; });
    expect(err).toBeInstanceOf(Error);
  });

  it('keeps the 50 MB / 20 file limits the error handler reports on', () => {
    expect(storage.upload.limits.fileSize).toBe(50 * 1024 * 1024);
    expect(storage.upload.limits.files).toBe(20);
  });
});
