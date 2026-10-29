/**
 * AEON's own logs are not knowledge.
 *
 * Found filming 2026-10-29 (3.5.1, Phi-4 Mini Q4, Local only): /ask and Orion
 * answers cited Agents/Aeon/missions/log.json, the mission log that holds the
 * operator's earlier prompts (agents.recordMission), and saved chats, and the
 * small local model followed them off topic. The scan indexed every .json
 * under Agents/ except Agents/<agent>/chat_sessions.
 *
 * Narrow on purpose (P0-07): agents' memories, notes, council debates and
 * mission write-ups stay indexed. Only the mission log and saved-chat folders
 * (at any depth) leave. Drives the REAL ingest and retrieve routers against a
 * temp Vault with a stub embedder.
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
const vaultPrivacy = require('../src/kernel/vaultPrivacy.cjs');

let root, vault, dataRoot, servers;
const embed = async () => ({ vector: [1, 0, 0], model: 'stub' });
const scan = () => ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }).runSecondBrainScan();
const indexed = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8')).documents).sort();
const write = (rel, body) => {
  const full = path.join(vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}/api`); });
});
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();

const KEPT = [
  'Agents/Aeon/memory/on1.md',
  'Agents/Aeon/missions/spring-launch.md',
  'Agents/Scout/notes/suppliers.md',
  'Agents/council/debates/pricing.md',
  'Saved_Artifacts/welcome.md',
];
const LOGS = [
  'Agents/Aeon/missions/log.json',
  'Agents/Scout/missions/log.json',
  'Saved_Artifacts/old_export/chat_sessions/2026-10-29T19-01-57-369Z.json',
];

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-machine-records-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  servers = [];
  write('Agents/Aeon/memory/on1.md', '# Bike shop\nThe shop is Velocity Cycles and the spring sale starts in April.\n');
  write('Agents/Aeon/missions/spring-launch.md', '# Spring launch\n- [done] newsletter draft\n');
  write('Agents/Scout/notes/suppliers.md', '# Suppliers\nTires come from the Larkspur depot.\n');
  write('Agents/council/debates/pricing.md', '# Pricing debate\nThe council kept tune-ups at forty dollars.\n');
  write('Saved_Artifacts/welcome.md', '# Welcome\nSpring is here at Velocity Cycles.\n');
  write('Agents/Aeon/missions/log.json', [{ at: '2026-10-29T19:00:00Z', asked: 'Write a two-sentence welcome for a bike shop', provider: 'local', ok: true }]);
  write('Agents/Scout/missions/log.json', [{ at: '2026-10-29T19:01:00Z', asked: 'list suppliers', ok: true }]);
  write('Saved_Artifacts/old_export/chat_sessions/2026-10-29T19-01-57-369Z.json', { id: 'x', messages: [{ role: 'assistant', content: 'an old answer' }] });
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  ingestMod._resetStores();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isMachineRecord', () => {
  it('mission logs and saved-chat folders, at any depth and any case; nothing else under Agents/', () => {
    for (const p of [...LOGS, 'agents/aeon/Missions/LOG.json', 'Agents/Aeon/chat_sessions', 'Notes/chat_sessions/a.json']) {
      expect(vaultPrivacy.isMachineRecord(p), p).toBe(true);
    }
    for (const p of [...KEPT, 'Agents/Aeon/missions', 'Agents/Aeon/missions/log.md', 'Notes/missions/log.json', 'Agents/Aeon/memory/log.json', 'Notes/chat_sessions_notes.md']) {
      expect(vaultPrivacy.isMachineRecord(p), p).toBe(false);
    }
  });
});

describe('the scan', () => {
  it('indexes agents\' memories and notes, never a mission log or a saved chat', async () => {
    await scan();
    expect(indexed()).toEqual([...KEPT].sort());
  });

  it('takes a mission log an older scan indexed out of the index', async () => {
    const doc = (p) => ({ path: p, title: p, summary: 'x', tags: [], type: 'json', embedding: [1, 0, 0], embeddingModel: 'stub', chunks: 0 });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'vault_index.json'), JSON.stringify({ documents: { 'Agents/Aeon/missions/log.json': doc('Agents/Aeon/missions/log.json') } }));
    const r = await scan();
    expect(indexed()).toEqual([...KEPT].sort());
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(r.withheld).toBe(0);
  });
});

describe('/retrieve (what /ask, recall and Orion read)', () => {
  it('a mission log still listed in an old index is never a candidate', async () => {
    const doc = (p, summary) => ({ path: p, title: p, summary, tags: [], type: 'md', embedding: [1, 0, 0], embeddingModel: 'stub', chunks: 0 });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'vault_index.json'), JSON.stringify({ documents: {
      'Saved_Artifacts/welcome.md': doc('Saved_Artifacts/welcome.md', 'Spring is here at Velocity Cycles.'),
      'Agents/Aeon/missions/log.json': doc('Agents/Aeon/missions/log.json', 'Write a two-sentence welcome for a bike shop'),
      'Saved_Artifacts/old_export/chat_sessions/2026-10-29T19-01-57-369Z.json': doc('Saved_Artifacts/old_export/chat_sessions/2026-10-29T19-01-57-369Z.json', 'an old answer'),
    } }));
    const app = express();
    app.use(express.json());
    app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }));
    const base = await listen(app);
    const out = await post(`${base}/crn/second-brain/retrieve`, { query: 'welcome for a bike shop', k: 10 });
    expect(out.documents.map((d) => d.id)).toEqual(['Saved_Artifacts/welcome.md']);
  });
});
