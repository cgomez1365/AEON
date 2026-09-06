// Writer "Memory" button — the promotion must actually land in Memory Core.
//
// The bug this pins: POST /api/writer/doc/:id/to-memory wrote a row into
// <data>/aeon_notes.json (the Notes block's file) and then answered
// `{ ok: true }` unconditionally — the only write sat inside a bare `catch {}`
// and NOTES_FILE was frequently absent. Writer said "✓ Saved to Memory";
// Memory Core, which reads Vault/Agents/Aeon/memory/memories.json, said
// 0 MEMORIES. Both were telling the truth about different files.
//
// Three assertions carry the fix:
//   1. a push is readable back through Memory Core's OWN route,
//   2. an unreachable Memory Core produces an error, never `ok: true`,
//   3. a document Memory Core would reject is refused up front, and nothing
//      is written.
//
// This drives the REAL writer routes and the REAL memory_core router — no
// re-implementation of either (2026-07-29 rule: a test that re-implements its
// subject stays green while the feature is broken).
//
// Isolation: every case gets its own mkdtemp for both the writer data dir and
// VAULT_ROOT, injected as deps. Nothing here can reach the repo's real
// data/ or secrets/, and no request ever leaves 127.0.0.1 on an OS-assigned
// ephemeral port.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-scope path resolution happens at import time — set the roots first,
// even though both modules under test take their roots as injected deps.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-mem-'));
process.env.DATA_PATH = path.join(TMP_ROOT, '_data');
process.env.VAULT_PATH = path.join(TMP_ROOT, '_vault');
delete process.env.VERCEL;

const mountWriter = require('../src/blocks/writer/api/writer.js');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

// The master persona folder was renamed vp → Aeon; the vault path is derived
// from that directory name, so this path moved with it.
const MEM_REL = path.join('Agents', 'Aeon', 'memory');

function makeEnv(name) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${name}-`));
  const docs = path.join(dir, 'writer');
  const vault = path.join(dir, 'Vault');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  return { dir, docs, vault };
}

/** Real writer routes + the real Memory Core router, same VAULT_ROOT. */
function appFor({ docs, vault }) {
  const app = express();
  app.use(express.json());
  mountWriter(app, {
    supabase: null,
    getBlockDataFile: () => docs,
    kernelLLM: async () => 'unused by this route',
    VAULT_ROOT: vault,
  });
  app.use('/api', createMemoryRouter({ VAULT_ROOT: vault }));
  return app;
}

/** In-process request driver — OS-assigned port on loopback, closed per call. */
function call(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const server = app.listen(0, '127.0.0.1', () => {
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

const saveDoc = async (app, title, content) => {
  const r = await call(app, 'POST', '/api/writer/doc', { title, content });
  expect(r.status).toBe(200);
  return r.body.id;
};

afterAll(() => {
  delete process.env.DATA_PATH;
  delete process.env.VAULT_PATH;
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

describe('writer push-to-memory lands in Memory Core', () => {
  it('the pushed draft is readable back through Memory Core\'s own route', async () => {
    const env = makeEnv('happy');
    const app = appFor(env);
    const BODY = 'The rail gauge decision and why we are not revisiting it.';
    const id = await saveDoc(app, 'Field Notes', BODY);

    // Memory Core starts empty — so a later hit cannot be pre-existing data.
    const before = await call(app, 'GET', '/api/memory');
    expect(before.body.count).toBe(0);

    const push = await call(app, 'POST', `/api/writer/doc/${id}/to-memory`, {});
    expect(push.status).toBe(200);
    expect(push.body.ok).toBe(true);
    expect(push.body.store).toBe('memory_core');
    expect(typeof push.body.memoryId).toBe('string');

    // The assertion that the old code could never satisfy: Memory Core sees it.
    const after = await call(app, 'GET', '/api/memory');
    expect(after.body.count).toBe(1);
    const m = after.body.memories.find(x => x.id === push.body.memoryId);
    expect(m).toBeTruthy();
    expect(m.text).toContain(BODY);
    expect(m.title).toBe('Field Notes');
    expect(m.source).toBe('writer');
    // Provenance: the memory can always answer where it came from.
    expect(m.refs[0].file).toBe(`data/writer/${id}.md`);

    // F1d: the promotion is Matrix-indexable because Memory Core mirrors it
    // into VAULT_ROOT, which aeon_matrix/api/ingest.cjs walks. Writer does not
    // write a second copy of the draft into the Vault.
    expect(fs.existsSync(path.join(env.vault, MEM_REL, `${push.body.memoryId}.md`))).toBe(true);
    expect(fs.existsSync(path.join(env.vault, 'writer'))).toBe(false);
  });

  it('pushing the same draft twice reports the dedupe instead of a second record', async () => {
    const env = makeEnv('dedupe');
    const app = appFor(env);
    const id = await saveDoc(app, 'Repeat', 'A settled decision worth remembering once.');

    const first = await call(app, 'POST', `/api/writer/doc/${id}/to-memory`, {});
    const second = await call(app, 'POST', `/api/writer/doc/${id}/to-memory`, {});
    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    expect(second.body.deduped).toBe(true);
    expect(second.body.memoryId).toBe(first.body.memoryId);

    const after = await call(app, 'GET', '/api/memory');
    expect(after.body.count).toBe(1);
  });

  it('Memory Core unreachable → a named error, never ok:true', async () => {
    // VAULT_ROOT points at a regular file, so Memory Core cannot create or
    // write its store. This is the whole point of the gate: the old route
    // answered { ok: true } in exactly this situation.
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'broken-'));
    const docs = path.join(dir, 'writer');
    fs.mkdirSync(docs, { recursive: true });
    const notADir = path.join(dir, 'vault-is-a-file');
    fs.writeFileSync(notADir, 'not a directory');

    const app = appFor({ docs, vault: notADir });
    const id = await saveDoc(app, 'Doomed', 'This draft cannot reach the store.');

    const push = await call(app, 'POST', `/api/writer/doc/${id}/to-memory`, {});
    expect(push.status).toBeGreaterThanOrEqual(400);
    expect(push.body.ok).not.toBe(true);
    expect(typeof push.body.reason).toBe('string');
    expect(push.body.reason).toMatch(/memory_/);
    expect(typeof push.body.error).toBe('string');
    expect(push.body.error.length).toBeGreaterThan(0);
  });

  it('a document Memory Core would reject is refused, and nothing is written', async () => {
    const env = makeEnv('short');
    const app = appFor(env);
    const id = await saveDoc(app, 'Stub', 'hi');

    const push = await call(app, 'POST', `/api/writer/doc/${id}/to-memory`, {});
    expect(push.status).toBe(400);
    expect(push.body.ok).toBe(false);
    expect(push.body.reason).toBe('doc_too_short');

    const after = await call(app, 'GET', '/api/memory');
    expect(after.body.count).toBe(0);
  });

  it('a missing document is a 404, not a silent success', async () => {
    const app = appFor(makeEnv('missing'));
    const push = await call(app, 'POST', '/api/writer/doc/nope/to-memory', {});
    expect(push.status).toBe(404);
    expect(push.body.ok).toBe(false);
    expect(push.body.reason).toBe('doc_not_found');
  });

  it('the promotion is in-process — no loopback HTTP, no hardcoded port', async () => {
    // A loopback call would default to process.env.PORT || 3001 and write into
    // whatever install owns that port.
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'blocks', 'writer', 'api', 'writer.js'), 'utf8');
    // Strip comments first — the file documents this hazard on purpose.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/fetch\s*\(/);
    expect(code).not.toMatch(/http\.request\s*\(/);
    expect(code).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(code).not.toMatch(/process\.env\.PORT/);
    expect(code).not.toMatch(/aeon_notes/);
  });
});
