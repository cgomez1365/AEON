/**
 * C43 — GET /api/terminal/sessions tells the truth about what it could read.
 *
 * The whole handler caught into res.json([]), and each file's parse failure
 * mapped to null and was filtered out. So a readdir error on the carried drive
 * answered 200 [] and the panel said "No saved sessions yet", and a session
 * file that no longer parsed (writeSession rewrites in place on every save; a
 * write cut off leaves half a file) vanished from the list with no notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

import { readSaveResponse } from '../src/components/Terminal2.jsx';

const require = createRequire(import.meta.url);
const createChatRouter = require('../src/blocks/dashboard/api/chat.cjs');

let tmp;
let server;
let port;

const api = async (method, route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const sessionsDir = () => path.join(tmp, 'Agents', 'Aeon', 'chat_sessions');
const conversation = [
  { id: 1, type: 'msg', role: 'user', content: 'How do the keyslots work?' },
  { id: 2, type: 'msg', role: 'assistant', content: 'Two halves.' },
];

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-sessions-'));
  const app = express();
  app.use(express.json());
  app.use('/api', createChatRouter({
    isVercel: false, supabase: null, VAULT_ROOT: tmp, kernelLLM: vi.fn(async () => 'x'),
    getLocalFile: () => null, getDailyCost: () => 0, addRunCost: () => {},
    KILL_SWITCH_THRESHOLD: 999, writeOSAudit: () => {},
  }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise(r => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a damaged session file is listed, not hidden', () => {
  it('a file cut off mid-write shows up marked unreadable, with the reason', async () => {
    const good = await api('POST', '/terminal/sessions', { messages: conversation });
    expect(good.status).toBe(200);
    const damagedId = '2026-09-28T01-02-03-456Z';
    fs.writeFileSync(path.join(sessionsDir(), `${damagedId}.json`), '{\n  "id": "2026-09-28T01-02-03-456Z",\n  "na');

    const list = await api('GET', '/terminal/sessions');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const bad = list.body.find(s => s.id === damagedId);
    expect(bad).toMatchObject({ id: damagedId, unreadable: true });
    expect(typeof bad.error).toBe('string');
    expect(bad.error.length).toBeGreaterThan(0);
    // It carries a date to sort by, from the file itself.
    expect(Number.isNaN(new Date(bad.savedAt).getTime())).toBe(false);
    // The healthy one is untouched.
    expect(list.body.find(s => s.id === good.body.id)).toMatchObject({ name: 'How do the keyslots work?', messageCount: 2 });
    expect(list.body.find(s => s.id === good.body.id).unreadable).toBeUndefined();
  });

  it('a record whose id disagrees with its file name is flagged, as readSession would refuse it', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'on-disk-name.json'), JSON.stringify({ id: 'other-id', name: 'Imposter', messages: conversation }));
    const list = await api('GET', '/terminal/sessions');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: 'on-disk-name', unreadable: true })]);
    // Intact content, only the id disagrees: the screen says so rather than
    // "unreadable", and offers Delete (behind a confirm) by this id.
    expect(list.body[0]).toMatchObject({ mismatch: true, deletable: true });
    // and the id it is listed under is the one GET/DELETE actually address
    expect((await api('DELETE', '/terminal/sessions/on-disk-name')).status).toBe(200);
    expect(fs.existsSync(path.join(sessionsDir(), 'on-disk-name.json'))).toBe(false);
  });

  it('a file whose name DELETE refuses is listed as not deletable here, and a cut-off file is not a mismatch', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), 'chat copy (1).json'), JSON.stringify({ id: 'chat', messages: conversation }));
    fs.writeFileSync(path.join(sessionsDir(), 'cut-off.json'), '{"id":"cut-off","na');
    const list = await api('GET', '/terminal/sessions');
    const copy = list.body.find((x) => x.id === 'chat copy (1)');
    expect(copy).toMatchObject({ unreadable: true, deletable: false });
    expect((await api('DELETE', `/terminal/sessions/${encodeURIComponent('chat copy (1)')}`)).status).toBe(400);
    const cut = list.body.find((x) => x.id === 'cut-off');
    expect(cut).toMatchObject({ unreadable: true, deletable: true });
    expect(cut.mismatch).toBeUndefined();
  });
});

describe('a folder that cannot be read is an error, not an empty history', () => {
  it('answers 500 with the reason instead of 200 []', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The sessions folder's path is taken by a plain file: readdir fails with
    // ENOTDIR, standing in for an EIO on the drive without needing one.
    fs.mkdirSync(path.dirname(sessionsDir()), { recursive: true });
    fs.writeFileSync(sessionsDir(), 'not a folder');

    const list = await api('GET', '/terminal/sessions');
    expect(list.status).toBe(500);
    expect(list.body.error).toMatch(/could not be listed/i);
    expect(list.body.error).toMatch(/ENOTDIR/);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('C16 — the save route and the terminal agree on what "gone" looks like', () => {
  it('a save to a deleted record is read as gone, so the terminal re-saves it as new', async () => {
    const first = await api('POST', '/terminal/sessions', { messages: conversation });
    expect((await api('DELETE', `/terminal/sessions/${first.body.id}`)).status).toBe(200);

    const r = await api('POST', '/terminal/sessions', { id: first.body.id, messages: conversation });
    expect(readSaveResponse({ ok: false, status: r.status, body: r.body, sentId: first.body.id }).kind).toBe('gone');

    const again = await api('POST', '/terminal/sessions', { id: null, messages: conversation });
    expect(readSaveResponse({ ok: again.status === 200, status: again.status, body: again.body, sentId: null }).kind).toBe('saved');
  });

  it('a save whose file no longer parses is read as gone too', async () => {
    const first = await api('POST', '/terminal/sessions', { messages: conversation });
    fs.writeFileSync(path.join(sessionsDir(), `${first.body.id}.json`), '{"id":');
    const r = await api('POST', '/terminal/sessions', { id: first.body.id, messages: conversation });
    expect(r.status).toBe(404);
    expect(readSaveResponse({ ok: false, status: r.status, body: r.body, sentId: first.body.id }).kind).toBe('gone');
  });
});
