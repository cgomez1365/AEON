/**
 * BO-MEM T1 — conversations do not enter the record on their own.
 *
 * Second Brain Doctrine R09. This was not a hypothetical: saved sessions live at
 * Vault/Agents/Aeon/chat_sessions/*.json, INDEXABLE_EXT matches .json, and the
 * boot scan runs on every start — so every saved chat, INCLUDING the model's own
 * turns, was embedded into the operator's record automatically. The client makes
 * it worse than it looks: saveSession() filters user and assistant turns only to
 * check the count, then posts the WHOLE feed.
 *
 * An assistant turn stored as an ordinary document becomes a source a later
 * answer can cite — a fabrication laundered into the record, which is R01's
 * failure mode arriving through the back door.
 *
 * The prune is deliberately narrow, and the second test is why: Agents/ as a
 * whole must STAY indexed. Council debates, VP's memories and fleet missions are
 * written into the shared Vault on purpose so the Second Brain can find them
 * (CEO decision P0-07, 2026-08-16). Pruning the parent would delete a feature
 * and call it a security fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ingestFactory = require('../src/blocks/aeon_matrix/api/ingest.cjs');
beforeEach(() => { ingestFactory._resetStores(); });
const secondBrainFactory = require('../src/blocks/aeon_matrix/api/index.cjs');

const temps = [];
afterEach(() => {
  while (temps.length) {
    try { fs.rmSync(temps.pop(), { recursive: true, force: true }); } catch {}
  }
});

function seedVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-r09-'));
  temps.push(root);
  const vault = path.join(root, 'Vault');
  const dataRoot = path.join(root, 'data');

  const write = (rel, body) => {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
    return full;
  };

  // An ordinary document — the thing the Second Brain is for.
  write('notes.md', '# Vault keyslots\nThe master key and the keyslot file are two halves; move both or neither.');

  // A saved conversation, carrying an assistant turn. This is the shape the
  // dashboard actually writes.
  write('Agents/Aeon/chat_sessions/2026-09-06T19-42-11-000Z.json', JSON.stringify({
    id: '2026-09-06T19-42-11-000Z',
    name: 'Chat — Sep 6, 7:42 PM',
    messages: [
      { type: 'msg', role: 'user', content: 'what is the deletion protocol' },
      { type: 'msg', role: 'assistant', content: 'The deletion protocol has four steps and I am inventing this sentence.' },
    ],
  }, null, 2));

  // Deliberately shared agent material — P0-07 says this MUST stay indexed.
  write('Agents/Aeon/memory/notes-from-council.md', '# Council debate\nThe panel agreed the envelope keyslot bridge ships first.');

  return { root, vault, dataRoot };
}

/** Run a scan with the embedder stubbed — this test is about what gets WALKED. */
async function scan({ vault, dataRoot }) {
  const router = ingestFactory({
    isVercel: false,
    VAULT_ROOT: vault,
    DATA_ROOT: dataRoot,
    embed: async () => ({ vector: [0.1, 0.2, 0.3], model: 'stub-embed' }),
  });
  const result = await router.runSecondBrainScan();
  const indexPath = path.join(dataRoot, 'vault_index.json');
  const index = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    : { documents: {} };
  return { result, docs: Object.keys(index.documents || {}) };
}

describe('R09 — a conversation is not in the record until the operator says so', () => {
  it('the automatic scan does not index saved chat sessions', async () => {
    const { docs } = await scan(seedVault());
    const chats = docs.filter(d => d.includes('chat_sessions'));
    expect(chats, `these conversations were auto-indexed: ${chats.join(', ')}`).toEqual([]);
  });

  // A test asserting the assistant's SENTENCE is absent from vault_index.json
  // was written here and deleted: it passed with the defect present. The index
  // stores a 280-character summary of the JSON envelope, not the transcript, so
  // the model's words were never in that file — while the document itself was
  // indexed, matchable, and read back in full at query time. A green check that
  // cannot fail is the class BO-H closed. The assertion above, on the indexed
  // document list, is the one that reproduces the defect.

  it('ordinary documents are still indexed', async () => {
    const { docs } = await scan(seedVault());
    expect(docs).toContain('notes.md');
  });

  it('the rest of Agents/ stays indexed — P0-07 is not collateral damage', async () => {
    // Council debates, VP memories and fleet missions live under Agents/ on
    // purpose, so the Second Brain can find them. A fix that pruned the parent
    // would remove that feature while appearing to tighten security.
    const { docs } = await scan(seedVault());
    expect(docs).toContain('Agents/Aeon/memory/notes-from-council.md');
  });
});

describe('the graph does not draw conversations either', () => {
  // The scan prune alone is not enough: the graph route walks the directory
  // itself and used a bare-name exclusion list that never contained Agents —
  // while its own comment claimed agent memory was "never graph nodes".
  it('omits chat_sessions and keeps the rest of Agents/', async () => {
    const { vault, dataRoot } = seedVault();
    const app = express();
    app.use('/api', secondBrainFactory({ VAULT_ROOT: vault, DATA_ROOT: dataRoot }));
    const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/crn/second-brain/graph`);
      const raw = JSON.stringify(await r.json());
      expect(raw).not.toMatch(/chat_sessions/);
      expect(raw).toMatch(/notes-from-council/);
    } finally { server.close(); }
  });
});

describe('the prune is declared where a reader will find it', () => {
  it('names the conversation directory, not the whole Agents tree', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src/blocks/aeon_matrix/api/ingest.cjs'),
      'utf8',
    );
    expect(src).toMatch(/'Agents\/Aeon\/chat_sessions'/);
    // If someone ever widens it to the parent, this fails and they have to
    // come and read P0-07 first.
    expect(src).not.toMatch(/NON_INDEXED_VAULT_PATHS[\s\S]{0,200}'Agents'\s*,/);
  });
});
