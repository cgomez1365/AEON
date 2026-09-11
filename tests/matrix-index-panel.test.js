/**
 * Matrix ▸ Index — the manual embed push, and the numbers behind it.
 *
 * CEO, 2026-09-10: "add a manual embed push in matrix". Two surfaces already
 * told the operator to rebuild the index — the Matrix help card and Orion's
 * empty-vault warning — and neither pointed at anything that could do it. The
 * only trigger was a terminal slash command.
 *
 * The panel is only worth having if its numbers are true, so the contract under
 * test is the STATUS payload: indexing and embedding are separate jobs on one
 * run, and `embedding` reports them separately — how many documents exist, how
 * many carry a vector, how many carry one from a model that is no longer
 * serving, and whether an embedder is available at all. Each has a different
 * remedy, which is why they are not collapsed into one number.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Before any require that can reach endpoints.cjs — it creates its secrets dir
// at module scope, and this test must not provision the checkout it runs from.
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-index-panel-'));

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A vault and a data root of our own. The factory takes both by injection, so
// nothing here can reach the install this suite runs from.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-matrix-index-'));
const VAULT = path.join(TMP, 'vault');
const DATA_ROOT = path.join(TMP, 'data');
fs.mkdirSync(VAULT, { recursive: true });

const ingest = require('../src/blocks/aeon_matrix/api/ingest.cjs');
const INDEX_FILE = path.join(DATA_ROOT, 'vault_index.json');

/** Write an index straight to disk, then mount a fresh router over it. */
async function mountWith(documents) {
  ingest._resetStores();   // forget the per-root store, so the file below is read
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify({ generatedAt: null, documents }, null, 2));
  const app = express();
  app.use(express.json());
  app.use('/api', ingest({ isVercel: false, VAULT_ROOT: VAULT, DATA_ROOT }));
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}/api`;
  return {
    close: () => s.close(),
    status: async () => (await fetch(`${base}/crn/second-brain/index-status`)).json(),
  };
}

const doc = (extra = {}) => ({ title: 't', summary: 's', ...extra });

beforeEach(() => { try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch {} });

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('index-status separates indexing from embedding', () => {
  it('counts documents, vectors, and the ones still owed one', async () => {
    const h = await mountWith({
      'a.md': doc({ embedding: [0.1, 0.2], embeddingModel: 'm#task' }),
      'b.md': doc(),                       // indexed, never embedded
      'c.md': doc({ embedding: [] }),      // an empty vector is not a vector
    });
    try {
      const s = await h.status();
      expect(s.embedding.documents).toBe(3);
      expect(s.embedding.embedded).toBe(1);
      expect(s.embedding.missing).toBe(2);
    } finally { h.close(); }
  });

  it('with no embedder: nothing is pending, because another run cannot help', async () => {
    // The remedy for "no model" is a model, not a rescan. Reporting work as
    // pending here would send the operator back to a button that cannot
    // change the number.
    const h = await mountWith({ 'a.md': doc(), 'b.md': doc() });
    try {
      const s = await h.status();
      if (s.embedding.available) return; // this machine has one; covered below
      expect(s.embedding.pending).toBe(0);
      expect(s.embedding.missing).toBe(2);
      expect(s.embedding.reason).toBeTruthy();
      expect(s.embedding.space).toBeNull();
    } finally { h.close(); }
  });

  it('reports whether a scan is already running, so two cannot look startable', async () => {
    const h = await mountWith({});
    try {
      expect((await h.status()).running).toBe(false);
    } finally { h.close(); }
  });

  it('a measurement failure is reported, never rendered as healthy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/api/ingest.cjs'), 'utf8');
    expect(src).toMatch(/status_unavailable/);
    // available:false in the catch — a panel reading this cannot mistake a
    // broken probe for "no work to do".
    expect(src).toMatch(/embedding = \{ available: false, reason: 'status_unavailable'/);
  });

  it('untagged legacy vectors are read the same way retrieve.cjs reads them', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/api/ingest.cjs'), 'utf8');
    expect(src).toMatch(/d\.embeddingModel \|\| EMBED_MODEL/);
  });
});

describe('the push itself — a run backfills the vectors it was missing', () => {
  /** A deterministic stand-in for a model, so the test never touches a network. */
  const fakeEmbed = async (text) => ({ vector: [text.length % 7, 1, 2], model: 'fake-embed' });

  // `keep` preserves the data root written by a previous pass — that is the
  // whole point of the backfill test: the SECOND run must find the index the
  // first one left behind, not start over.
  async function mountScannable(files, embedFn, { keep = false } = {}) {
    ingest._resetStores();
    if (!keep) {
      fs.rmSync(DATA_ROOT, { recursive: true, force: true });
      fs.rmSync(VAULT, { recursive: true, force: true });
      fs.mkdirSync(VAULT, { recursive: true });
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(VAULT, name), body);
    }
    const app = express();
    app.use(express.json());
    app.use('/api', ingest({ isVercel: false, VAULT_ROOT: VAULT, DATA_ROOT, embed: embedFn }));
    const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const base = `http://127.0.0.1:${s.address().port}/api`;
    return {
      close: () => s.close(),
      status: async () => (await fetch(`${base}/crn/second-brain/index-status`)).json(),
      scan: async () => {
        // Same POST the panel makes; drain the SSE body and return the frames.
        const r = await fetch(`${base}/crn/second-brain/ingest/scan-docs`, { method: 'POST' });
        const text = await r.text();
        return text.split('\n\n').filter(Boolean).map(f => {
          try { return JSON.parse(f.replace(/^data: /, '')); } catch { return null; }
        }).filter(Boolean);
      },
    };
  }

  it('indexes with no embedder, then attaches the vectors when one appears', async () => {
    const files = { 'one.md': '# One\nalpha beta gamma', 'two.md': '# Two\ndelta epsilon zeta' };

    // Pass 1 — no embedder. An embedder that always fails is what "none
    // installed" looks like from inside the scan.
    const dead = async () => { throw Object.assign(new Error('no model'), { code: 'no_embed_model' }); };
    let h = await mountScannable(files, dead);
    try {
      await h.scan();
      const s = await h.status();
      expect(s.embedding.documents).toBe(2);
      expect(s.embedding.embedded).toBe(0);   // indexed, invisible to meaning-search
      expect(s.embedding.missing).toBe(2);
    } finally { h.close(); }

    // Pass 2 — a model arrives. The SAME incremental scan backfills in place,
    // over the index pass 1 left on disk: the files are unchanged, so nothing
    // is re-extracted, and the vectors appear without the documents ever
    // having been lost in between. This is the manual embed push.
    h = await mountScannable(files, fakeEmbed, { keep: true });
    try {
      const events = await h.scan();
      const s = await h.status();
      expect(s.embedding.embedded).toBe(2);
      expect(s.embedding.missing).toBe(0);
      // Backfilled, not re-ingested from scratch — the action names which.
      expect(events.filter(e => e.action === 'embed-backfill').length).toBe(2);
      expect(events.some(e => e.done)).toBe(true);
    } finally { h.close(); }
  });

  it('the stream names the embed work, so the panel can tally it', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/api/ingest.cjs'), 'utf8');
    expect(src).toMatch(/action: 'embed-backfill'/);
    expect(src).toMatch(/action: 'space-migrate'/);
    const panel = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/components/IndexPanel.jsx'), 'utf8');
    expect(panel).toMatch(/embed-backfill/);
    expect(panel).toMatch(/space-migrate/);
  });

  it('every embed call in the scan honours the injected embedder', () => {
    // The vector-backfill branch called the real embedder while its three
    // siblings took the injection — so a test with a fake model still hit the
    // network, on exactly the path the embed push drives.
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/api/ingest.cjs'), 'utf8');
    const body = src.slice(src.indexOf('async function _runScan'));
    const bare = body.match(/await embed\(/g) || [];
    expect(bare, 'every embed call in _runScan must go through injectedEmbed || embed').toEqual([]);
  });
});

describe('the panel is reachable and does what it says', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/components/IndexPanel.jsx'), 'utf8');
  const block = fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/index.jsx'), 'utf8');

  it('Matrix mounts an Index tab', () => {
    expect(block).toMatch(/import IndexPanel from '\.\/components\/IndexPanel'/);
    expect(block).toMatch(/\['index', 'Index'/);
    expect(block).toMatch(/view === 'index' \? \(\s*<IndexPanel \/>/);
  });

  it('it triggers the same incremental scan the terminal does, over SSE', () => {
    expect(panel).toMatch(/second-brain\/ingest\/scan-docs/);
    expect(panel).toMatch(/method: 'POST'/);
    expect(panel).toMatch(/getReader\(\)/);
  });

  it('the button names the work: an embed push when vectors are owed', () => {
    expect(panel).toMatch(/Push embeddings/);
    expect(panel).toMatch(/Run index/);
  });

  it('with no embedder it still offers the run, and says what the run will and will not do', () => {
    // Never disabled on `canEmbed` — indexing works without a model, and
    // saying otherwise is what hid the vault behind a missing download.
    expect(panel).toMatch(/disabled=\{running\}/);
    expect(panel).not.toMatch(/disabled=\{!canEmbed/);
    expect(panel).toMatch(/Indexing still works and still finds documents by keyword/);
    expect(panel).toMatch(/Cookbook/);
  });

  it('the help card no longer points at a button that does not exist', () => {
    expect(block).toMatch(/open the Index tab/);
  });
});
