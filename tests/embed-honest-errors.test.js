// A working Nomic install read as "Embedding model not installed": retrieval
// answered EVERY embedding failure with "needs an embedding model, and none is
// available", and the local embedder's own failures carried no error code. The
// operator's drive had the model ready and a live embedder; only the words lied.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// Isolate BEFORE anything requires endpoints.cjs (module-scope resolution).
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-honest-'));
const { explainEmbedFailure, embedError } = require('../src/kernel/embed.cjs');

const installed = () => ({ ok: true });
const missing = () => ({ ok: false, reason: 'no_embed_model' });

describe('explainEmbedFailure', () => {
  it('says "not installed" only when the model really is missing', () => {
    const r = explainEmbedFailure(embedError('no_embed_model', 'none'), missing);
    expect(r.reason).toBe('no_embedding_model');
    expect(r.message).toMatch(/none is available/);
  });
  it('a plain error with no code and a missing model is still "not installed"', () => {
    expect(explainEmbedFailure(new Error('boom'), missing).reason).toBe('no_embedding_model');
  });
  it('a plain error while the model IS installed names the real cause, not a missing model', () => {
    const r = explainEmbedFailure(new Error('llama-server did not become ready'), installed);
    expect(r.reason).toBe('embed_failed');
    expect(r.message).toMatch(/installed, but embedding your question failed: llama-server did not become ready/);
    expect(r.message).not.toMatch(/none is available/);
    expect(r.action).toMatch(/restart AEON/);
  });
  it('a no_embed_model code while the model is ready is not believed', () => {
    const r = explainEmbedFailure(embedError('no_embed_model', 'x'), installed);
    expect(r.reason).toBe('embed_failed');
    expect(r.message).not.toMatch(/none is available/);
  });
  it('a structured failure keeps its own code, message and action', () => {
    const r = explainEmbedFailure(embedError('local_only', 'Local only is on.', 'Turn it off.'), installed);
    expect(r).toMatchObject({ reason: 'local_only', message: 'Local only is on.', action: 'Turn it off.' });
  });
  it('an unreadable readiness check never throws', () => {
    expect(() => explainEmbedFailure(new Error('x'), () => { throw new Error('no'); })).not.toThrow();
  });
});

describe('the local embedder reports failures honestly', () => {
  let restore;
  const lrPath = require.resolve('../services/local-runtime/index.cjs');
  const embedPath = require.resolve('../src/kernel/embed.cjs');
  beforeEach(() => { restore = require.cache[lrPath]; });
  afterEach(() => { require.cache[lrPath] = restore; delete require.cache[embedPath]; });
  const withRuntime = (embedFn) => {
    require.cache[lrPath] = { id: lrPath, filename: lrPath, loaded: true, exports: { embed: embedFn } };
    delete require.cache[embedPath];
    return require(embedPath);
  };
  // embedLocal is private; reach it through kernelEmbed with the role resolver stubbed.
  const through = async (embedFn) => {
    const ep = require('../src/kernel/endpoints.cjs');
    const spy = vi.spyOn(ep, 'resolveForRole').mockResolvedValue({ ok: true, provider: 'local', model: 'nomic-embed-text-q8' });
    try { return await withRuntime(embedFn).kernelEmbed('q', { kind: 'query' }); } finally { spy.mockRestore(); }
  };

  it('retries once, so a failed first start does not become an error', async () => {
    let n = 0;
    const out = await through(async () => { if (++n === 1) throw new Error('connect ECONNREFUSED'); return [0.1, 0.2]; });
    expect(n).toBe(2);
    expect(out.vector).toEqual([0.1, 0.2]);
  });
  it('a persistent failure is an embed_failed error that says the model is installed', async () => {
    await expect(through(async () => { throw new Error('llama-server exited'); })).rejects.toMatchObject({
      code: 'embed_failed', embedFailure: true, message: expect.stringMatching(/installed, but embedding failed: llama-server exited/),
    });
  });
  it('"No local embedding model installed yet" stays a missing-model error', async () => {
    await expect(through(async () => { throw new Error('No local embedding model installed yet.'); })).rejects.toMatchObject({ code: 'no_embed_model' });
  });
});

describe('retrieval uses the explainer instead of a fixed sentence', () => {
  const src = fs.readFileSync(new URL('../src/blocks/aeon_matrix/api/retrieve.cjs', import.meta.url), 'utf8');
  it('both query paths call explainEmbedFailure', () => expect((src.match(/explainEmbedFailure\(e,/g) || []).length).toBe(2));
  it('no path hard-codes "none is available" for a caught embedding error any more', () => {
    expect(src).not.toMatch(/e\.code === 'no_embed_model' \? 'no_embedding_model'/);
  });
});
