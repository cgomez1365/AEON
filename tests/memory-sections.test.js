/**
 * /memory and /recall treat a category word as a SECTION.
 *
 * Reported live, 2026-09-20: 7 memories with category "preference";
 * `/memory preference` returned 0 (text-substring only), `/recall preferences`
 * returned "Found 7, showing 5" by similarity rank, and the narrator — handed
 * a truncated summary — invented the missing entries. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const memoryFactory = require('../src/blocks/memory_core/api/memory.cjs');
const retrieveFactory = require('../src/blocks/aeon_matrix/api/retrieve.cjs');
const { narrate } = require('../src/kernel/commandNarrator.cjs');

let root, vault, servers;
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

// Stored OUT of order on purpose: timestamps run against the numbering, so
// ordering by the leading number is the only way to read them 1..7.
const PREF_TEXT = [
  'Preference 1. Answers are terse and direct, no preamble.',
  'Preference 2. Show only the changed blocks, with file path and line numbers.',
  'Preference 3. Challenge the operator when the operator is wrong.',
  'Preference 4. Revenue first: every recommendation carries a dollar consequence.',
  'Preference 5. Plain words over jargon.',
  'Preference 6. Verify by running the real thing before claiming it works.',
  'Preference 7. Never claim a result that was not measured.',
];
const fixture = () => {
  const now = Date.now();
  const prefs = PREF_TEXT.map((text, i) => ({
    id: `p${i + 1}`, text, category: 'preference', type: null, title: null, tags: [],
    pinned: false, timestamp: now + i * 1000, source: 'api', refs: [],
  }));
  return [
    { id: 'i1', text: 'The operator is a self-taught sole developer.', category: 'identity', type: null, title: null, tags: [], pinned: false, timestamp: now, source: 'api', refs: [] },
    { id: 'j1', text: 'Project Alpha is the store launch.', category: 'project', type: null, title: null, tags: [], pinned: false, timestamp: now, source: 'api', refs: [] },
    ...prefs,
  ];
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-memsec-'));
  vault = path.join(root, 'Vault');
  const dir = path.join(vault, 'Agents', 'Aeon', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify(fixture()));
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

async function mount() {
  const app = express();
  app.use(express.json());
  // An embedder that throws: a section lookup must never reach it.
  const embed = async () => { throw new Error('embedder must not be called for a section lookup'); };
  app.use('/api', memoryFactory({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
  app.use('/api', retrieveFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: path.join(root, 'data'), embed }));
  const h = await listen(app);
  servers.push(h.server);
  const base = `http://127.0.0.1:${h.port}/api`;
  return {
    memory: async (q) => (await fetch(`${base}/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json(),
    recall: async (query) => (await fetch(`${base}/crn/second-brain/retrieve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
    })).json(),
  };
}

describe('/memory <category word> is a section filter', () => {
  it('"preference" returns all 7, ordered by leading number', async () => {
    const { memory } = await mount();
    const out = await memory('preference');
    expect(out.count).toBe(7);
    expect(out.memories.map(m => m.text.slice(0, 12))).toEqual([1, 2, 3, 4, 5, 6, 7].map(n => `Preference ${n}`));
  });
  it('tolerates plural and case: "Preferences"', async () => {
    const { memory } = await mount();
    expect((await memory('Preferences')).count).toBe(7);
  });
  it('matches the CATEGORY field, not the text: entries that never say "preference"', async () => {
    const dir = path.join(vault, 'Agents', 'Aeon', 'memory');
    const mk = (id, text, category, ts) => ({ id, text, category, type: null, title: null, tags: [], pinned: false, timestamp: ts, source: 'api', refs: [] });
    fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify([
      mk('a', 'Likes terse answers.', 'preference', 300),
      mk('b', 'Likes dark mode.', 'preference', 100),
      mk('c', 'Lives in a warm place.', 'identity', 200),
    ]));
    const { memory } = await mount();
    const out = await memory('preference');
    expect(out.count).toBe(2);
    expect(out.memories.map(m => m.id)).toEqual(['b', 'a']); // no leading number -> oldest first
  });
  it('"preference 6" returns only entry 6', async () => {
    const { memory } = await mount();
    const out = await memory('preference 6');
    expect(out.memories.map(m => m.id)).toEqual(['p6']);
  });
  it('free text still does substring search', async () => {
    const { memory } = await mount();
    const out = await memory('store launch');
    expect(out.count).toBe(1);
    expect(out.memories[0].id).toBe('j1');
  });
  it('carries a full-text `text` rendering with every entry, untruncated', async () => {
    const { memory } = await mount();
    const out = await memory('preferences');
    for (const t of PREF_TEXT) expect(out.text).toContain(t);
  });
});

describe('/recall <section> resolves from the memory store, not the vector index', () => {
  it('"preferences" returns all 7 in order, in full, with no cap of 5', async () => {
    const { recall } = await mount();
    const out = await recall('preferences');
    expect(out.ok).toBe(true);
    for (const t of PREF_TEXT) expect(out.text).toContain(t);
    const order = PREF_TEXT.map(t => out.text.indexOf(t));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.text).not.toMatch(/showing 5/);
    expect(out.count).toBe(7);
  });
  it('"preferences 6 and 7" returns exactly those two', async () => {
    const { recall } = await mount();
    const out = await recall('preferences 6 and 7');
    expect(out.count).toBe(2);
    expect(out.text).toContain(PREF_TEXT[5]);
    expect(out.text).toContain(PREF_TEXT[6]);
    expect(out.text).not.toContain(PREF_TEXT[0]);
  });
  it('"preference 9" says there is no such entry instead of guessing', async () => {
    const { recall } = await mount();
    const out = await recall('preference 9');
    expect(out.text).toMatch(/No preference entry numbered 9/);
  });
  it('other sections resolve too ("identity", "projects")', async () => {
    const { recall } = await mount();
    expect((await recall('identity')).text).toContain('self-taught');
    expect((await recall('projects')).text).toContain('Project Alpha');
  });
});

describe('the narrator hands the chat model the whole list', () => {
  it('a verbatim result over 400 chars is passed through, not summarised by a model', async () => {
    const { recall } = await mount();
    const out = await recall('preferences');
    expect(out.text.length).toBeGreaterThan(400);
    const llm = async () => { throw new Error('model must not paraphrase a verbatim list'); };
    const n = await narrate({ cmd: '/recall', ok: true, text: out.text, data: out }, llm);
    expect(n.source).toBe('handler');
    expect(n.narration).toBe(out.text.trim());
  });
  it('the model prompt marks a truncated message with counts and forbids filling gaps', () => {
    const { buildPrompt } = require('../src/kernel/commandNarrator.cjs');
    const p = buildPrompt({ cmd: '/x', ok: true, text: 'a'.repeat(3000), data: null });
    expect(p).toMatch(/truncated: showing 1000 of 3000/);
    expect(p).toMatch(/never (fill|infer|list)/i);
  });
});
