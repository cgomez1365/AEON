/**
 * The app-wide JSON parser must not refuse a route that declares a larger limit.
 *
 * 2026-09-28 (C03): server.js ran `express.json({ limit: '10mb' })` ahead of
 * every router. /api/console/file-drop and the Matrix /upload each declare
 * their own 36 MB parser (a 25 MB document is ~34 MB as base64 JSON), but a
 * route-level parser only runs if the app-wide one let the request through —
 * so any file over ~7.5 MB came back 413 "Internal Core Error." and the
 * terminal card read "[DROP] Internal Core Error.".
 *
 * These tests wire a real express app the way server.js does and send real
 * bodies over loopback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const express = require('express');
const {
  createAppJsonParser, bodyTooLargeReply, APP_JSON_LIMIT, OWN_JSON_LIMIT_PATHS,
} = require('../server/earlyware.cjs');

const MB = 1024 * 1024;
// '36mb' → bytes, the units express.json accepts (no transitive require).
const toBytes = (v) => {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v).trim());
  if (!m) throw new Error(`unreadable limit ${v}`);
  return Math.floor(Number(m[1]) * { b: 1, kb: 1024, mb: MB, gb: 1024 * MB }[(m[2] || 'b').toLowerCase()]);
};
// JSON body of about `size` bytes, shaped like the terminal's drop.
const bodyOf = (size) => JSON.stringify({ name: 'big.pdf', encoding: 'base64', content: 'A'.repeat(size) });

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(createAppJsonParser({ json: express.json }));
  // The console router, as src/kernel/routers/console.cjs declares /file-drop.
  const consoleRouter = express.Router();
  consoleRouter.post('/file-drop', express.json({ limit: '36mb' }), (req, res) => {
    res.json({ ok: true, got: String(req.body?.content || '').length });
  });
  app.use('/api/console', consoleRouter);
  // An ordinary route with no parser of its own.
  app.post('/api/other', (req, res) => res.json({ ok: true, got: String(req.body?.content || '').length }));
  // The error handler's body-size branch, as server.js wires it.
  app.use((err, req, res, _next) => {
    const r = bodyTooLargeReply(err);
    if (r) return res.status(r.status).json(r.body);
    res.status(500).json({ error: 'Internal Core Error.' });
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

describe('app-wide JSON parser (C03)', () => {
  it('a 12 MB drop reaches /file-drop and its own 36 MB parser', async () => {
    const res = await post('/api/console/file-drop', bodyOf(12 * MB));
    const d = await res.json();
    expect(res.status, JSON.stringify(d).slice(0, 200)).toBe(200);
    expect(d.got).toBe(12 * MB);
  });

  it('steps aside the way express routes: any case, trailing slash', async () => {
    const res = await post('/API/Console/File-Drop/', bodyOf(12 * MB));
    expect(res.status).toBe(200);
  });

  it('still parses small bodies for every other route', async () => {
    const res = await post('/api/other', bodyOf(1000));
    expect((await res.json()).got).toBe(1000);
  });

  it('still refuses over 10 MB elsewhere — with a 413 that names the limit, not "Internal Core Error."', async () => {
    const res = await post('/api/other', bodyOf(12 * MB));
    const d = await res.json();
    expect(res.status).toBe(413);
    expect(d.error).toMatch(/10 MB/);
    expect(d.error).not.toMatch(/Internal Core Error/);
    expect(d.limit).toBe(10 * MB);
  });

  it('a body over the route\'s own limit gets the route\'s limit named', async () => {
    const res = await post('/api/console/file-drop', bodyOf(40 * MB));
    const d = await res.json();
    expect(res.status).toBe(413);
    expect(d.error).toMatch(/36 MB/);
  });

  it('bodyTooLargeReply answers only the body-size error', () => {
    expect(bodyTooLargeReply(new Error('boom'))).toBeNull();
    expect(bodyTooLargeReply({ type: 'entity.parse.failed', status: 400 })).toBeNull();
    const r = bodyTooLargeReply({ type: 'entity.too.large', limit: 10 * MB });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/over the 10 MB limit/);
  });
});

// ── The step-aside list and the route declarations must agree ──────────────
// A listed path whose route has no parser of its own would see no body; a
// route that declares more than the app-wide limit but is not listed is this
// defect again.
function routeLimits() {
  const out = [];
  const re = /\.(?:post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\1\s*,\s*express\.json\(\s*\{\s*limit\s*:\s*(['"`])([^'"`]+)\3/g;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(c?js|mjs)$/.test(e.name)) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(re)) {
        out.push({ file: path.relative(ROOT, full), route: m[2], limit: toBytes(m[4]) });
      }
    }
  };
  for (const d of ['src', 'server']) walk(path.join(ROOT, d));
  return out;
}

describe('the step-aside list matches the routes (C03)', () => {
  const declared = routeLimits();
  const appLimit = toBytes(APP_JSON_LIMIT);

  it('finds the two 36 MB routes it exists for', () => {
    const big = declared.filter((d) => d.limit > appLimit).map((d) => d.route);
    expect(big).toEqual(expect.arrayContaining(['/file-drop', '/crn/second-brain/upload']));
  });

  it('every route that declares more than the app-wide limit is listed', () => {
    for (const d of declared.filter((x) => x.limit > appLimit)) {
      expect(OWN_JSON_LIMIT_PATHS.some((p) => p.endsWith(d.route)), `${d.file} ${d.route} (${d.limit} bytes) is not in OWN_JSON_LIMIT_PATHS`).toBe(true);
    }
  });

  it('every listed path has a route that parses its own body', () => {
    for (const p of OWN_JSON_LIMIT_PATHS) {
      expect(declared.some((d) => p.endsWith(d.route)), `${p} has no route-level express.json`).toBe(true);
    }
  });
});

describe('server.js wiring (C03)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');

  it('the app-wide parser is the step-aside one, not a bare 10 MB express.json', () => {
    expect(src).not.toMatch(/app\.use\(\s*express\.json\(\s*\{\s*limit:\s*'10mb'/);
    expect(src).toMatch(/app\.use\(\s*createAppJsonParser\(/);
  });

  it('the global error handler answers a too-large body before the CRIT path', () => {
    const handler = src.slice(src.indexOf('// ── Global error handler'));
    expect(handler.indexOf('bodyTooLargeReply(err)')).toBeGreaterThan(-1);
    expect(handler.indexOf('bodyTooLargeReply(err)')).toBeLessThan(handler.indexOf("'Internal Core Error.'"));
  });
});
