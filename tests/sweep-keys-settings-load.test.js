/**
 * C37 — loadSettings moves the settings file aside ONLY when it does not parse.
 *
 * The catch treated every error but ENOENT as corruption. A read that failed
 * for any other reason (EMFILE when descriptors ran out, EACCES, EIO) renamed a
 * healthy aeon-settings.json to .corrupt-<ts>; renameSync needs no descriptor,
 * so it succeeded under EMFILE. Every later read then hit ENOENT and ran on the
 * all-local defaults until someone restored the file by hand. A directory at
 * the settings path gives a deterministic non-parse read error (EISDIR).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-settings-load-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SETTINGS_FILE = path.join(tmp, 'aeon-settings.json');

const settings = require('../services/settings.js');
const FILE = settings.SETTINGS_FILE;

afterAll(() => { delete process.env.AEON_SETTINGS_FILE; fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('aeon-settings.json')) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
});

const asides = () => fs.readdirSync(path.dirname(FILE)).filter((f) => f.startsWith(`${path.basename(FILE)}.corrupt-`));

describe('loadSettings on a read that fails', () => {
  it('uses defaults for the call but leaves the file where it is', () => {
    expect(FILE).toBe(path.join(tmp, 'aeon-settings.json'));
    fs.mkdirSync(FILE);
    fs.writeFileSync(path.join(FILE, 'marker'), 'still here');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const loaded = settings.loadSettings();

    expect(loaded.models.chat.provider).toBe('local');
    expect(asides()).toEqual([]);
    expect(fs.readFileSync(path.join(FILE, 'marker'), 'utf8')).toBe('still here');
    expect(err.mock.calls.join(' ')).toMatch(/could not be read \(EISDIR\).*file left in place/);
  });

  it('a file that does not parse is still moved aside', () => {
    fs.writeFileSync(FILE, '{"models":');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(settings.loadSettings().models.chat.provider).toBe('local');
    expect(asides()).toHaveLength(1);
  });

  it('a readable file is read', () => {
    fs.writeFileSync(FILE, JSON.stringify({ models: { chat: { provider: 'groq', model: 'm' } } }));
    expect(settings.loadSettings().models.chat.provider).toBe('groq');
  });
});

// Review follow-up: the unread file was left in place, and the next save — a
// change built on the defaults — replaced it with no copy kept.
describe('saveSettings after a read that failed', () => {
  const unread = () => fs.readdirSync(path.dirname(FILE)).filter((f) => f.startsWith(`${path.basename(FILE)}.unread-`));

  it('keeps the unread file aside, named, before writing the change', () => {
    const original = JSON.stringify({ models: { chat: { provider: 'groq', model: 'mine' } }, prefs: { theme: 'x' } });
    fs.writeFileSync(FILE, original);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (String(p) === FILE) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRead.call(fs, p, ...rest);
    });
    const next = settings.loadSettings();
    spy.mockRestore();
    next.prefs = { changed: true };
    settings.saveSettings(next);

    expect(unread()).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(FILE), unread()[0]), 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).prefs).toEqual({ changed: true });
    expect(err.mock.calls.join(' ')).toMatch(/kept as aeon-settings\.json\.unread-/);
  });

  it('after a good read, a save writes in place and keeps nothing aside', () => {
    fs.writeFileSync(FILE, JSON.stringify({ models: {}, prefs: {} }));
    const s = settings.loadSettings();
    settings.saveSettings({ ...s, prefs: { a: 1 } });
    expect(unread()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).prefs).toEqual({ a: 1 });
  });
});
