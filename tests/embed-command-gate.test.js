/**
 * The commands that need an embedding model are gated; the ones that CREATE
 * embeddings are not.
 *
 * CEO, 2026-09-10: on an install without nomic-embed, /ask /recall /scan
 * /index-brain were simply absent from the terminal palette — the palette
 * dropped every command whose block was not ready — and read as removed. When
 * the block WAS ready but no embedding model existed, /ask and /recall ran and
 * died inside retrieval.
 *
 * The line, and it is not where the first pass drew it: /recall and /ask match
 * on vectors (retrieve.cjs filters to documents carrying one), so with no
 * embedder they cannot work — they declare `when: "embed"`. /scan,
 * /index-brain and /upload INDEX, which works with no embedder at all and is
 * precisely what backfills the vectors once a model arrives. Gating those
 * locked the repair behind the thing it repairs; they carry no gate.
 *
 * The registry evaluates `when: "embed"` live against the same resolver the
 * indexer uses, lists a gated command as unavailable WITH a reason naming
 * Cookbook, dispatches a 409 with that sentence, and the palette keeps it on
 * screen dimmed. Download the model → the gate opens on the next palette open,
 * no restart.
 *
 * Also here: the Gemini "custom address" false positive. The Settings form
 * prefills a provider's own base URL and sends it back; discovery treated that
 * as a custom address and refused Gemini's own address.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// endpoints.cjs creates its secrets dir at MODULE SCOPE — set before any
// require that can reach it (the registry requires it lazily too), or this
// test provisions secrets/ inside the checkout it runs from.
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-gate-'));

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const createRegistry = require('../src/kernel/commandRegistry.cjs');
const endpoints = require('../src/kernel/endpoints.cjs');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/block.manifest.json'), 'utf8'));
const cmds = manifest.contract.commands;

// Need a vector to do their job at all.
const EMBED_CMDS = ['/ask', '/recall'];
// Write vectors (or write the index those vectors hang off). Must stay usable
// with no embedder — running one is how a vector-less vault gets fixed.
const INDEXING_CMDS = ['/scan', '/index-brain', '/upload'];

async function mount(hasEmbedding) {
  const reg = createRegistry({ blockReadiness: { aeon_matrix: { ready: true } }, isVercel: false, isCloudLinked: () => false, hasEmbedding });
  const app = express(); app.use(express.json()); app.use('/api', reg.router);
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}/api`;
  return {
    close: () => s.close(),
    list: async () => (await (await fetch(`${base}/commands`)).json()).commands,
    run: async (cmd, arg = 'x') => { const r = await fetch(`${base}/commands/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, arg }) }); return { status: r.status, body: await r.json() }; },
  };
}

describe('vault commands declare the embedding dependency', () => {
  it('the commands that SEARCH by vector carry when: "embed"', () => {
    for (const c of EMBED_CMDS) expect(cmds.find(x => x.cmd === c)?.when, c).toBe('embed');
    expect(cmds.find(x => x.cmd === '/doc')?.when).toBeUndefined(); // reads a path, no vector
  });

  // The regression this prevents is one this suite's first version SHIPPED:
  // gating the indexer behind an embedding model makes the only tool that can
  // backfill vectors unavailable in exactly the state that needs backfilling.
  it('the commands that BUILD the index carry no gate — they are the remedy', () => {
    for (const c of INDEXING_CMDS) expect(cmds.find(x => x.cmd === c)?.when, c).toBeUndefined();
  });

  it('indexing commands stay available with no embedding model', async () => {
    const h = await mount(() => false);
    try {
      const list = await h.list();
      for (const c of INDEXING_CMDS) {
        const row = list.find(x => x.cmd === c);
        expect(row.available, `${c} must stay runnable without an embedder`).toBe(true);
      }
    } finally { h.close(); }
  });

  it('no embedding model: listed, unavailable, with a reason that names Cookbook', async () => {
    const h = await mount(() => false);
    try {
      const list = await h.list();
      for (const c of EMBED_CMDS) {
        const row = list.find(x => x.cmd === c);
        expect(row, `${c} must stay in the list`).toBeTruthy();
        expect(row.available).toBe(false);
        expect(row.reason).toMatch(/embedding model/);
        expect(row.reason).toMatch(/Cookbook/);
      }
      // A command that does not embed is untouched by the gate.
      expect(list.find(x => x.cmd === '/doc').available).toBe(true);
      expect(list.find(x => x.cmd === '/doc').reason).toBeNull();

      const r = await h.run('/ask', 'what is aeon');
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/embedding model/);
      expect(r.body.error).toMatch(/Cookbook/);
      expect(r.body.error).not.toMatch(/requires: embed/); // not the generic line
    } finally { h.close(); }
  });

  it('model present: the gate opens without a rescan or restart', async () => {
    let present = false;
    const h = await mount(() => present);
    try {
      expect((await h.list()).find(x => x.cmd === '/recall').available).toBe(false);
      present = true; // Cookbook finished the download
      expect((await h.list()).find(x => x.cmd === '/recall').available).toBe(true);
      const r = await h.run('/recall', 'anything');
      expect(r.status).not.toBe(409);
    } finally { h.close(); }
  });

  it('one definition of the embedding space, shared by the writer and the panel', () => {
    // The status panel compares vectors on disk against the space the active
    // embedder writes. Deriving `${model}#task` a second time by hand is how
    // the two answers drift, so both read embedSpace().
    const { embedSpace } = require('../src/kernel/embed.cjs');
    expect(embedSpace('nomic-embed-text-q8')).toBe('nomic-embed-text-q8#task');
    expect(embedSpace('text-embedding-3-small')).toBe('text-embedding-3-small');
    const src = fs.readFileSync(path.join(ROOT, 'src/kernel/embed.cjs'), 'utf8');
    expect(src).toMatch(/const space = embedSpace\(r\.model\)/);
  });

  it('by default the registry asks the embedding resolver, the same one the indexer uses', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/kernel/commandRegistry.cjs'), 'utf8');
    expect(src).toMatch(/describeRoleLocal\(ep\.EMBED_ROLE\)/);
    expect(typeof endpoints.describeRoleLocal).toBe('function');
    expect(endpoints.EMBED_ROLE).toBe('embed');
  });

  it('the palette keeps unavailable commands on screen and re-reads the list when it opens', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/components/Terminal2.jsx'), 'utf8');
    expect(src).not.toMatch(/filter\(c => c\.available !== false\)/);
    expect(src).toMatch(/data-unavailable/);
    expect(src).toMatch(/if \(showPalette\) loadCommands\(\)/);
  });
});

describe('discovery: a provider\'s own base URL is not a "custom address"', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('gemini with its prefilled default base is probed, not refused', async () => {
    let hit = null;
    globalThis.fetch = async (url) => { hit = String(url); return { json: async () => ({ models: [{ name: 'models/gemini-2.5-flash' }] }) }; };
    const r = await endpoints.discoverModels('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'k');
    expect(Array.isArray(r), JSON.stringify(r)).toBe(true);
    expect(r).toEqual(['gemini-2.5-flash']);
    expect(hit).toMatch(/generativelanguage\.googleapis\.com/);
  });

  it('gemini with a DIFFERENT address is still refused — the key would ride in the query string', async () => {
    globalThis.fetch = async () => { throw new Error('must not be called'); };
    const r = await endpoints.discoverModels('gemini', 'https://example.com/v1beta', 'k');
    expect(r.error).toMatch(/custom address cannot be used/);
  });
});
