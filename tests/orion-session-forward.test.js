/**
 * Orion's loopback legs carry the caller's session.
 *
 * CEO, 2026-09-14: with a Security login set up, every /orion search showed
 * "Web could not be searched — UNAUTHORIZED_SESSION" and the same for Your
 * Documents, while the block leg answered. /api/orion/search itself was
 * authenticated by the browser's cookie, but the block then re-entered the
 * kernel over 127.0.0.1 for /api/search-web and /api/crn/second-brain/retrieve
 * with a bare fetch — no Cookie, no Authorization — and the kernel guard
 * (which protects every /api path once an account exists) refused both.
 * The block leg never fetches, which is why only it worked.
 *
 * The fake kernel here does what the real guard does: 401 unless the session
 * cookie or bearer token is present.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const orionFactory = require('../src/blocks/orion_search/api/orion.cjs');

const COOKIE = 'aeon_session=tok-abc123';
const BEARER = 'Bearer mobile-secret';

let servers, savedPort, seen;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })); });

beforeEach(async () => {
  servers = []; seen = [];
  const fake = express(); fake.use(express.json());
  // The guard: same shape as src/kernel/server-utils/sessionValidator.cjs unauthorized().
  fake.use('/api', (req, res, next) => {
    seen.push({ path: req.path, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null });
    const ok = (req.headers.cookie || '').includes('aeon_session=') || (req.headers.authorization || '').startsWith('Bearer ');
    if (!ok) return res.status(401).json({ success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true, reason: 'no-session' });
    next();
  });
  fake.get('/api/search-web', (req, res) => res.json({ results: '- **A web hit**\nexcerpt\nSource: [x](https://example.test/a)' }));
  fake.post('/api/crn/second-brain/retrieve', (req, res) => res.json({ documents: [{ id: 'notes.md', content: 'a vault passage', metadata: { source: 'notes.md' } }] }));
  const f = await listen(fake); servers.push(f.server);
  savedPort = process.env.PORT; process.env.PORT = String(f.port);
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

async function search(headers) {
  const router = orionFactory({ isVercel: false, kernelLLM: null });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const h = await listen(app); servers.push(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port}/api/orion/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query: 'shelter checks' }),
  });
  return r.json();
}

describe('/orion forwards the session to its loopback legs', () => {
  it('a cookie session reaches both /api/search-web and the Second Brain retrieve', async () => {
    const d = await search({ Cookie: COOKIE });
    const paths = seen.map((s) => s.path).sort();
    expect(paths).toEqual(['/crn/second-brain/retrieve', '/search-web']);
    for (const s of seen) expect(s.cookie).toBe(COOKIE);
    expect(d.counts).toMatchObject({ web: 1, brain: 1 });
    expect(d.degraded ?? {}).toEqual({});
    expect(d.text).not.toMatch(/UNAUTHORIZED_SESSION/);
  });

  it('a bearer token is forwarded the same way', async () => {
    const d = await search({ Authorization: BEARER });
    for (const s of seen) expect(s.authorization).toBe(BEARER);
    expect(d.counts).toMatchObject({ web: 1, brain: 1 });
  });

  it('with no session at all, the legs are refused and Orion reports it rather than inventing one', async () => {
    const d = await search({});
    for (const s of seen) { expect(s.cookie).toBeNull(); expect(s.authorization).toBeNull(); }
    expect(d.counts).toMatchObject({ web: 0, brain: 0 });
    expect(JSON.stringify(d)).toMatch(/UNAUTHORIZED_SESSION/);
  });
});
