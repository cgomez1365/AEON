// BO-A0 — the download path, driven against real HTTP servers.
//
// The previous implementation crashed the Node PROCESS on any redirect: the
// error handler was attached only on the 200 branch, so the redirect branch
// left a failing WriteStream with no listener. Every GitHub release URL and
// every resolvable Hugging Face model URL answers 302, so this fired on 100%
// of real installs and took the Express kernel down with it.
//
// These tests import the REAL download() — no re-implementation.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { download, resolveRedirect } = require('../../services/local-runtime/download.cjs');

const PAYLOAD = Buffer.from('AEON local runtime payload — '.repeat(64));

let tmpDir;
const servers = [];

/** Start an http server on an ephemeral port; returns { url, close }. */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-dl-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(servers.map(s => new Promise(r => s.close(r))));
});

const dest = (name = 'out.bin') => path.join(tmpDir, name);

describe('download — redirects', () => {
  it('follows a 302 and lands the file intact, process alive', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        return res.end();
      }
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });

    const out = dest();
    const result = await download(`${base}/start`, out);

    expect(result.redirects).toBe(1);
    expect(fs.readFileSync(out)).toEqual(PAYLOAD);
  });

  it.each([301, 302, 303, 307, 308])('follows a %i', async (code) => {
    const base = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(code, { Location: '/final' });
        return res.end();
      }
      res.writeHead(200);
      res.end(PAYLOAD);
    });

    const out = dest(`out-${code}.bin`);
    await download(`${base}/start`, out);
    expect(fs.readFileSync(out)).toEqual(PAYLOAD);
  });

  it('follows a chain of redirects within the cap', async () => {
    const base = await serve((req, res) => {
      const m = req.url.match(/^\/hop\/(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (n > 1) { res.writeHead(302, { Location: `/hop/${n - 1}` }); return res.end(); }
        res.writeHead(302, { Location: '/final' });
        return res.end();
      }
      res.writeHead(200);
      res.end(PAYLOAD);
    });

    const out = dest();
    const result = await download(`${base}/hop/4`, out, { maxRedirects: 5 });
    expect(result.redirects).toBe(4);
    expect(fs.readFileSync(out)).toEqual(PAYLOAD);
  });

  it('resolves a RELATIVE Location header (Hugging Face CDN does this)', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a/b/start') {
        res.writeHead(302, { Location: '../final' });
        return res.end();
      }
      if (req.url === '/a/final') { res.writeHead(200); return res.end(PAYLOAD); }
      res.writeHead(404); res.end();
    });

    const out = dest();
    await download(`${base}/a/b/start`, out);
    expect(fs.readFileSync(out)).toEqual(PAYLOAD);
  });

  it('fails bounded on a redirect loop, leaving no partial file', async () => {
    const base = await serve((req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    });

    const out = dest();
    await expect(download(`${base}/loop`, out, { maxRedirects: 3 }))
      .rejects.toThrow(/Too many redirects/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('rejects a redirect with no Location header', async () => {
    const base = await serve((req, res) => { res.writeHead(302); res.end(); });
    const out = dest();
    await expect(download(`${base}/x`, out)).rejects.toThrow(/no Location/i);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('download — transport downgrade', () => {
  it('refuses an https→http redirect', () => {
    expect(() => resolveRedirect('https://example.com/a', 'http://example.com/b'))
      .toThrow(/downgrade/i);
  });

  it('allows http→https and https→https', () => {
    expect(resolveRedirect('http://example.com/a', 'https://example.com/b'))
      .toBe('https://example.com/b');
    expect(resolveRedirect('https://a.example.com/x', 'https://b.example.com/y'))
      .toBe('https://b.example.com/y');
  });

  it('refuses a non-HTTP redirect target', () => {
    expect(() => resolveRedirect('https://example.com/a', 'file:///etc/passwd'))
      .toThrow(/non-HTTP/i);
  });
});

describe('download — failure paths leave nothing behind', () => {
  it('a non-200 rejects and removes the partial file', async () => {
    const base = await serve((req, res) => { res.writeHead(500); res.end('nope'); });
    const out = dest();
    await expect(download(`${base}/x`, out)).rejects.toThrow(/HTTP 500/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('a mid-stream server abort rejects and removes the partial file', async () => {
    const base = await serve((req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length * 2) });
      res.write(PAYLOAD);
      res.destroy(); // die mid-body
    });
    const out = dest();
    await expect(download(`${base}/x`, out)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
  });

  it('rejects a malformed URL rather than throwing synchronously', async () => {
    await expect(download('not-a-url', dest())).rejects.toThrow(/Malformed/);
  });

  it('refuses to overwrite an existing destination', async () => {
    const base = await serve((req, res) => { res.writeHead(200); res.end(PAYLOAD); });
    const out = dest();
    fs.writeFileSync(out, 'pre-existing');
    await expect(download(`${base}/x`, out)).rejects.toThrow();
    // The guard exists so a half-finished install cannot be silently adopted.
    expect(fs.readFileSync(out, 'utf8')).toBe('pre-existing');
  });
});

describe('download — progress', () => {
  it('reports progress and final byte count', async () => {
    const base = await serve((req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    const seen = [];
    const result = await download(`${base}/x`, dest(), {
      onProgress: (pct, bytes, total) => seen.push({ pct, bytes, total }),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1).pct).toBe(100);
    expect(result.bytes).toBe(PAYLOAD.length);
  });
});
