/**
 * A047 — /ask with no embedding model sent the customer round in a loop.
 *
 * Measured 2026-09-30 on a fresh install: upload a note ("indexed"), then
 * /ask → "1 document are in the Vault but none have been embedded yet … Run
 * /index-brain". /index-brain → "Vault indexed — 0 new or changed, 0 embedded,
 * 1 unchanged", no reason. /ask again → the same advice. With no embedder,
 * indexing cannot embed anything; the remedy is a model. The upload reply also
 * said "no model is assigned to the chat role" when one was assigned and only
 * could not answer.
 *
 * No real model anywhere: the embedder is a stub that throws the kernel's
 * no_embed_model error, and readiness is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');
const retrieveFactory = require('../src/blocks/aeon_matrix/api/retrieve.cjs');

const noEmbed = async () => { const e = new Error('No model assigned for role "embed"'); e.code = 'no_embed_model'; throw e; };
const noEmbedder = () => ({ ok: false, reason: 'no_embed_model' });

let root, vault, dataRoot, servers;
beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-remedy-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Notes', 'rotation.md'), '# Key rotation\n\nRotate the staging credentials every ninety days and record it in the ledger.');
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  ingestMod._resetStores();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); });
});
async function mount(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const port = await listen(app);
  return (route, body) => fetch(`http://127.0.0.1:${port}/api/crn/second-brain/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

describe('/recall and /ask with documents but no embedder', () => {
  it('name the missing model, not another /index-brain', async () => {
    await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: noEmbed }).runSecondBrainScan();
    const call = await mount(retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embedReadiness: noEmbedder }));
    const { body } = await call('retrieve', { query: 'when do we rotate credentials', k: 3 });
    expect(body.documents).toEqual([]);
    expect(body.unavailable.reason).toBe('no_embedding_model');
    expect(body.unavailable.action).toMatch(/Cookbook/);
    expect(body.unavailable.action).toMatch(/nomic-embed-text/);
    expect(body.text).toMatch(/no embedding model is available/);
  });

  it('with an embedder present, the advice is still to run the index', async () => {
    await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: noEmbed }).runSecondBrainScan();
    const call = await mount(retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embedReadiness: () => ({ ok: true, provider: 'local', model: 'nomic-embed-text-q8' }) }));
    const { body } = await call('retrieve', { query: 'rotate credentials', k: 3 });
    expect(body.unavailable.reason).toBe('index_not_embedded');
    expect(body.unavailable.action).toMatch(/\/index-brain/);
  });
});

describe('/index-brain says why the documents it kept still have no vector', () => {
  it('a second scan with no embedder explains its "0 embedded, 1 unchanged"', async () => {
    const call = await mount(ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: noEmbed }));
    await call('ingest/scan-docs?format=summary');
    const { body } = await call('ingest/scan-docs?format=summary');
    expect(body.embedded).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.unembedded).toBe(1);
    expect(body.text).toMatch(/1 unchanged/);
    expect(body.text).toMatch(/no embedding model answered/);
    expect(body.text).toMatch(/Cookbook/);
  });
});

describe('/upload says what it could not do, and why', () => {
  it('a chat model that fails is not "no model assigned"', async () => {
    const kernelLLM = async () => { throw new Error('No provider could answer right now — gemini unavailable.'); };
    const call = await mount(ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: noEmbed, kernelLLM }));
    const { status, body } = await call('upload', { name: 'memo.md', contentBase64: Buffer.from('A memo long enough to index: renew the domain before March.').toString('base64') });
    expect(status).toBe(200);
    expect(body.embedded).toBe(false);
    expect(body.text).not.toMatch(/no model is assigned/);
    expect(body.text).toMatch(/No summary — the chat model did not answer \(No provider could answer right now/);
    expect(body.text).toMatch(/cannot find it by meaning/);
  });

  it('no chat model at all still says so', async () => {
    const call = await mount(ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: noEmbed }));
    const { body } = await call('upload', { name: 'memo.md', contentBase64: Buffer.from('A memo long enough to index: renew the domain before March.').toString('base64') });
    expect(body.text).toMatch(/No summary — no model is assigned to the chat role/);
  });
});
