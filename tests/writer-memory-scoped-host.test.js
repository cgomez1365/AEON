// Writer "Push to Memory" under the deps the REAL block host hands Writer.
//
// Found live, 2026-09-23 (agent C2, throwaway AEON_HOME): POST
// /api/writer/doc/:id/to-memory answered { ok: true, store: 'memory_core' },
// Memory Core's own GET /api/memory listed nothing, and the record was on disk
// at <install>/src/blocks/aeon_matrix/data/Vault/Agents/Aeon/memory/ — inside
// the install tree, not the operator's Vault. The boot log said why:
//
//     [SANDBOX] Block "writer" accessed denied dep: VAULT_ROOT
//
// Writer's manifest declares contract.storage.access "scoped", and the block
// loader deletes VAULT_ROOT from a scoped block's deps. Writer then built its
// in-process Memory Core with VAULT_ROOT undefined, and memory.cjs fell back to
// its install-relative default. Its read-back check read that same wrong store,
// so it confirmed its own mistake.
//
// tests/writer-push-to-memory.test.js never saw this: it injects VAULT_ROOT,
// which the real host never does. These cases use the host's shape instead —
// no VAULT_ROOT, the sandbox Proxy, the host's block-scoped resolvers — and
// read the result back through a Memory Core mounted the way the host mounts
// it (compatibility storage, so it DOES get the real VAULT_ROOT).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-scoped-'));
delete process.env.VERCEL;

const mountWriter = require('../src/blocks/writer/api/writer.js');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

/** services/storage.js's contract: <root>/<blockId>/<rel>, confined. */
const scoped = (root) => (blockId, rel = '') => path.resolve(root, blockId, rel || '.');

/** The deps a scoped block actually receives: no VAULT_ROOT, sandbox Proxy. */
function hostShapedDeps({ dataRoot, vaultRoot, extra = {} }) {
  const deps = {
    supabase: null,
    kernelLLM: async () => 'unused by this route',
    getBlockDataFile: scoped(dataRoot),
    getBlockVaultFile: scoped(path.join(vaultRoot, 'blocks')),
    ...extra,
  };
  return new Proxy(deps, { get: (t, p) => (p in t ? t[p] : undefined) });
}

function env(name) {
  const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
  const dataRoot = path.join(dir, 'data');
  const vaultRoot = path.join(dir, 'Vault');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  return { dataRoot, vaultRoot };
}

function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => { server.close(); let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('writer push-to-memory with the deps the real host gives a scoped block', () => {
  it('lands in the Memory Core store the operator actually has', async () => {
    const e = env('host');
    const app = express();
    app.use(express.json());
    mountWriter(app, hostShapedDeps(e));
    // Memory Core is compatibility-scoped, so the host DOES hand it VAULT_ROOT.
    app.use('/api', createMemoryRouter({ VAULT_ROOT: e.vaultRoot }));

    const saved = await call(app, 'POST', '/api/writer/doc', { title: 'Launch note', content: '<p>We are moving the launch to October 17.</p>' });
    expect(saved.status).toBe(200);

    const push = await call(app, 'POST', `/api/writer/doc/${saved.body.id}/to-memory`, {});
    expect(push.status).toBe(200);
    expect(push.body.ok).toBe(true);

    // The assertion the old code failed: Memory Core — mounted with the real
    // root — can see what Writer said it saved.
    const list = await call(app, 'GET', '/api/memory');
    const ids = (list.body.memories || []).map((m) => m.id);
    expect(ids).toContain(push.body.memoryId);
    expect(fs.existsSync(path.join(e.vaultRoot, 'Agents', 'Aeon', 'memory', `${push.body.memoryId}.md`))).toBe(true);
  });

  it('never writes into the install tree when the host gives no vault resolver at all', async () => {
    const e = env('noroot');
    const app = express();
    app.use(express.json());
    const deps = hostShapedDeps(e);
    // A host that hands Writer neither VAULT_ROOT nor getBlockVaultFile.
    const bare = new Proxy({ supabase: null, kernelLLM: deps.kernelLLM, getBlockDataFile: deps.getBlockDataFile },
      { get: (t, p) => (p in t ? t[p] : undefined) });
    mountWriter(app, bare);

    const saved = await call(app, 'POST', '/api/writer/doc', { title: 'Orphan', content: '<p>Nowhere safe to put this memory.</p>' });
    const push = await call(app, 'POST', `/api/writer/doc/${saved.body.id}/to-memory`, {});
    expect(push.status).toBe(503);
    expect(push.body.ok).toBe(false);
    expect(push.body.reason).toBe('memory_core_unavailable');
    expect(push.body.error).toMatch(/Memory Core/);
  });
});
