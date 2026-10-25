/**
 * /api/build/queue/:id/approve and /api/build/submit are async handlers, and
 * Express 4 does not catch a rejected async handler: a throw inside
 * pipeline.approveBuild (which now awaits the interface rebuild) left the
 * request unanswered and the Settings Approve button disabled. Both routes
 * answer 500 JSON instead; the status codes for normal results are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROUTER_PATH = require.resolve('../src/kernel/routers/build.cjs');

let tmp, server, base, pipeline;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-build-router-'));
  pipeline = {};
  const app = express();
  app.use(express.json());
  app.use('/api/build', require(ROUTER_PATH)({
    pipeline: new Proxy({}, { get: (_t, name) => pipeline[name] }),
    approvals: {}, ideMode: {},
    kernelRescan: () => ({ ok: true }), commandRescan: () => 0, isMounted: () => true,
    blocksDir: path.join(tmp, 'blocks'), removedDir: path.join(tmp, 'removed'),
  }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/build`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (p, body = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

describe('approve', () => {
  it('answers 500 JSON when approveBuild throws, instead of hanging', async () => {
    pipeline.approveBuild = async () => { throw new Error('rebuild hook blew up'); };
    const r = await post('/queue/APR-1/approve');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'rebuild hook blew up' });
  });

  it('keeps its status codes: 200 live, 403 Tier 3 without IDE mode, 422 refused', async () => {
    pipeline.approveBuild = async () => ({ ok: true, stage: 'live', uiRebuilt: { ok: true, ms: 5 } });
    const live = await post('/queue/APR-1/approve');
    expect(live.status).toBe(200);
    expect(live.body.uiRebuilt).toEqual({ ok: true, ms: 5 });

    pipeline.approveBuild = async () => ({ ok: false, tier3: true, error: 'enable IDE mode first' });
    expect((await post('/queue/APR-1/approve')).status).toBe(403);

    pipeline.approveBuild = async () => ({ ok: false, error: 'approval APR-9 not found' });
    expect((await post('/queue/APR-9/approve')).status).toBe(422);
  });

  it('passes the approver header and note through', async () => {
    let seen;
    pipeline.approveBuild = async (id, opts) => { seen = { id, ...opts }; return { ok: true }; };
    const r = await fetch(`${base}/queue/APR-3/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aeon-operator': 'cris' }, body: JSON.stringify({ note: 'ok' }),
    });
    expect(r.status).toBe(200);
    expect(seen).toEqual({ id: 'APR-3', approver: 'cris', note: 'ok' });
  });
});

describe('submit', () => {
  it('answers 500 JSON when submitBuild throws', async () => {
    pipeline.submitBuild = async () => { throw new Error('staging disk full'); };
    const r = await post('/submit', { source: 'paste', manifest: {} });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: 'staging disk full' });
  });

  it('keeps its status codes: 400 without a source, 200 ok, 422 refused', async () => {
    expect((await post('/submit', {})).status).toBe(400);
    pipeline.submitBuild = async () => ({ ok: true, stage: 'live' });
    expect((await post('/submit', { source: 'paste' })).status).toBe(200);
    pipeline.submitBuild = async () => ({ ok: false, stage: 'lint', error: 'lint failed' });
    expect((await post('/submit', { source: 'paste' })).status).toBe(422);
  });
});
