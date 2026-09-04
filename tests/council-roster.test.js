/**
 * Council roster — the chair invariants.
 *
 * The chair writes the verdict, so exactly one member holds the seat. Neither
 * end of that was enforced:
 *
 *   PUT wrote `chair` like any other editable field, so promoting a second
 *   chair produced two and the debate then used whichever find() reached
 *   first — silently, with the operator believing they had chosen.
 *
 *   DELETE removed the chair and left the council with no verdict writer, a
 *   state the UI offered no way out of because chair was not reassignable
 *   there either.
 *
 * The UI half (no edit control, no chair control, delete hidden below three
 * members) is covered by the fact that these routes are now reachable from
 * it at all; what is pinned here is the server rule, which is the one a
 * future UI cannot violate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let scratch, app, server, base;

/** Mount the real router against a scratch data dir — no vault, no network. */
async function mount() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-council-'));
  const factory = require_(path.join(ROOT, 'src', 'blocks', 'council', 'api', 'index.cjs'));
  const router = factory({
    getDataFile: (name) => {
      const p = path.join(scratch, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    // Never called by the roster routes; present so the factory is happy.
    kernelLLM: async () => 'unused',
    VAULT_ROOT: path.join(scratch, 'vault'),
  });

  app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}

const api = (method, url, body) => fetch(`${base}${url}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Write the roster directly — seeding goes through model discovery. */
function seed(members) {
  fs.writeFileSync(path.join(scratch, 'council', 'members.json'), JSON.stringify(members, null, 2));
}

const roster = () => JSON.parse(fs.readFileSync(path.join(scratch, 'council', 'members.json'), 'utf8'));

const THREE = [
  { id: 'a', label: 'The Skeptic', persona: 'doubts everything', provider: 'groq', model: 'm1', chair: true },
  { id: 'b', label: 'The Builder', persona: 'ships it', provider: 'groq', model: 'm1', chair: false },
  { id: 'c', label: 'The Historian', persona: 'remembers', provider: 'groq', model: 'm1', chair: false },
];

beforeEach(async () => { await mount(); });
afterEach(async () => {
  await new Promise((res) => server.close(res));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('council roster — exactly one chair', () => {
  it('promoting a member steps the previous chair down', async () => {
    seed(THREE);
    const r = await api('PUT', '/council/members/b', { chair: true });
    expect(r.status).toBe(200);

    const after = roster();
    expect(after.filter(m => m.chair).map(m => m.id)).toEqual(['b']);
  });

  it('refuses to demote the only chair, and says how to move it', async () => {
    seed(THREE);
    const r = await api('PUT', '/council/members/a', { chair: false });
    expect(r.status).toBe(409);

    const { error } = await r.json();
    expect(error).toMatch(/promote another member/i);
    // The refusal must not have half-applied.
    expect(roster().filter(m => m.chair).map(m => m.id)).toEqual(['a']);
  });

  it('deleting the chair passes the seat on rather than leaving none', async () => {
    seed(THREE);
    const r = await api('DELETE', '/council/members/a');
    expect(r.status).toBe(200);
    expect((await r.json()).newChair).toBeTruthy();

    const after = roster();
    expect(after).toHaveLength(2);
    expect(after.filter(m => m.chair)).toHaveLength(1);
  });

  it('deleting a non-chair leaves the chair where it was', async () => {
    seed(THREE);
    await api('DELETE', '/council/members/c');
    expect(roster().filter(m => m.chair).map(m => m.id)).toEqual(['a']);
  });

  it('deleting the last member leaves no chair to assign, and does not crash', async () => {
    seed([{ id: 'only', label: 'Solo', provider: 'groq', model: 'm1', chair: true }]);
    const r = await api('DELETE', '/council/members/only');
    expect(r.status).toBe(200);
    expect(roster()).toEqual([]);
  });
});

describe('council roster — editing', () => {
  it('name and persona are editable, which the UI never sent', async () => {
    seed(THREE);
    const r = await api('PUT', '/council/members/b', { label: 'The Pragmatist', persona: 'ships the smallest thing' });
    expect(r.status).toBe(200);

    const m = roster().find(x => x.id === 'b');
    expect(m.label).toBe('The Pragmatist');
    expect(m.persona).toBe('ships the smallest thing');
    // An edit must not disturb the seat.
    expect(m.chair).toBe(false);
    expect(roster().filter(x => x.chair).map(x => x.id)).toEqual(['a']);
  });

  it('a model reassignment is still just a model reassignment', async () => {
    seed(THREE);
    await api('PUT', '/council/members/c', { provider: 'gemini', model: 'gemini-2.5-flash' });
    const m = roster().find(x => x.id === 'c');
    expect(m.provider).toBe('gemini');
    expect(m.model).toBe('gemini-2.5-flash');
    expect(m.label).toBe('The Historian');
  });

  it('an unknown id is a 404, not a silent no-op', async () => {
    seed(THREE);
    expect((await api('PUT', '/council/members/nope', { label: 'x' })).status).toBe(404);
    expect((await api('DELETE', '/council/members/nope')).status).toBe(404);
  });
});
