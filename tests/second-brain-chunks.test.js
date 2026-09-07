/**
 * BO-CHUNK — a long document can be found by a sentence deep inside it.
 *
 * Measured live on a 1,612-file corpus, 2026-09-07: "what must move together to
 * avoid a vault lockout" retrieved three wrong documents and the model refused
 * to fabricate. The sentence that answers it sits 4 KB into CLAUDE.md, whose one
 * vector was made from its first 280 characters. Two causes, both fixed here:
 *
 *   1. one summary vector per document — anything past the header was invisible
 *      to meaning-search (Doctrine §04);
 *   2. .html was not in the indexer's extension list — the Bible, the doctrine
 *      and every EOD report (211 files) were never indexed at all.
 *
 * Also pinned: R02 (a counting question is never answered from a subset) and
 * the gate phrasings that missed live.
 *
 * The embedder here is a bag-of-words stub: cosine similarity tracks lexical
 * overlap, so "a passage about X" ranks above "a passage about Y" — which is
 * exactly the property the test needs, without a model.
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
const { htmlToText } = require('../src/blocks/aeon_matrix/api/_lib.cjs');
const ctx = require('../src/kernel/context.cjs');

/** Deterministic bag-of-words embedding: 64 dims, hashed word counts, L2-normalised. */
const bow = async (text) => {
  const v = new Array(64).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return { vector: v.map(x => x / n), model: 'bow-stub' };
};

let root, vault, dataRoot, servers;
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const write = (rel, body) => {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};
// Filler that shares no words with the needle, so the header cannot match it.
const filler = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} discusses quarterly logistics scheduling and warehouse throughput planning for the regional team.`).join('\n\n');

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chunks-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const scan = async () => {
  const router = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow });
  return router.runSecondBrainScan();
};

describe('chunkText', () => {
  it('covers the whole text with overlapping windows and respects the cap', () => {
    const text = filler(400);
    const w = ingestMod.chunkText(text);
    expect(w.length).toBeGreaterThan(1);
    expect(w.length).toBeLessThanOrEqual(ingestMod.CHUNK_CAP);
    expect(w[0].s).toBe(0);
    for (let i = 1; i < w.length; i++) expect(w[i].s).toBeLessThan(w[i - 1].e); // overlap
    for (const x of w) expect(x.e - x.s).toBeLessThanOrEqual(ingestMod.CHUNK_CHARS);
  });

  it('a short text is a single window', () => {
    expect(ingestMod.chunkText('short')).toEqual([{ s: 0, e: 5 }]);
  });
});

describe('the index carries windows for long documents only', () => {
  it('writes a sidecar with one record per long document and none for short ones', async () => {
    write('long.md', `# Header\n\n${filler(60)}\n\nThe vault master key and the keyslot file are two halves; move both or neither.\n\n${filler(20)}`);
    // Long enough to be indexed at all (the scan skips near-empty files),
    // short enough to need no windows.
    write('short.md', '# Tiny\nA single short note about the vault keyslot bridge decision, nothing more.');
    const r = await scan();
    expect(r.ingested).toBe(2);
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    expect(Object.keys(side)).toEqual(['long.md']);
    expect(side['long.md'].model).toBe('bow-stub');
    expect(side['long.md'].chunks.length).toBeGreaterThan(3);
    const idx = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(idx.documents['long.md'].chunks).toBe(side['long.md'].chunks.length);
    expect(idx.documents['short.md'].chunks).toBe(0);
  });

  it('drops the sidecar record when the file is deleted', async () => {
    write('long.md', filler(80));
    await scan();
    fs.rmSync(path.join(vault, 'long.md'));
    const r = await scan();
    expect(r.deleted).toBe(1);
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    expect(side['long.md']).toBeUndefined();
  });

  it('backfills windows for a document indexed before they existed', async () => {
    write('long.md', filler(80));
    await scan();
    // Simulate an index from before BO-CHUNK: vector present, no `chunks` field.
    const idxPath = path.join(dataRoot, 'vault_index.json');
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    delete idx.documents['long.md'].chunks;
    fs.writeFileSync(idxPath, JSON.stringify(idx));
    fs.rmSync(path.join(dataRoot, 'vault_chunks.json'));
    // Stores are process-wide per data root, so an on-disk edit is invisible
    // until the process forgets what it loaded — which is what a restart onto
    // a newer AEON does.
    ingestMod._resetStores();
    const r = await scan();
    expect(r.ingested).toBe(1);   // the backfill, not a re-index
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    expect(side['long.md'].chunks.length).toBeGreaterThan(1);
  });
});

describe('one scan at a time', () => {
  it('a second scan joins the one in flight instead of racing it', async () => {
    for (let i = 0; i < 6; i++) write(`doc-${i}.md`, filler(40));
    let embeds = 0;
    const slow = async (t) => { embeds++; await new Promise(r => setTimeout(r, 5)); return bow(t); };
    const router = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: slow });
    const events = [];
    const [a, b] = await Promise.all([
      router.runSecondBrainScan(),
      router.runSecondBrainScan((e) => events.push(e)),
    ]);
    expect(b).toBe(a);                                   // same result object — it joined
    expect(events.some(e => e.joined)).toBe(true);
    expect(a.ingested).toBe(6);
    // Every document embedded once (summary + windows), not twice.
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    const windows = Object.values(side).reduce((n, r) => n + r.chunks.length, 0);
    expect(embeds).toBe(6 + windows);
  });
});

describe('a targeted ingest is not lost, whichever starts first', () => {
  it('ingest/document BEFORE the scan starts survives the scan checkpointing', async () => {
    for (let i = 0; i < 12; i++) write(`doc-${i}.md`, filler(40));
    let embeds = 0;
    const slow = async (t) => { embeds++; await new Promise(r => setTimeout(r, 6)); return bow(t); };
    const router = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: slow });
    const app = express(); app.use(express.json()); app.use('/api', router);
    const h = await listen(app); servers.push(h.server);

    write('early.md', `# Early\n\n${filler(30)}\n\nThe vault master key and keyslot file are two halves.`);
    // The route has READ the index (its first embed call proves it —
    // readIndex() precedes buildEntry()) before the scan starts. Stated
    // plainly: this test does NOT fail against the previous per-caller-copy
    // code, because the scan's own walk finds early.md on disk and ingests it
    // itself — so the live loss (a document erased between two checkpoints)
    // is not reproduced here. It stands as a regression guard on the single
    // owner design, not as proof of the old defect. The earlier commit message
    // that said otherwise was wrong.
    const early = fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/ingest/document`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: 'early.md' }),
    });
    while (embeds < 1) await new Promise(r => setTimeout(r, 2));
    const scanning = router.runSecondBrainScan();
    expect((await early).status).toBe(200);
    await scanning;

    const idx = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(idx.documents['early.md'], 'the early ingest was erased by the scan').toBeTruthy();
    expect(idx.documents['early.md'].chunks).toBeGreaterThan(0);
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    expect(side['early.md']?.chunks?.length).toBeGreaterThan(0);
  });

  it('ingest/document lands in the in-flight index and survives the scan finishing', async () => {
    for (let i = 0; i < 12; i++) write(`doc-${i}.md`, filler(40));
    const slow = async (t) => { await new Promise(r => setTimeout(r, 8)); return bow(t); };
    const router = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: slow });
    const app = express(); app.use(express.json()); app.use('/api', router);
    const h = await listen(app); servers.push(h.server);

    const scanning = router.runSecondBrainScan();
    await new Promise(r => setTimeout(r, 60));                 // scan is mid-loop
    write('late.md', `# Late\n\n${filler(30)}\n\nThe vault master key and keyslot file are two halves.`);
    const r = await fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/ingest/document`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: 'late.md' }),
    });
    expect(r.status).toBe(200);
    await scanning;

    const idx = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(idx.documents['late.md'], 'the targeted ingest was overwritten by the scan checkpoint').toBeTruthy();
    expect(idx.documents['late.md'].chunks).toBeGreaterThan(0);
    // And the scan's own work is intact too.
    expect(Object.keys(idx.documents).filter(k => k.startsWith('doc-')).length).toBe(12);
  });
});

describe('two factory instances over one data root share one index', () => {
  // The live failure: the boot sync ran in one instance of the ingest router and
  // an HTTP ingest landed in another. Each held its own copy; the scan's
  // checkpoint erased the ingested document. Instance count must not matter.
  it('a document ingested through instance B survives a scan run by instance A', async () => {
    for (let i = 0; i < 10; i++) write(`doc-${i}.md`, filler(40));
    let embeds = 0;
    const slow = async (t) => { embeds++; await new Promise(r => setTimeout(r, 6)); return bow(t); };
    const A = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: slow });
    const B = ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: slow });
    const app = express(); app.use(express.json()); app.use('/api', B);
    const h = await listen(app); servers.push(h.server);

    const scanning = A.runSecondBrainScan();            // A loads its copy first
    while (embeds < 2) await new Promise(r => setTimeout(r, 2));
    write('viaB.md', `# Via B\n\n${filler(30)}\n\nThe vault master key and keyslot file are two halves.`);
    const r = await fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/ingest/document`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: 'viaB.md' }),
    });
    expect(r.status).toBe(200);
    await scanning;

    const idx = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(idx.documents['viaB.md'], 'ingested through B, erased by A').toBeTruthy();
    expect(idx.documents['viaB.md'].chunks).toBeGreaterThan(0);
    const side = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_chunks.json'), 'utf8'));
    expect(side['viaB.md']?.chunks?.length).toBeGreaterThan(0);
  });
});

describe('retrieval finds a sentence deep inside a long document', () => {
  const needle = 'The vault master key and the keyslot file are two halves; move both or neither.';

  async function mountRetrieve() {
    const app = express();
    app.use(express.json());
    app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow, kernelLLM: null }));
    const h = await listen(app);
    servers.push(h.server);
    return async (query, k) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/retrieve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, k }),
      });
      return r.json();
    };
  }

  it('returns the matching passage, not the file header', async () => {
    write('CLAUDE.md', `# Working Memory\n\nCanonical reference — read before any build order.\n\n${filler(60)}\n\n${needle}\n\n${filler(20)}`);
    write('decoy.md', `# Decoy\n\n${filler(50)}`);
    await scan();
    const retrieve = await mountRetrieve();
    const out = await retrieve('what must move together to avoid a vault lockout, the master key and keyslot file', 5);
    expect(out.documents.length).toBeGreaterThan(0);
    const top = out.documents[0];
    expect(top.id).toBe('CLAUDE.md');
    expect(top.metadata.passage).toBeTruthy();
    expect(top.content).toMatch(/move both or neither/);
    // And it is the passage, not the head of the file.
    expect(top.content).not.toMatch(/Canonical reference/);
  });

  it('reports how many matched before the cut to k', async () => {
    for (let i = 0; i < 7; i++) write(`note-${i}.md`, `# Note ${i}\n\nvault keyslot master key recovery notes number ${i}.`);
    await scan();
    const retrieve = await mountRetrieve();
    const out = await retrieve('vault keyslot master key recovery', 3);
    expect(out.documents.length).toBe(3);
    expect(out.matched).toBeGreaterThanOrEqual(7);
    expect(out.k).toBe(3);
  });
});

describe('HTML is indexable text', () => {
  it('strips markup and scripts, keeps the words', () => {
    const t = htmlToText('<html><head><style>.x{}</style><script>var a=1</script></head><body><h1>Title &amp; more</h1><p>The vault<br>needs <b>both</b> halves.</p></body></html>');
    expect(t).toMatch(/Title & more/);
    expect(t).toMatch(/The vault\s*needs both halves\./);
    expect(t).not.toMatch(/<|var a=1|\.x\{\}/);
  });

  it('an .html file is indexed and searchable', async () => {
    write('bible.html', `<h1>Bible</h1>${'<p>quarterly logistics scheduling warehouse throughput planning.</p>'.repeat(40)}<p>Rotating the vault master key without rewrapping keyslots is a lockout.</p>`);
    const r = await scan();
    expect(r.ingested).toBe(1);
    const idx = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(idx.documents['bible.html']).toBeTruthy();
    expect(idx.documents['bible.html'].chunks).toBeGreaterThan(0);
  });
});

describe('R02 and the gate, in the kernel', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const stub = (body) => async () => ok(body);
  const doc = (id, content) => ({ id, content, similarity: 0.7, metadata: { source: id, path: `reports/${id}` } });

  it('tells the model it is looking at a sample', async () => {
    const r = await ctx.buildRecallContext('search my reports for build orders', {
      fetchImpl: stub({ documents: [doc('a.md', 'x'), doc('b.md', 'y')], matched: 47 }),
    });
    expect(r.matched).toBe(47);
    expect(r.context).toMatch(/Showing 2 of 47 matching documents/);
  });

  it('refuses a total on a counting question', async () => {
    const r = await ctx.buildRecallContext('how many build orders did I write in my reports', {
      fetchImpl: stub({ documents: [doc('a.md', 'x')], matched: 47 }),
    });
    expect(r.ran).toBe(true);
    expect(r.context).toMatch(/COUNTING question/);
    expect(r.context).toMatch(/Do NOT state a total/);
  });

  it('the phrasings that missed live now trip the gate', () => {
    for (const q of [
      'what did I write about the deletion protocol in the bible',
      'how many build orders did I write in my reports',
      'according to my notes, what must move together',
      'what did I decide about the ATS engine',
    ]) expect(ctx.isRecallQuery(q), q).toBe(true);
    expect(ctx.isRecallQuery('write me a haiku about tuesday')).toBe(false);
  });

  it('citations carry the path so two files with one heading are distinguishable', async () => {
    const r = await ctx.buildRecallContext('search my reports', {
      fetchImpl: stub({ documents: [
        { id: 'x/a.md', content: '1', metadata: { source: 'Lockless auth coordination', path: 'x/a.md' } },
        { id: 'y/a.md', content: '2', metadata: { source: 'Lockless auth coordination', path: 'y/a.md' } },
      ], matched: 2 }),
    });
    expect(r.citations.map(c => c.path)).toEqual(['x/a.md', 'y/a.md']);
    expect(r.context).toMatch(/Lockless auth coordination — x\/a\.md/);
  });
});
