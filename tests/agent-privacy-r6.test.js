/**
 * 3.3.0 review round 7 — agent identity fails closed.
 *
 *  1. A removed agent's id is never reused: re-creating "Quill" after a Local
 *     only Quill was removed made the new agent own every turn and saved chat
 *     tagged "quill", and a Roulette Quill shared them with a cloud model.
 *  2. A clash made before 3.3.0 or by hand (one agent's id is another's
 *     name): when exactly one of the two is Local only, it wins — in the
 *     kernel, in wake words and in the terminal's /agent.
 *  3. A stored reference is an id (agents.ownerOf matches ids and folders,
 *     never names). One that resolves to no single agent (removed, two
 *     hand-copied folders) is answered by the operator's own AEON as Local
 *     only, never as the operator's own AEON at Roulette.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const { resolveAgentArg } = await import('../src/utils/terminalAgent.js');

let vault;
beforeEach(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-privacy-r6-')); });
afterEach(() => { try { fs.rmSync(vault, { recursive: true, force: true }); } catch {} });
const all = () => agents.list(vault, { withStats: false });
const handAgent = (folder, rec) => {
  fs.mkdirSync(path.join(vault, 'Agents', folder, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Agents', folder, 'agent.json'), JSON.stringify(rec));
};

describe('a removed agent\'s id is never reused', () => {
  it('re-creating the name gets a new id, and the old private turns stay private', () => {
    agents.create(vault, { name: 'Quill', privacy: 'local-only' });
    agents.remove(vault, 'quill');
    const again = agents.create(vault, { name: 'Quill' });           // Roulette this time
    expect(again.id).not.toBe('quill');
    expect(again.folder).toMatch(/^Quill_[0-9a-f]{4}$/);
    const feed = [
      { role: 'user', content: 'PRIVATE-R6 question', agent: 'quill' },
      { role: 'assistant', content: 'PRIVATE-R6 answer', agent: 'quill' },
      { role: 'user', content: 'hello', agent: again.id },
    ];
    const shared = agents.shareableTurns(feed, null, all());
    expect(JSON.stringify(shared)).not.toContain('PRIVATE-R6');
    expect(agents.ownerOf(vault, 'quill', all())).toMatchObject({ self: true, privacy: 'local-only', unresolved: 'quill' });
  });

  it('control: a name never used before keeps its plain folder', () => {
    expect(agents.create(vault, { name: 'Ledger' }).folder).toBe('Ledger');
  });
});

describe('an id/name clash: the Local only agent wins when exactly one is', () => {
  beforeEach(() => {
    agents.create(vault, { name: 'Quill' });                      // Roulette, id "quill"
    agents.update(vault, 'quill', { name: 'Ranger' });
    handAgent('Scout', { id: 'scout', name: 'Quill', privacy: 'local-only' });   // made by hand / before 3.3.0
  });

  it('in the kernel, in a wake word and in /agent', () => {
    expect(agents.get(vault, 'quill', all()).folder).toBe('Scout');
    expect(agents.detectWake('quill come online', all()).agent.folder).toBe('Scout');
    expect(resolveAgentArg('quill', all()).agent.id).toBe('scout');
    // A STORED "quill" is an id: it stays with the agent it was saved for.
    expect(agents.ownerOf(vault, 'quill', all()).folder).toBe('Quill');
    expect(agents.ownerOf(vault, 'scout', all()).folder).toBe('Scout');
  });

  it('neither Local only: the kernel keeps the id, the terminal asks which', () => {
    handAgent('Scout', { id: 'scout', name: 'Quill', privacy: 'roulette' });
    expect(agents.get(vault, 'quill', all()).folder).toBe('Quill');
    expect(resolveAgentArg('quill', all()).error).toMatch(/say which/);
  });
});

describe('a reference that names no single agent fails closed', () => {
  it('a hand-copied folder gets its own id; the original keeps its own', () => {
    handAgent('Scout', { id: 'scout', name: 'Scout', privacy: 'local-only' });
    handAgent('Scout_copy', { id: 'scout', name: 'Scout copy', privacy: 'local-only' });
    const ids = all().filter((a) => !a.self).map((a) => a.id).sort();
    expect(ids).toEqual(['scout', 'scout_copy']);
    expect(agents.get(vault, 'scout', all()).folder).toBe('Scout');
  });

  it('two copies with neither original: answered locally, never at Roulette', () => {
    handAgent('Copy_A', { id: 'scout', name: 'Scout A', privacy: 'local-only' });
    handAgent('Copy_B', { id: 'scout', name: 'Scout B', privacy: 'local-only' });
    const owner = agents.ownerOf(vault, 'scout', all());
    expect(owner).toMatchObject({ self: true, privacy: 'local-only', unresolved: 'scout' });
    const opts = agents.callOptions(owner);
    expect(opts.localOnly).toBe(true);
    expect(opts.localOnlyReason).toMatch(/No agent called "scout" any more/);
  });

  it('controls: no reference is your own AEON as set; a known id is that agent', () => {
    agents.create(vault, { name: 'Ledger' });
    expect(agents.ownerOf(vault, '', all())).toMatchObject({ self: true });
    expect(agents.ownerOf(vault, '', all()).unresolved).toBeUndefined();
    expect(agents.ownerOf(vault, 'ledger', all()).folder).toBe('Ledger');
  });
});
