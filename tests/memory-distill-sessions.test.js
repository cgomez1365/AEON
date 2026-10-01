/**
 * Distill finds the conversation, and keeps an honest ledger of what it ran.
 *
 * Memory Core's "distill session" button posts an empty body. The route used
 * to read only the terminal history file, which a normal install does not
 * write, so the button answered "nothing to distill" while a long
 * conversation sat saved in chat_sessions. It now reads the newest saved
 * session (or the one named by sessionId), falls back to the history file,
 * and when neither works says what it searched and what to do next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault, memDir, sessionsDir, prompts;
const ONE = JSON.stringify([{ text: 'The operator closes the books on the fifth.', category: 'fact' }]);
const LEDGER = () => path.join(memDir, '.distilled.json');
const readLedger = () => JSON.parse(fs.readFileSync(LEDGER(), 'utf8'));
const sha16 = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

function routerWith(replies = [], { historyFile = null } = {}) {
  const queue = [...replies];
  return createMemoryRouter({
    VAULT_ROOT: vault,
    TERMINAL_HISTORY_FILE: historyFile,
    kernelLLM: async (prompt) => { prompts.push(prompt); return queue.length ? queue.shift() : '[]'; },
  });
}

function distill(r, body = {}) {
  const layer = r.stack.find((l) => l.route?.path === '/memory/distill' && l.route.methods.post);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(layer.route.stack[0].handle({ body, headers: {} }, res, reject)).catch(reject);
  });
}

function saveSession(file, record) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, file), typeof record === 'string' ? record : JSON.stringify(record));
}
const msgs = (...pairs) => pairs.map(([role, content]) => ({ role, content }));
const transcriptOf = (messages) => messages.slice(-30).map((m) => `${m.role}: ${String(m.content ?? '').slice(0, 400)}`).join('\n');

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-distill-sessions-'));
  memDir = path.join(vault, 'Agents', 'Aeon', 'memory');
  sessionsDir = path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
  fs.mkdirSync(memDir, { recursive: true });
  prompts = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('where the transcript comes from', () => {
  it('the newest saved session wins, and the memory cites it', async () => {
    saveSession('a.json', { id: 'a', name: 'Old chat', updatedAt: '2026-09-01T10:00:00Z', messages: msgs(['user', 'ALPHA topic'], ['assistant', 'ok alpha']) });
    saveSession('b.json', { id: 'b', name: 'Books chat', updatedAt: '2026-09-20T10:00:00Z', messages: msgs(['user', 'BRAVO topic'], ['assistant', 'ok bravo']) });
    const { body } = await distill(routerWith([ONE]));
    expect(prompts[0]).toContain('BRAVO topic');
    expect(prompts[0]).not.toContain('ALPHA topic');
    expect(body.session).toBe('Books chat');
    expect(body.added[0].refs[0]).toMatchObject({ kind: 'chat-session', file: 'Agents/Aeon/chat_sessions/b.json', span: 'last-2-turns' });
  });

  it('savedAt stands in for a missing updatedAt; neither ranks oldest', async () => {
    saveSession('none.json', { name: 'No time', messages: msgs(['user', 'NOTIME'], ['assistant', 'x']) });
    saveSession('saved.json', { name: 'Saved at', savedAt: '2026-09-10T10:00:00Z', messages: msgs(['user', 'SAVEDAT'], ['assistant', 'y']) });
    const { body } = await distill(routerWith());
    expect(body.session).toBe('Saved at');
  });

  it('both roles go in: the last 30 turns, each cut to 400 characters', async () => {
    const long = 'L'.repeat(900);
    const m = Array.from({ length: 35 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 33 ? long : `turn ${i}` }));
    saveSession('s.json', { id: 's', name: 'Long', updatedAt: '2026-09-20T10:00:00Z', messages: m });
    const { body } = await distill(routerWith([ONE]));
    expect(prompts[0]).not.toContain('turn 4\n');
    expect(prompts[0]).toContain('assistant: turn 5\n');
    expect(prompts[0]).toContain('user: turn 34');
    expect(prompts[0]).toContain(`assistant: ${'L'.repeat(400)}\n`);
    expect(prompts[0]).not.toContain('L'.repeat(401));
    expect(body.added[0].refs[0].span).toBe('last-30-turns');
  });

  it('skips empty and unparsable sessions', async () => {
    saveSession('empty.json', { name: 'Empty', updatedAt: '2026-09-25T10:00:00Z', messages: [] });
    saveSession('broken.json', '{ not json');
    saveSession('good.json', { name: 'Good', updatedAt: '2026-09-01T10:00:00Z', messages: msgs(['user', 'GOOD'], ['assistant', 'ok']) });
    const { body } = await distill(routerWith());
    expect(body.session).toBe('Good');
  });

  it('a session with no name is named by its file', async () => {
    saveSession('chat-123.json', msgs(['user', 'array form'], ['assistant', 'ok']));
    const { body } = await distill(routerWith());
    expect(body.session).toBe('chat-123.json');
  });

  it('sessionId picks an older session, by id or by file name', async () => {
    saveSession('old.json', { id: 'old-id', name: 'Older', updatedAt: '2026-09-01T10:00:00Z', messages: msgs(['user', 'OLDER'], ['assistant', 'ok']) });
    saveSession('new.json', { id: 'new-id', name: 'Newer', updatedAt: '2026-09-20T10:00:00Z', messages: msgs(['user', 'NEWER'], ['assistant', 'ok']) });
    expect((await distill(routerWith(), { sessionId: 'old-id' })).body.session).toBe('Older');
    fs.rmSync(LEDGER(), { force: true });
    expect((await distill(routerWith(), { sessionId: 'old' })).body.session).toBe('Older');
  });

  it('a sessionId is never a path', async () => {
    saveSession('new.json', { id: 'new-id', name: 'Newer', updatedAt: '2026-09-20T10:00:00Z', messages: msgs(['user', 'NEWER'], ['assistant', 'ok']) });
    fs.writeFileSync(path.join(vault, 'outside.json'), JSON.stringify(msgs(['user', 'OUTSIDE'], ['assistant', 'x'])));
    const { status, body } = await distill(routerWith(), { sessionId: '../../../outside' });
    expect(status).toBe(400);
    expect(body.error).toContain('that session has no messages');
    expect(prompts).toHaveLength(0);
  });

  it('a caller transcript wins over every saved session', async () => {
    saveSession('s.json', { name: 'Saved', updatedAt: '2026-09-20T10:00:00Z', messages: msgs(['user', 'SAVED'], ['assistant', 'ok']) });
    const { body } = await distill(routerWith(), { transcript: 'user: CALLER TEXT\nassistant: ok' });
    expect(prompts[0]).toContain('CALLER TEXT');
    expect(prompts[0]).not.toContain('SAVED');
    expect(body.session).toBeNull();
  });

  it('falls back to the terminal history file', async () => {
    const historyFile = path.join(vault, 'aeon_terminal_history.json');
    fs.writeFileSync(historyFile, JSON.stringify({ messages: msgs(['user', 'FROM HISTORY'], ['assistant', 'ok']) }));
    const { body } = await distill(routerWith([ONE], { historyFile }));
    expect(prompts[0]).toContain('FROM HISTORY');
    expect(body.session).toBeNull();
    expect(body.added[0].refs[0].kind).toBe('terminal-history');
  });

  it('with nothing anywhere: 400, both reasons, and no model call', async () => {
    const { status, body } = await distill(routerWith());
    expect(status).toBe(400);
    expect(body.error.startsWith('Nothing to distill.')).toBe(true);
    expect(body.error).toContain('ENOENT');
    expect(body.error).toContain('TERMINAL_HISTORY_FILE not injected');
    expect(body.error).toMatch(/send a message in the terminal first, or pass a transcript/i);
    expect(prompts).toHaveLength(0);
  });

  it('an empty history says so', async () => {
    const historyFile = path.join(vault, 'aeon_terminal_history.json');
    fs.writeFileSync(historyFile, '[]');
    const { status, body } = await distill(routerWith([], { historyFile }));
    expect(status).toBe(400);
    expect(body.error).toContain('terminal history is empty');
  });

  it('an empty sessions folder says so', async () => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const { body } = await distill(routerWith());
    expect(body.error).toContain('no saved sessions');
  });

  it('the panel path is guarded too', async () => {
    saveSession('s.json', { id: 's', name: 'Ops sync', updatedAt: '2026-09-20T10:00:00Z', messages: msgs(['user', 'we close on the fifth'], ['assistant', 'noted']) });
    const r = routerWith([ONE]);
    await distill(r);
    const { body } = await distill(r);
    expect(body).toMatchObject({ ok: true, added: [], candidates: 0, alreadyDistilled: true, session: 'Ops sync' });
    expect(prompts).toHaveLength(1);
  });
});

describe('the ledger', () => {
  it('sits beside memories.json, keyed by the first 16 hex of the transcript\'s SHA-256', async () => {
    const t = 'user: we close the books on the fifth\nassistant: noted';
    await distill(routerWith([ONE]), { transcript: t });
    const entries = readLedger();
    expect(entries).toHaveLength(1);
    expect(entries[0].sha).toMatch(/^[0-9a-f]{16}$/);
    expect(entries[0].sha).toBe(sha16(t));
    expect(new Date(entries[0].at).toISOString()).toBe(entries[0].at);
    expect(entries[0].added).toBe(1);
  });

  it('keeps the last 200 runs', async () => {
    const old = Array.from({ length: 200 }, (_, i) => ({ sha: `old${String(i).padStart(13, '0')}`, at: '2026-01-01T00:00:00.000Z', added: 0 }));
    fs.writeFileSync(LEDGER(), JSON.stringify(old));
    const t = 'user: something new\nassistant: ok';
    await distill(routerWith(), { transcript: t });
    const entries = readLedger();
    expect(entries).toHaveLength(200);
    expect(entries[0].sha).toBe(old[1].sha);
    expect(entries.at(-1).sha).toBe(sha16(t));
  });

  it('a forced run replaces its entry instead of adding one', async () => {
    const t = 'user: a forced one\nassistant: ok';
    fs.writeFileSync(LEDGER(), JSON.stringify([{ sha: sha16(t), at: '2026-01-01T00:00:00.000Z', added: 0 }]));
    await distill(routerWith(), { transcript: t, force: true });
    const entries = readLedger().filter((e) => e.sha === sha16(t));
    expect(entries).toHaveLength(1);
    expect(entries[0].at > '2026-01-01T00:00:00.000Z').toBe(true);
  });

  it('a damaged ledger reads as empty, and is rewritten as a list', async () => {
    fs.writeFileSync(LEDGER(), '{ not json');
    const { body } = await distill(routerWith([ONE]), { transcript: 'user: x happened\nassistant: ok' });
    expect(body.added).toHaveLength(1);
    expect(Array.isArray(readLedger())).toBe(true);
  });

  it('a ledger that cannot be written does not fail the run', async () => {
    fs.mkdirSync(LEDGER());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, body } = await distill(routerWith([ONE]), { transcript: 'user: y happened\nassistant: ok' });
    expect(status).toBe(200);
    expect(body.added).toHaveLength(1);
  });

  it.each([
    [30 * 1000, 'moments ago'],
    [3 * 60 * 1000, '3 minutes ago'],
    [5 * 60 * 60 * 1000, '5 hours ago'],
    [2 * 24 * 60 * 60 * 1000, '2 days ago'],
    [59.6 * 60 * 1000, '1 hour ago'], // rounded before the threshold check
  ])('a run %i ms ago reads "%s"', async (ago, words) => {
    const t = 'user: dated\nassistant: ok';
    fs.writeFileSync(LEDGER(), JSON.stringify([{ sha: sha16(t), at: new Date(Date.now() - ago).toISOString(), added: 2 }]));
    const { body } = await distill(routerWith([ONE]), { transcript: t });
    expect(body.alreadyDistilled).toBe(true);
    expect(body.message).toContain(words);
    expect(prompts).toHaveLength(0);
  });

  it('the success reply carries no alreadyDistilled key at all', async () => {
    const { body } = await distill(routerWith([ONE]), { transcript: 'user: z\nassistant: ok' });
    expect(Object.keys(body)).not.toContain('alreadyDistilled');
    expect(body).toMatchObject({ ok: true, candidates: 1, session: null });
  });
});

describe('the live terminal transcript fingerprints like the saved one', () => {
  it('a chat distilled from the terminal is already distilled from Memory Core', async () => {
    const { liveTranscript } = await import('../src/components/Terminal2.jsx');
    const m = Array.from({ length: 35 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 20 ? 'Q'.repeat(700) : `message ${i}` }));
    const feed = [{ type: 'msg', role: 'system', content: 'boot' }, ...m.map((x, i) => ({ id: i, type: 'msg', ...x }))];
    const live = liveTranscript(feed);
    expect(live).toBe(transcriptOf(m));

    saveSession('s.json', { id: 's', name: 'Same chat', updatedAt: '2026-09-20T10:00:00Z', messages: m });
    const r = routerWith([ONE]);
    expect((await distill(r, { transcript: live })).body.added).toHaveLength(1);
    const fromPanel = await distill(r);
    expect(fromPanel.body).toMatchObject({ alreadyDistilled: true, session: 'Same chat' });
    expect(prompts).toHaveLength(1);
  });
});
