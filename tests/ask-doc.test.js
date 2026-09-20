/**
 * BO-ASKDOC — ask about ONE document, and about all of it.
 *
 * Reported live, 2026-09-20 (operator, daily use as a phishing analyst):
 * /recall only ever showed a title, never a passage, and there was no way to
 * ask about one specific document — a 200+ page textbook loses to whatever
 * else in the Vault scored higher, and its last chapters are invisible to
 * /ask's two-windows-per-document budget. Three defects, all fixed here:
 *
 *   1. /crn/second-brain/retrieve (backs the typed /recall command) returned
 *      no `ok` and no `text` — describeCommandOutput/describeDispatchOutcome
 *      read neither, so a SUCCESSFUL /recall rendered as a failed chip
 *      ("The command returned no output and did not say why"). /ask had the
 *      same gap: `answer` existed but the chip reads `text`.
 *   2. No way to scope a question to one document — /ask always raced the
 *      whole Vault.
 *   3. No way to read a whole document rather than its best-scoring
 *      passages — the only path to the last 5% of a long book.
 *
 * The embedder here is the same bag-of-words stub second-brain-chunks.test.js
 * uses: cosine tracks lexical overlap, so a passage about X ranks above one
 * about Y without a real model.
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

const bow = async (text) => {
  const v = new Array(64).fill(0);
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return { vector: v.map((x) => x / n), model: 'bow-stub' };
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
const filler = (n, seed = 'x') => Array.from({ length: n }, (_, i) =>
  `Paragraph ${seed}${i} discusses quarterly logistics scheduling and warehouse throughput planning for the regional team.`).join('\n\n');

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-askdoc-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const scan = async () => ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow }).runSecondBrainScan();

async function mount(kernelLLM) {
  const app = express();
  app.use(express.json());
  app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed: bow, kernelLLM }));
  const h = await listen(app);
  servers.push(h.server);
  const call = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/crn/second-brain/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return {
    ask: (query, k) => call('ask', { query, k }),
    recall: (query, k) => call('retrieve', { query, k }),
    askDoc: (docPath, query) => call('ask-doc', { path: docPath, query }),
  };
}

describe('/recall and /ask render a chip instead of a silent "failure"', () => {
  it('/recall answers ok:true with a text summary carrying real content, not just a title', async () => {
    // Short enough that the whole file is the "content" (no windowing), and
    // the needle sits inside the first 160 chars of it — the summary's own
    // snippet length — so the assertion tests the summary, not the file layout.
    write('report.md', `# Quarterly Report\n\nRevenue grew fourteen percent in the region this quarter.\n\n${filler(20)}`);
    await scan();
    const { recall } = await mount(null);
    const { status, body } = await recall('revenue grew fourteen percent this quarter', 3);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);                       // was undefined — describeDispatchOutcome read it as a failed chip
    expect(body.text).toBeTruthy();                     // was absent — describeCommandOutput had nothing to show
    expect(body.text).toMatch(/Quarterly Report/);
    expect(body.text).toMatch(/fourteen percent/);       // a snippet, not only the title
  });

  it('/recall says why, in `text`, when the index has nothing embedded yet', async () => {
    write('report.md', 'unindexed content, never scanned');
    const { recall } = await mount(null);
    const { body } = await recall('anything', 3);
    expect(body.ok).toBe(true);
    expect(body.text).toMatch(/Nothing has been indexed/);
  });

  it('/ask carries its answer in `text` as well as `answer`, for the dispatched-command chip', async () => {
    write('policy.md', `# Vacation Policy\n\n${filler(20)}\n\nEmployees accrue two vacation days per month.\n\n${filler(10)}`);
    await scan();
    const llm = async (prompt) => `Employees accrue two vacation days per month [1].`;
    const { ask } = await mount(llm);
    const { body } = await ask('how many vacation days per month', 3);
    expect(body.ok).toBe(true);
    expect(body.answer).toMatch(/two vacation days/);
    expect(body.text).toMatch(/two vacation days/);      // the chip-visible field
    expect(body.text).toMatch(/\[1\] Vacation Policy/);
  });
});

describe('/ask-doc — document resolution', () => {
  it('refuses to guess when the name matches more than one document', async () => {
    write('handbook.md', filler(5, 'a'));
    write('folder/handbook.md', filler(5, 'b'));
    await scan();
    const { askDoc } = await mount(async () => 'irrelevant');
    const { body } = await askDoc('handbook', 'what does it say');
    expect(body.ok).toBe(true);
    expect(body.answered).toBe(false);
    expect(body.reason).toBe('ambiguous_doc');
    expect(body.candidates.length).toBe(2);
    expect(body.text).toMatch(/matches 2 documents/);
  });

  it('says so, and lists what IS indexed, when nothing matches', async () => {
    write('a.md', filler(5));
    await scan();
    const { askDoc } = await mount(async () => 'irrelevant');
    const { body } = await askDoc('nonexistent-file.pdf', 'what does it say');
    expect(body.reason).toBe('doc_not_found');
    expect(body.text).toMatch(/nonexistent-file\.pdf/);
  });

  it('resolves by title or bare filename without the full vault-relative path', async () => {
    write('Reading_Library/Textbooks/Intro to Networking.pdf.txt', `# Intro to Networking\n\n${filler(5)}\n\nSubnetting splits one network into smaller ones.`);
    await scan();
    const llm = async () => 'Subnetting splits one network into smaller ones [1].';
    const { askDoc } = await mount(llm);
    const { body } = await askDoc('Intro to Networking', 'what is subnetting');
    expect(body.answered).toBe(true);
    expect(body.citations[0].title).toMatch(/Intro to Networking/);
  });
});

describe('/ask-doc FAST mode — scoped to one document, ignores the rest of the Vault', () => {
  it('answers from the named document even when another document scores higher globally', async () => {
    // A decoy that would win an ordinary /ask on this exact question.
    write('decoy.md', `# Decoy\n\n${filler(10)}\n\nThe onboarding checklist mentions the badge office is on floor two.\n\n${filler(10)}`);
    write('target.md', `# Target Manual\n\n${filler(40)}\n\nThe badge office badge office badge office is a side note here, but the real answer is: reset your badge at the security desk on floor two.\n\n${filler(20)}`);
    await scan();
    const llm = async (prompt) => {
      // The prompt embeds only ONE passage — prove it came from target.md.
      expect(prompt).toMatch(/security desk/);
      expect(prompt).not.toMatch(/onboarding checklist/);
      return 'Reset your badge at the security desk on floor two [1].';
    };
    const { askDoc } = await mount(llm);
    const { body } = await askDoc('target.md', 'where do I reset my badge');
    expect(body.answered).toBe(true);
    expect(body.mode).toBe('fast');
    expect(body.citations).toEqual([{ n: 1, id: 'target.md', title: 'Target Manual' }]);
  });
});

describe('/ask-doc FULL mode — finds something outside the best-scoring passages', () => {
  it('walks every window of a long document and finds a needle near the end that FAST mode misses', async () => {
    // Long enough to produce several chunk windows (> CHUNK_CHARS).
    const needle = 'The final exam covers chapter nine and is worth forty percent of the grade.';
    const body = `# Course Syllabus\n\n${filler(90, 'mid')}\n\n${needle}\n\n${filler(5, 'tail')}`;
    write('syllabus.md', body);
    await scan();

    const calls = [];
    const llm = async (prompt) => {
      calls.push(prompt);
      // Overlapping windows can BOTH contain the needle near a chunk boundary
      // — that is correct chunking behaviour, not the thing under test.
      if (prompt.includes(needle)) return 'The final exam is worth forty percent of the grade.';
      if (prompt.startsWith('These are the relevant extracts')) {
        expect(prompt).toMatch(/forty percent/);
        return 'The final exam covers chapter nine and is worth forty percent of the grade [~ near the end of the document].';
      }
      return 'NOTHING RELEVANT';
    };
    const { askDoc } = await mount(llm);
    const { body: res } = await askDoc('syllabus.md', 'full: how much of the grade is the final exam worth');
    expect(res.answered).toBe(true);
    expect(res.mode).toBe('full');
    expect(res.answer).toMatch(/forty percent/);
    expect(res.windowsRelevant).toBeGreaterThanOrEqual(1);
    expect(res.windowsRead).toBeGreaterThan(1);          // proves it did not stop at the first window
    // One map call per window plus one reduce call.
    expect(calls.length).toBe(res.windowsRead + 1);
  });

  it('says plainly when a full read of the whole document found nothing relevant', async () => {
    write('unrelated.md', `# Unrelated\n\n${filler(30)}`);
    await scan();
    const { askDoc } = await mount(async () => 'NOTHING RELEVANT');
    const { body } = await askDoc('unrelated.md', 'full: what does chapter nine say about the exam');
    expect(body.answered).toBe(false);
    expect(body.reason).toBe('no_matches');
    expect(body.text).toMatch(/none were relevant/);
  });
});
