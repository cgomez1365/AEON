/**
 * Aeon Matrix from the terminal — the three things the CEO's blind test hit
 * (2026-09-22 session transcript), driven through the REAL dispatcher and the
 * REAL block routes, rendered through the REAL chip decision table.
 *
 *   1. /index-brain and /scan ran, indexed, and the chip said "Nothing to
 *      show — the command ran and found no entries." scan-docs answers SSE;
 *      the dispatcher reads JSON, found none, and passed `{}` to the chip.
 *   2. /doc state.md → 404 "Not found" in 44 ms, one line after /recall pestle
 *      had found blocks/research/state.md. /doc wanted the exact Vault path,
 *      and the 404 lit the global red "[API FAILED] /api/commands/dispatch"
 *      banner on top of the chip. A saved chat, /doc <file>.json, same.
 *   3. Matrix ▸ Graph ▸ click a Council debate ▸ Edit ▸ Save → "❌ Error: File
 *      not found" above the file's full content. The graph speaks
 *      "Vault/<relative>" ids; /document strips that prefix, the Save route
 *      (PUT ingest/document) did not, and looked for <Vault>/Vault/…
 *
 * The embedder is the bag-of-words stub ask-doc.test.js uses — no model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

// Before any require that reaches endpoints.cjs — it provisions its secrets
// dir at module scope, and this suite must not touch the checkout's.
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-matrix-cmds-secrets-'));

const require = createRequire(import.meta.url);
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');
const indexFactory = require('../src/blocks/aeon_matrix/api/index.cjs');
const retrieveFactory = require('../src/blocks/aeon_matrix/api/retrieve.cjs');
const commandRegistryFactory = require('../src/kernel/commandRegistry.cjs');
const { describeCommandOutput, describeDispatchOutcome, CHIP_STATUS } = await import('../src/utils/commandOutcome.js');
const { shouldBannerResponse } = await import('../src/utils/interceptorPolicy.js');

const bow = async (text) => {
  const v = new Array(64).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return { vector: v.map((x) => x / n), model: 'bow-stub' };
};

let root, vault, dataRoot, servers, savedPort, base;
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const write = (rel, body) => {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};

beforeEach(async () => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-matrix-cmds-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  servers = [];

  write('blocks/research/state.md', '# Research block state — PESTLE scan\n\nPolitical: freight digitisation grants. Economic: diesel price volatility.');
  write('Reading_Library/Security/phishing-triage.md', '# Phishing triage checklist\n\nCheck SPF, DKIM and DMARC. Hover every link before clicking.');
  write('Agents/council/debates/2026-09-23T07-14-38-125Z.md', '# Council debate — three packs or ten\n\nVerdict: ship with three packs on Gumroad.');
  // Saved chats are deliberately never indexed (R09), but they ARE Vault files
  // the operator can name.
  write('Agents/Aeon/chat_sessions/2026-09-20T21-22-37-736Z.json', '{"title":"PESTLE follow-up","messages":[]}');

  // One app holding the block's routes AND the dispatcher, the way the kernel
  // mounts them — the dispatcher addresses itself through PORT.
  const kernelLLM = async (prompt) => `STUB: ${(/QUESTION: (.+)/.exec(prompt) || [])[1] || 'answer'} [1]`;
  const deps = { isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow, kernelLLM, getDataFile: (id) => path.join(dataRoot, id) };
  const app = express();
  app.use(express.json());
  app.use('/api', indexFactory(deps));
  app.use('/api', ingestMod(deps));
  app.use('/api', retrieveFactory(deps));
  const { router } = commandRegistryFactory({ blockReadiness: {}, isVercel: false, hasEmbedding: () => true });
  app.use('/api', router);
  const h = await listen(app);
  servers.push(h.server);
  savedPort = process.env.PORT;
  process.env.PORT = String(h.port);
  base = `http://127.0.0.1:${h.port}/api`;
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

async function dispatch(cmd, arg = '') {
  const r = await fetch(`${base}/commands/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, arg }),
  });
  const body = await r.json();
  return { status: r.status, body, chip: describeCommandOutput(body), outcome: describeDispatchOutcome({ status: r.status, data: body }) };
}
const scan = () => ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow }).runSecondBrainScan();

// ── 1 ─────────────────────────────────────────────────────────────────────
describe('/scan and /index-brain say what they did', () => {
  for (const cmd of ['/index-brain', '/scan']) {
    it(`${cmd}: the chip shows counts, not "Nothing to show"`, async () => {
      const r = await dispatch(cmd);
      expect(r.status).toBe(200);
      expect(r.outcome.chipStatus).toBe(CHIP_STATUS.OK);
      // The exact line the CEO saw.
      expect(r.chip).not.toMatch(/Nothing to show/);
      // Three indexable documents (the chat session is pruned by design).
      expect(r.chip).toMatch(/3 new or changed/);
      expect(r.chip).toMatch(/3 embedded/);
      expect(r.chip).toMatch(/3 documents in the index/);
      expect(r.body.data).toMatchObject({ ok: true, ingested: 3, embedded: 3, skipped: 0, deleted: 0 });
    });
  }

  it('a second run reports the Vault unchanged, and a deletion as a deletion', async () => {
    await dispatch('/scan');
    fs.rmSync(path.join(vault, 'Reading_Library/Security/phishing-triage.md'));
    const r = await dispatch('/index-brain');
    expect(r.chip).toMatch(/2 unchanged/);
    expect(r.chip).toMatch(/1 removed/);
    expect(r.chip).toMatch(/2 documents in the index/);
  });

  it('documents indexed with no embedder say they cannot be found by meaning', async () => {
    ingestMod._resetStores();
    const noEmbed = async () => { const e = new Error('No model assigned for role "embed"'); e.code = 'no_embed_model'; throw e; };
    const app = express(); app.use(express.json());
    app.use('/api', ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: path.join(root, 'data2'), embed: noEmbed }));
    const h = await listen(app); servers.push(h.server);
    const r = await fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/ingest/scan-docs?format=summary`, { method: 'POST' });
    const body = await r.json();
    expect(body.ingested).toBe(3);
    expect(body.embedded).toBe(0);
    expect(body.text).toMatch(/no embedding model/i);
  });

  it('Matrix ▸ Index still gets its event stream (no flag, no change)', async () => {
    const r = await fetch(`${base}/crn/second-brain/ingest/scan-docs`, { method: 'POST' });
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text).toMatch(/"done":true/);
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────
describe('/doc finds a document the way /ask-doc does', () => {
  it('a bare file name opens the one document with that name (the CEO\'s /doc state.md)', async () => {
    await scan();
    const r = await dispatch('/doc', 'state.md');
    expect(r.status).toBe(200);
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.OK);
    expect(r.chip).toMatch(/blocks\/research\/state\.md/);
    expect(r.chip).toMatch(/Political: freight digitisation grants/);
  });

  it('a saved chat opens by its file name even though chats are never indexed', async () => {
    const r = await dispatch('/doc', '2026-09-20T21-22-37-736Z.json');
    expect(r.status).toBe(200);
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.OK);
    expect(r.chip).toMatch(/Agents\/Aeon\/chat_sessions\/2026-09-20T21-22-37-736Z\.json/);
    expect(r.chip).toMatch(/PESTLE follow-up/);
  });

  it('a partial path and a title both resolve', async () => {
    await scan();
    expect((await dispatch('/doc', 'research/state.md')).chip).toMatch(/PESTLE scan/);
    expect((await dispatch('/doc', 'phishing triage checklist')).chip).toMatch(/DMARC/);
  });

  it('two matches are listed and neither is opened — never guesses', async () => {
    write('Projects/Northwind/state.md', '# Northwind project state\n\nContract value: $18,500.');
    await scan();
    const r = await dispatch('/doc', 'state.md');
    expect(r.status).toBe(200);
    expect(r.chip).toMatch(/matches 2 documents/);
    expect(r.chip).toMatch(/blocks\/research\/state\.md/);
    expect(r.chip).toMatch(/Projects\/Northwind\/state\.md/);
    expect(r.chip).not.toMatch(/Contract value/);
    expect(r.chip).not.toMatch(/freight digitisation/);
  });

  it('nothing found is a command failure that says what it searched — and no global banner', async () => {
    await scan();
    const r = await dispatch('/doc', 'quarterly-board-minutes.md');
    // Not an HTTP error: the dispatcher worked and the block answered.
    expect(r.status).toBe(200);
    expect(shouldBannerResponse({ url: '/api/commands/dispatch', ok: r.status < 400, status: r.status })).toBe(false);
    // …but the chip is a failure, because the block said the document is not there.
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.FAIL);
    expect(r.chip).toMatch(/Nothing in the Vault matches "quarterly-board-minutes\.md"/);
    expect(r.chip).toMatch(/file names/);
    expect(r.chip).not.toBe('Not found');
  });

  it('a folder name lists what is inside instead of claiming nothing matches', async () => {
    const r = await dispatch('/doc', 'Agents/council');
    expect(r.status).toBe(200);
    expect(r.chip).toMatch(/Agents\/council is a folder/);
    expect(r.chip).toMatch(/2026-09-23T07-14-38-125Z\.md/);
    expect(r.chip).not.toMatch(/Nothing in the Vault matches/);
  });

  it('cannot be walked out of the Vault', async () => {
    const outside = path.join(root, 'secret.md');
    fs.writeFileSync(outside, 'TOP SECRET outside the vault');
    const r = await dispatch('/doc', '../secret.md');
    expect(JSON.stringify(r.body)).not.toMatch(/TOP SECRET/);
  });

  it('the UI contract is unchanged: exact path serves, a missing exact path is still 404', async () => {
    const ok = await fetch(`${base}/crn/second-brain/document?path=${encodeURIComponent('Vault/blocks/research/state.md')}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toMatch(/PESTLE/);
    // SecondBrainVisualizer falls through to its other sources on a non-2xx.
    const miss = await fetch(`${base}/crn/second-brain/document?path=state.md`);
    expect(miss.status).toBe(404);
  });

  it('/recall lists each hit\'s Vault path, so the next /doc can name it', async () => {
    await scan();
    const r = await fetch(`${base}/crn/second-brain/retrieve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'pestle political economic grants' }),
    });
    const body = await r.json();
    expect(body.text).toMatch(/blocks\/research\/state\.md/);
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────
describe('Matrix editor Save writes back to the file it opened', () => {
  const GRAPH_ID = 'Vault/Agents/council/debates/2026-09-23T07-14-38-125Z.md';   // what the graph sends
  const REL = 'Agents/council/debates/2026-09-23T07-14-38-125Z.md';
  const put = (file_path, content) => fetch(`${base}/crn/second-brain/ingest/document`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path, content }),
  });

  it('the graph opens it and Save updates it in place (was: "File not found")', async () => {
    await scan();
    const open = await fetch(`${base}/crn/second-brain/document?path=${encodeURIComponent(GRAPH_ID)}`);
    expect(open.status).toBe(200);

    const r = await put(GRAPH_ID, '# Council debate — three packs or ten\n\nVerdict: ship three packs. Edited by the operator.');
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.file).toBe(REL);
    expect(fs.readFileSync(path.join(vault, REL), 'utf8')).toMatch(/Edited by the operator/);
  });

  it('never writes a second copy under Vault/Vault, and the index keeps one entry', async () => {
    await scan();
    await put(GRAPH_ID, '# Council debate\n\nEdited once more, still one file on disk.');
    expect(fs.existsSync(path.join(vault, 'Vault'))).toBe(false);
    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    const keys = Object.keys(index.documents).filter((k) => k.includes('2026-09-23T07-14-38-125Z'));
    expect(keys).toEqual([REL]);
  });

  it('Save on a file that is not there refuses and creates nothing', async () => {
    const r = await put('Vault/Agents/council/debates/never-existed.md', 'x'.repeat(40));
    expect(r.status).toBe(404);
    expect(fs.existsSync(path.join(vault, 'Agents/council/debates/never-existed.md'))).toBe(false);
    expect(fs.existsSync(path.join(vault, 'Vault'))).toBe(false);
  });

  it('create and delete accept the same Vault/ ids', async () => {
    const created = await fetch(`${base}/crn/second-brain/ingest/document`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: 'Vault/Notes/new-note.md', content: '# New note\n\nWritten through the Vault/ id the graph uses.' }),
    });
    expect((await created.json()).file).toBe('Notes/new-note.md');
    expect(fs.existsSync(path.join(vault, 'Notes/new-note.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, 'Vault'))).toBe(false);

    await fetch(`${base}/crn/second-brain/ingest/document`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_path: 'Vault/Notes/new-note.md' }),
    });
    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(index.documents['Notes/new-note.md']).toBeUndefined();
  });
});

// ── Audit, 2026-09-23 — the rest of the operator's loop ──────────────────
describe('the rest of the loop: ask, recall, notes with frontmatter', () => {
  it('/ask shows its sources in the chip, and says why when it cannot answer', async () => {
    await scan();
    // The manifest said display:"answer", so the dispatcher took `answer` and
    // dropped `text` — the citations never reached the chip, and an
    // unanswered /ask (no `answer` field) rendered its whole body as JSON.
    const hit = await dispatch('/ask', 'what was the council verdict on three packs or ten?');
    expect(hit.chip).toMatch(/\[1\] Council debate/);
    expect(hit.body.data.verbatim).toBe(true);   // a cited answer is relayed, not re-narrated
    const miss = await dispatch('/ask', 'zxqw plorbin frimble');
    expect(miss.chip).toMatch(/Nothing in the index/);
    expect(miss.chip).not.toMatch(/```json/);
  });

  it('/recall never says "Found 1" above a list of two', async () => {
    write('Notes/invoice-terms.md', '# Invoice terms\n\nInvoice terms are net fifteen days for all clients.');
    write('Notes/payment-policy.md', '# Payment policy\n\nClients pay each invoice on receipt; late fees after thirty days. Terms are reviewed yearly.');
    await scan();
    const r = await fetch(`${base}/crn/second-brain/retrieve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'invoice terms net fifteen days clients' }),
    });
    const { text } = await r.json();
    const listed = text.split('\n').filter((l) => /^\d+\. /.test(l)).length;
    expect(listed).toBeGreaterThanOrEqual(2);                        // precondition: a real multi-hit answer
    expect(Number((/^Found (\d+)/.exec(text) || [])[1])).toBeGreaterThanOrEqual(listed);
  });

  it('a note with YAML frontmatter is titled and summarised by its content, not its metadata', async () => {
    // memory_core mirrors every memory as <random id>.md with frontmatter and
    // no heading: /recall listed them as "1b4367dbf594", and the summary it
    // embedded began "--- id: … category: fact pinned: false created: …".
    write('Agents/Aeon/memory/1b4367dbf594.md', '---\nid: 1b4367dbf594\ncategory: fact\npinned: false\ncreated: 2026-09-23T08:40:57.366Z\nsource: api\n---\n\nThe operator\'s preferred invoice terms are net 15\n');
    write('Notes/obsidian-style.md', '---\ntitle: "Quarterly fuel review"\ntags: [fuel, q3]\n---\n\nDiesel averaged $3.91 in Q3; the fuel-cost report flags any truck above $0.62 per mile.\n');
    await scan();
    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    const mem = index.documents['Agents/Aeon/memory/1b4367dbf594.md'];
    expect(mem.title).toBe("The operator's preferred invoice terms are net 15");
    expect(mem.summary).not.toMatch(/category:|pinned:|^---/);
    const obs = index.documents['Notes/obsidian-style.md'];
    expect(obs.title).toBe('Quarterly fuel review');
    expect(obs.summary).toMatch(/^Diesel averaged/);
  });

  it('/ask-doc takes a partial path the way /doc does', async () => {
    write('Projects/Northwind/state.md', '# Northwind project state\n\nContract value: $18,500.');
    await scan();
    const r = await dispatch('/ask-doc', 'research/state.md what does the political line say?');
    expect(r.chip).not.toMatch(/matches 2 documents/);
    expect(r.chip).toMatch(/\[1\] Research block state/);
  });

  it('/ask-doc on a document that is not there is a failed chip, not a green one', async () => {
    await scan();
    const r = await dispatch('/ask-doc', 'nothing-here.md what does it say?');
    expect(r.status).toBe(200);
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.FAIL);
    expect(r.chip).toMatch(/Nothing in the index matches "nothing-here\.md"/);
  });
});

// ── What the terminal says underneath the chip ───────────────────────────
describe('the narration under the chip relays these answers instead of re-writing them', () => {
  // Terminal2 hands every command result to /api/commands/narrate, and the
  // chat model only ever sees that narration. A result over 400 characters
  // went to a model to be paraphrased — a /doc became a summary of the
  // document, a /recall list lost items (the defect `verbatim` exists for,
  // commandNarrator.cjs), and an /ask answer that a model had ALREADY written,
  // with citations, was re-written by a second call. Seen live 2026-09-23:
  // /doc research/state.md narrated as "STUB REPLY (2654 chars of prompt received)".
  const narrator = require('../src/kernel/commandNarrator.cjs');
  const relay = async (cmd, arg) => {
    const r = await dispatch(cmd, arg);
    const llm = vi.fn(async () => 'a paraphrase');
    const out = await narrator.narrate({ cmd, ok: r.outcome.kind === 'ok', text: r.body.text, data: r.body.data }, llm);
    return { out, llm, r };
  };

  it('/doc relays the document', async () => {
    write('Notes/long-note.md', `# Long note\n\n${'Dispatch reviews fuel exceptions every Monday morning. '.repeat(12)}`);
    const { out, llm, r } = await relay('/doc', 'long-note.md');
    expect(r.body.text.length).toBeGreaterThan(400);
    expect(llm).not.toHaveBeenCalled();
    expect(out.source).toBe('handler');
    expect(out.narration).toMatch(/Dispatch reviews fuel exceptions/);
  });

  it('/recall relays its list', async () => {
    write('Notes/invoice-terms.md', `# Invoice terms\n\n${'Invoice terms are net fifteen days for all clients. '.repeat(10)}`);
    write('Notes/payment-policy.md', `# Payment policy\n\n${'Clients pay each invoice on receipt; late fees after thirty days. '.repeat(10)}`);
    await scan();
    const recall = await relay('/recall', 'invoice terms clients days');
    expect(recall.r.body.text.length).toBeGreaterThan(400);
    expect(recall.llm).not.toHaveBeenCalled();
    expect(recall.out.narration).toBe(recall.r.body.text.trim());
  });
});

describe('names are typed the way people say them', () => {
  // Live, 2026-09-23: "/doc carrier handbook" → nothing matches, for a file
  // named Carrier-Handbook-2026.pdf. A PDF has no "# heading", so its title is
  // its file name, hyphens and all. The graph already treats space, hyphen and
  // underscore as one separator (index.cjs normaliseName); /doc and /ask-doc
  // did not.
  beforeEach(() => {
    write('Reading_Library/Carrier_Handbook-2026.md', 'Damaged pallets must be photographed and reported within 48 hours or the carrier claim is void.');
  });

  it('/doc carrier handbook opens Carrier_Handbook-2026.md', async () => {
    const r = await dispatch('/doc', 'carrier handbook');
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.OK);
    expect(r.chip).toMatch(/Reading_Library\/Carrier_Handbook-2026\.md/);
    expect(r.chip).toMatch(/48 hours/);
  });

  it('/ask-doc resolves the same spelling', async () => {
    await scan();
    const r = await dispatch('/ask-doc', '"carrier handbook" when must damage be reported?');
    expect(r.chip).toMatch(/\[1\] Carrier_Handbook-2026/);
  });
});

describe('entries indexed before the frontmatter fix are refreshed once', () => {
  // The title/summary fix only applies when a file is (re)indexed, and the
  // scan skips unchanged files — so every memory already in the CEO's index
  // would have kept its "1b4367dbf594" title forever. An entry whose stored
  // summary still starts with the frontmatter fence is re-derived on the next
  // scan, once, without the file having to change.
  it('an unchanged memory file indexed the old way gets its real title on the next /scan', async () => {
    const rel = 'Agents/Aeon/memory/1b4367dbf594.md';
    write(rel, '---\nid: 1b4367dbf594\ncategory: fact\npinned: false\n---\n\nThe operator\'s preferred invoice terms are net 15\n');
    await scan();
    // Rewrite the stored entry the way the old rule produced it; the file is untouched.
    ingestMod._resetStores();
    const idxFile = path.join(dataRoot, 'vault_index.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    idx.documents[rel].title = '1b4367dbf594';
    idx.documents[rel].summary = '--- id: 1b4367dbf594 category: fact pinned: false --- The operator\'s preferred invoice terms are net 15';
    fs.writeFileSync(idxFile, JSON.stringify(idx));

    const r = await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow }).runSecondBrainScan();
    const after = JSON.parse(fs.readFileSync(idxFile, 'utf8')).documents[rel];
    expect(after.title).toBe("The operator's preferred invoice terms are net 15");
    expect(after.summary).not.toMatch(/^---/);
    expect(Array.isArray(after.embedding)).toBe(true);
    expect(r.ingested).toBeGreaterThanOrEqual(1);

    // Once: the next scan leaves it alone.
    const again = await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow }).runSecondBrainScan();
    expect(again.ingested).toBe(0);
  });
});

describe('a short note is quoted from its content, not its frontmatter', () => {
  it('/recall and /ask see the memory, not "--- id: … category: …"', async () => {
    write('Agents/Aeon/memory/1b4367dbf594.md', '---\nid: 1b4367dbf594\ncategory: fact\npinned: false\ncreated: 2026-09-23T08:40:57.366Z\nsource: api\n---\n\nThe operator\'s preferred invoice terms are net 15\n');
    await scan();
    const r = await fetch(`${base}/crn/second-brain/retrieve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'preferred invoice terms net 15' }),
    });
    const body = await r.json();
    const doc = body.documents.find((d) => d.id === 'Agents/Aeon/memory/1b4367dbf594.md');
    expect(doc).toBeTruthy();
    expect(doc.content).toMatch(/^The operator's preferred invoice terms are net 15/);
    expect(body.text).not.toMatch(/category: fact/);
  });
});
