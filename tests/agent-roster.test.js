/**
 * agentRoster — who the operator can call, as names, never as personas.
 *
 * A name list costs a few hundred tokens; waking an agent costs a full memory
 * read. The roster is the cheap step, so it must stay cheap (one role line,
 * capped), never guess between two names, and never write anything.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROSTER_PATH = path.join(ROOT, 'src', 'kernel', 'agentRoster.cjs');

const savedModule = require.cache[ROSTER_PATH];
const savedDataPath = process.env.DATA_PATH;
const temps = [];

function load(dataPath) {
  process.env.DATA_PATH = dataPath;
  delete require.cache[ROSTER_PATH];
  const mod = require(ROSTER_PATH);
  process.env.DATA_PATH = savedDataPath;
  return mod;
}

afterAll(() => {
  if (savedModule) require.cache[ROSTER_PATH] = savedModule; else delete require.cache[ROSTER_PATH];
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const LONG = 'Weighs every option against what it costs in time and money and refuses to let a plan through without a budget line attached to it and a named owner';
const MEMBERS = [
  { id: 'm1', label: '1. Protocol & Header Forensics Specialist', persona: 'Reads raw headers.  Then explains them.', provider: 'groq', model: 'openai/gpt-oss-120b' },
  { id: 'm2', label: 'AEON-Shield', persona: '' },
  { id: 'chair', label: 'The Chair', persona: '', chair: true },
  { id: 'm4', label: '   ', persona: 'skipped' },
  null,
  { id: 'm5', label: 'The Pragmatist', persona: LONG },
];

function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-roster-'));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, 'council'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'council', 'members.json'), JSON.stringify(MEMBERS, null, 2));
  return { dir, mod: load(dir) };
}

describe('the roster', () => {
  const { dir, mod } = seeded();

  it('reads the Council file under the data root', () => {
    expect(mod.COUNCIL_FILE).toBe(path.join(dir, 'council', 'members.json'));
  });

  it('is AEON first, then each named member in file order', () => {
    const r = mod.roster();
    expect(r.map(e => e.name)).toEqual(['Aeon', 'Protocol Header Forensics Specialist', 'AEON Shield', 'The Chair', 'The Pragmatist']);
    expect(r[0]).toBe(mod.SELF);
    expect(r[0]).toMatchObject({ id: 'aeon', self: true });
    expect(r[1]).toEqual({ id: 'm1', name: 'Protocol Header Forensics Specialist', role: 'Reads raw headers.', model: 'openai/gpt-oss-120b', provider: 'groq', self: false });
    expect(r[2]).toMatchObject({ id: 'm2', role: 'Council member', model: null, provider: null, self: false });
    expect(r[3]).toMatchObject({ id: 'chair', role: 'Council chair' });
  });

  it('cuts a long role to one line, never the whole persona', () => {
    const role = mod.roster()[4].role;
    expect(role).toHaveLength(118);
    expect(role.endsWith('…')).toBe(true);
    expect(role.slice(0, 117)).toBe(LONG.slice(0, 117));
  });

  it.each([
    ['shield', 'm2'], ['Shield', 'm2'], ['AEON-Shield', 'm2'], ['aeon shield', 'm2'],
    ['protocol', 'm1'], ['1. Protocol', 'm1'],
    ['chair', 'chair'], ['the chair', 'chair'],
    ['m1', 'm1'],
    ['aeon', 'aeon'], ['Aeon', 'aeon'],
    ['pragmatist', 'm5'], ['prag', 'm5'],
  ])('resolve(%j) → %s', (spoken, id) => {
    expect(mod.resolve(spoken)?.id).toBe(id);
  });

  it.each(['the', 'p', 'protocol header', 'x', '', null, undefined])('resolve(%j) → null (no guess)', (spoken) => {
    expect(mod.resolve(spoken)).toBeNull();
  });

  it('renders names and roles, and says nothing was loaded', () => {
    const text = mod.render();
    expect(text).toContain('[AEON AGENTS]');
    expect(text).toContain('aeon <name> come online');
    for (const e of mod.roster()) expect(text).toContain(e.name);
    expect(text).toContain('- Aeon\n');
    expect(text).not.toContain(mod.SELF.role);
    expect(text).toMatch(/only these names are present/i);
    expect(text).toMatch(/no persona is loaded/i);
    expect(text).toMatch(/no memory was read/i);
    expect(text).not.toContain('Then explains them');
  });
});

describe('a vault with no council', () => {
  it('is AEON alone, and nothing is created', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-roster-none-'));
    temps.push(parent);
    const missing = path.join(parent, 'data');
    const mod = load(missing);
    expect(mod.roster()).toEqual([mod.SELF]);
    expect(mod.render()).toContain('- Aeon');
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('a damaged council file is AEON alone too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-roster-bad-'));
    temps.push(dir);
    fs.mkdirSync(path.join(dir, 'council'));
    fs.writeFileSync(path.join(dir, 'council', 'members.json'), '{ not json');
    expect(load(dir).roster()).toHaveLength(1);
    fs.writeFileSync(path.join(dir, 'council', 'members.json'), '{"members": []}');
    expect(load(dir).roster()).toHaveLength(1);
  });
});

describe('normalise', () => {
  it('turns stored labels into spoken names', () => {
    const { mod } = seeded();
    expect(mod.normalise('1. Protocol & Header Forensics Specialist')).toBe('Protocol Header Forensics Specialist');
    expect(mod.normalise('2) AEON-Shield')).toBe('AEON Shield');
    expect(mod.normalise('  spaced   out  ')).toBe('spaced out');
    expect(mod.normalise(null)).toBe('');
    expect(mod.normalise('Café')).toBe('Caf'); // known limit: non-ASCII letters are dropped
  });
});

describe('isRosterQuery', () => {
  const { mod } = seeded();
  it.each([
    ['who can I talk to', true],
    ['which agents are there', true],
    ['list agents', true],
    ['list the agents', true],
    ['agent list', true],
    ['who is available', true],
    ['which personas', true],
    ['what agents?', true],
    ['Who is around to talk to', true],
    ['what should I call this function', true], // loose, kept for parity
    ['what time is it', false],
    ['who called me?', false],
    ['list all agents', false],
    ['show me the agents', false],
    ['who? agents', false],
  ])('%j → %s', (text, expected) => {
    expect(mod.isRosterQuery(text)).toBe(expected);
  });

  it('takes null without throwing', () => {
    expect(mod.isRosterQuery(null)).toBe(false);
    expect(mod.ROSTER_RE).toBeInstanceOf(RegExp);
  });
});
