/**
 * Council never answers ok for a write that did not happen, and never writes
 * over a roster or history it could not read (sweep C46, 2026-09-28).
 *
 * saveMembers() and writeHistory() wrapped writeFileSync in `catch {}`: POST,
 * PUT and DELETE /council/members, /compare/:id/vote and /compare/record all
 * answered as if they had saved when nothing was written. And a members.json
 * that would not parse read as "none": GET re-seeded over the operator's
 * hand-built roster, and an add rewrote the file holding only the new member.
 *
 * The real router over a scratch data folder; no model is asked anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-council-home-'));
process.env.AEON_HOME = path.join(tmpHome, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmpHome, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmpHome, '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const API = require.resolve('../src/blocks/council/api/index.cjs');
// chmod does not stop root, and Windows ignores the mode bits.
const canMakeReadOnly = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);

let scratch, server, base;
const membersFile = () => path.join(scratch, 'council', 'members.json');
const historyFile = () => path.join(scratch, 'council', 'compare', 'history.json');

beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-council-'));
  delete require.cache[API];
  const router = require(API)({
    getDataFile: (name) => { const p = path.join(scratch, name); fs.mkdirSync(p, { recursive: true }); return p; },
    kernelLLM: async () => 'unused',
    VAULT_ROOT: path.join(scratch, 'vault'),
    // Seeding lists models; no registry, no network.
    _endpoints: { load: async () => ({ endpoints: [], roles: {} }) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  for (const f of [membersFile(), historyFile()]) { try { fs.chmodSync(f, 0o644); } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
};
const asides = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.unreadable-`));

const ROSTER = [
  { id: 'a', label: 'The Skeptic', persona: 'doubts', provider: 'groq', model: 'm1', chair: true },
  { id: 'b', label: 'The Builder', persona: 'ships', provider: 'groq', model: 'm1', chair: false },
];

describe.skipIf(!canMakeReadOnly)('a write that fails is a failure', () => {
  beforeEach(() => {
    fs.writeFileSync(membersFile(), JSON.stringify(ROSTER));
    fs.chmodSync(membersFile(), 0o444);
  });

  it('adding a councilor answers 500 with the reason, not ok', async () => {
    const r = await call('POST', '/council/members', { label: 'New', provider: 'groq', model: 'm1' });
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/members\.json could not be saved/);
  });

  it('editing and removing a councilor answer 500 too', async () => {
    const put = await call('PUT', '/council/members/b', { label: 'Renamed' });
    expect(put.status).toBe(500);
    const del = await call('DELETE', '/council/members/b');
    expect(del.status).toBe(500);
    expect(JSON.parse(fs.readFileSync(membersFile(), 'utf8'))).toEqual(ROSTER);
  });

  it('a vote or a record that cannot be kept is not answered as kept', async () => {
    fs.writeFileSync(historyFile(), JSON.stringify([
      { id: 'c1', prompt: 'p', models: ['x', 'y'], model_names: ['x', 'y'], winner: null },
    ]));
    fs.chmodSync(historyFile(), 0o444);
    const vote = await call('POST', '/compare/c1/vote', { winner: 'x' });
    expect(vote.status).toBe(500);
    expect(vote.body.error).toMatch(/history\.json could not be saved/);
    const rec = await call('POST', '/compare/record', { models: ['x', 'y'], winner: 'y' });
    expect(rec.status).toBe(500);
    expect(rec.body.status).not.toBe('ok');
  });
});

describe('an unreadable roster is kept, never written over', () => {
  const HAND_BUILT = JSON.stringify(ROSTER, null, 2).replace(/\n]$/, ',\n]'); // one trailing comma

  it('GET moves it aside, names it, and does not re-seed over it', async () => {
    fs.writeFileSync(membersFile(), HAND_BUILT);
    const r = await call('GET', '/council/members');
    expect(r.status).toBe(200);
    expect(r.body.notice).toMatch(/members\.json could not be read.*kept as members\.json\.unreadable-/);
    const kept = asides(membersFile());
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(membersFile()), kept[0]), 'utf8')).toBe(HAND_BUILT);
  });

  it('an add on a truncated roster keeps the old file instead of replacing it with one member', async () => {
    const truncated = '[{"id":"a","label":"A"';
    fs.writeFileSync(membersFile(), truncated);
    const r = await call('POST', '/council/members', { label: 'New', provider: 'groq', model: 'm1' });
    expect(r.status).toBe(200);
    expect(r.body.notice).toMatch(/kept as members\.json\.unreadable-/);
    const kept = asides(membersFile());
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(membersFile()), kept[0]), 'utf8')).toBe(truncated);
  });

  it('an unreadable compare history is kept too', async () => {
    fs.writeFileSync(historyFile(), '[{"id":"c1"');
    const r = await call('POST', '/compare/record', { models: ['x', 'y'], winner: 'y' });
    expect(r.status).toBe(200);
    expect(asides(historyFile())).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(historyFile(), 'utf8'))).toHaveLength(1);
  });
});
