/**
 * The terminal's save, stream and distil paths, held to what they claim.
 *
 * Found in the 2026-09-28 sweep (C13, C15, C16, C17/C41, C20, C42), all in
 * src/components/Terminal2.jsx:
 *
 *   - The chat SSE reader paired each `event:` line with the next line of the
 *     SAME read, so a frame cut across two reads was dropped. The `done`
 *     frame carries the whole answer and is the one most likely to be cut;
 *     losing it lost the truncation warning and the token count.
 *   - saveSession never looked at the status. A 404/500 { error } body read as
 *     a saved chat ("Saved: undefined"), New chat wiped the feed after a
 *     failed save, and a 404's echoed id was adopted — so after a chat's record
 *     was deleted elsewhere, every later save 404'd for the rest of the page.
 *   - Every save and the unload beacon posted the WHOLE feed: a pending file
 *     drop's base64 rode along, and a beacon over 64 KiB is refused by the
 *     browser without a word.
 *   - A repeat distil printed "nothing durable found" over the server's own
 *     "already distilled" message.
 *   - Review of the fix: New chat now refuses to drop an unsaved chat and
 *     points at /clear, but /clear kept the chat's id — so, with a save after
 *     every turn, the first turn after /clear overwrote the old record.
 *
 * The component cannot be rendered in this suite (environment: 'node'), so the
 * decisions were pulled out as pure functions and are tested here; the last
 * block checks the component actually calls them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  takeSSEFrames, readSaveResponse, sessionEntries, unloadSave, distillSummary, forgetSavedChat,
  BEACON_MAX_BYTES,
} from '../src/components/Terminal2.jsx';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal2.jsx'), 'utf8');

// Exactly what chat-stream.cjs's sseWrite puts on the wire.
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The reading loop runChat runs, fed an arbitrary chunking of the same bytes.
function consume(chunks) {
  let buffer = '';
  const events = [];
  for (let i = 0; i <= chunks.length; i++) {
    const done = i === chunks.length;
    buffer += done ? '\n\n' : chunks[i];
    const { frames, rest } = takeSSEFrames(buffer);
    buffer = rest;
    for (const f of frames) events.push({ event: f.event, data: JSON.parse(f.data) });
  }
  return events;
}
const splitAt = (s, cuts) => {
  const out = []; let prev = 0;
  for (const c of cuts) { out.push(s.slice(prev, c)); prev = c; }
  out.push(s.slice(prev));
  return out;
};

describe('C17/C41 — an SSE frame split across reads is still read', () => {
  const longAnswer = 'The operator asked a long question. '.repeat(600); // ~21 KB, past a 16 KB loopback segment
  const stream = frame('meta', { provider: 'local', model: 'm', streamId: 's1' })
    + frame('token', { t: 'The ' })
    + frame('token', { t: 'operator' })
    + frame('done', { text: longAnswer, tokens: 900, truncated: true, truncationReason: 'The answer reached its token budget.' });
  const whole = consume([stream]);

  it('reads every frame when the stream arrives in one piece', () => {
    expect(whole.map(e => e.event)).toEqual(['meta', 'token', 'token', 'done']);
    expect(whole[3].data).toMatchObject({ truncated: true, tokens: 900 });
  });

  it('keeps `done` when the read ends right after its event line', () => {
    const cut = stream.indexOf('event: done\n') + 'event: done\n'.length;
    expect(consume(splitAt(stream, [cut]))).toEqual(whole);
  });

  it('keeps `done` when the read ends inside its data line', () => {
    const cut = stream.indexOf('event: done') + 16 * 1024;
    expect(consume(splitAt(stream, [cut]))).toEqual(whole);
  });

  it('gives the same events for every place a read could end', () => {
    for (let cut = 1; cut < stream.length; cut += 97) {
      expect(consume(splitAt(stream, [cut])), `cut at byte ${cut}`).toEqual(whole);
    }
    // and one byte at a time
    expect(consume(stream.split(''))).toEqual(whole);
  });

  it('keeps a split `error` frame, so a failed turn is not left blank', () => {
    const s = frame('token', { t: 'par' }) + frame('error', { error: 'The model server stopped answering.' });
    const cut = s.indexOf('event: error\n') + 'event: error\n'.length + 5;
    expect(consume(splitAt(s, [cut])).map(e => e.event)).toEqual(['token', 'error']);
  });

  it('holds back an unfinished frame instead of guessing at it', () => {
    const { frames, rest } = takeSSEFrames('event: token\ndata: {"t":"a"}\n\nevent: done\ndata: {"te');
    expect(frames).toEqual([{ event: 'token', data: '{"t":"a"}' }]);
    expect(rest).toBe('event: done\ndata: {"te');
  });
});

describe('C13/C16 — a save response is read by its status, not by whether it has a body', () => {
  it('a real save is saved, with the id and name the server gave', () => {
    expect(readSaveResponse({ ok: true, status: 200, body: { ok: true, id: 'A', name: 'Keyslots', nameSetBy: 'auto' }, sentId: null }))
      .toEqual({ kind: 'saved', id: 'A', name: 'Keyslots', nameSetBy: 'auto' });
  });

  it('a 404 for the id we sent means the record is gone — its echoed id is NOT adopted', () => {
    const out = readSaveResponse({ ok: false, status: 404, body: { error: 'Session not found', id: 'X' }, sentId: 'X' });
    expect(out.kind).toBe('gone');
    expect(out.id).toBeUndefined();
  });

  it('a server error is a failure that carries the server\'s words', () => {
    expect(readSaveResponse({ ok: false, status: 500, body: { error: 'EIO: i/o error, write' }, sentId: 'X' }))
      .toEqual({ kind: 'failed', error: 'EIO: i/o error, write' });
    expect(readSaveResponse({ ok: false, status: 401, body: { success: false, error: 'UNAUTHORIZED_SESSION' }, sentId: 'X' }).kind).toBe('failed');
    expect(readSaveResponse({ ok: false, status: 400, body: { error: 'messages required' }, sentId: null }).kind).toBe('failed');
  });

  it('a 200 without an id, or without a JSON body, is not a save', () => {
    expect(readSaveResponse({ ok: true, status: 200, body: {}, sentId: null }).kind).toBe('failed');
    expect(readSaveResponse({ ok: false, status: 502, body: null, sentId: null })).toEqual({ kind: 'failed', error: 'HTTP 502' });
  });

  it('a 404 for a NEW record (no id sent) is a failure, not a retry loop', () => {
    expect(readSaveResponse({ ok: false, status: 404, body: { error: 'not mounted' }, sentId: null }).kind).toBe('failed');
  });

  it('a 404 that is not the route\'s own answer (block not mounted) does not drop the id', () => {
    expect(readSaveResponse({ ok: false, status: 404, body: null, sentId: 'X' }).kind).toBe('failed');
    expect(readSaveResponse({ ok: false, status: 404, body: { error: 'Cannot POST' }, sentId: 'X' }).kind).toBe('failed');
  });
});

describe('C15/C42 — what a save and a close carry', () => {
  const turn = (role, content) => ({ id: Math.random(), type: 'msg', role, content });
  const dropB64 = 'A'.repeat(5 * 1024 * 1024);

  it('a pending file drop is not part of the conversation', () => {
    const feed = [
      turn('user', 'file this'),
      { id: 9, type: 'chip', pid: '0001', kind: 'CMD', label: '/gpu', status: 'ok', output: 'ok' },
      { id: 10, type: 'filedrop', name: 'big.pdf', content: dropB64, folders: [] },
      turn('assistant', 'done'),
    ];
    const kept = sessionEntries(feed);
    expect(kept.map(e => e.type)).toEqual(['msg', 'chip', 'msg']);
    expect(JSON.stringify(kept).length).toBeLessThan(1000);
  });

  it('a close with a file drop pending still fits a beacon', () => {
    const feed = [turn('user', 'hello'), turn('assistant', 'hi'), { id: 3, type: 'filedrop', name: 'x.pdf', content: dropB64 }];
    const plan = unloadSave({ feed, savedFeed: null, sessionId: 'A' });
    expect(plan.send).toBe(true);
    expect(JSON.parse(plan.body)).toMatchObject({ id: 'A', autoSaved: true });
    expect(JSON.parse(plan.body).messages).toHaveLength(2);
  });

  it('a chat too big for a beacon is reported as too big, not sent into the void', () => {
    const feed = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', 'x'.repeat(2500)));
    const plan = unloadSave({ feed, savedFeed: null, sessionId: 'A' });
    expect(plan).toMatchObject({ send: false, reason: 'too_large' });
    expect(plan.bytes).toBeGreaterThan(BEACON_MAX_BYTES);
    expect(BEACON_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
  });

  it('nothing is sent when the server already has this exact feed, or there are no turns', () => {
    const feed = [turn('user', 'a'), turn('assistant', 'b')];
    expect(unloadSave({ feed, savedFeed: feed, sessionId: 'A' })).toMatchObject({ send: false, reason: 'saved' });
    expect(unloadSave({ feed: [{ id: 0, type: 'msg', role: 'system', content: 'boot' }], savedFeed: null, sessionId: null }))
      .toMatchObject({ send: false, reason: 'empty' });
  });
});

describe('C20 — a repeat distil says it was a repeat', () => {
  it('shows the server\'s own message, not "nothing durable found"', () => {
    const d = {
      ok: true, added: [], candidates: 0, alreadyDistilled: true,
      message: 'Nothing new — this conversation was distilled 3 minutes ago, and nothing has been said since.',
    };
    const line = distillSummary(d);
    expect(line).toContain('distilled 3 minutes ago');
    expect(line).not.toMatch(/nothing durable found/i);
  });

  it('still reports added memories and a genuinely empty run', () => {
    expect(distillSummary({ added: [{}, {}] })).toMatch(/Added 2 memories/);
    expect(distillSummary({ added: [{}] })).toMatch(/Added 1 memory /);
    expect(distillSummary({ added: [], candidates: 4 })).toMatch(/Nothing durable found in this chat — 4 candidates/);
  });
});

describe('/clear lets go of the saved record, so the next turn cannot overwrite it', () => {
  // New chat refuses to drop an unsaved chat and points at /clear. /clear kept
  // the chat's id, and saves now run after every turn, so the first turn after
  // it posted the new conversation over the old record under its old title.
  const refs = (id, feed) => ({
    currentSessionId: { current: id },
    savedFeedRef: { current: feed },
    saveChain: { current: Promise.resolve() },
  });

  it('drops the id and the saved-feed marker at once', async () => {
    const r = refs('X', [{ type: 'msg', role: 'user', content: 'old' }]);
    forgetSavedChat(r);
    expect(r.currentSessionId.current).toBe(null);
    expect(r.savedFeedRef.current).toBe(null);
    await r.saveChain.current;
    expect(r.currentSessionId.current).toBe(null);
  });

  it('a save still in flight when /clear runs does not hand the old id back', async () => {
    const r = refs('X', null);
    let land;
    // What saveSession does when its POST returns: adopt the id it saved to.
    r.saveChain.current = new Promise((res) => { land = res; })
      .then(() => { r.currentSessionId.current = 'X'; r.savedFeedRef.current = ['old feed']; });
    forgetSavedChat(r);
    land();
    await r.saveChain.current;
    expect(r.currentSessionId.current).toBe(null);
    expect(r.savedFeedRef.current).toBe(null);
  });

  it('a save queued after /clear runs after the reset, so it makes a new record', async () => {
    const r = refs('X', null);
    forgetSavedChat(r);
    let sentId = 'unset';
    r.saveChain.current = r.saveChain.current.then(() => { sentId = r.currentSessionId.current; });
    await r.saveChain.current;
    expect(sentId).toBe(null);
  });
});

describe('the component uses these, rather than its old inline versions', () => {
  it('the stream reader parses whole frames', () => {
    expect(SRC).toMatch(/takeSSEFrames\(buffer\)/);
    expect(SRC).not.toMatch(/lines\[i \+ 1\]/);
  });

  it('saves read the status, send only the conversation, and New chat keeps an unsaved chat', () => {
    expect(SRC).toMatch(/readSaveResponse\(\{ ok: r\.ok, status: r\.status/);
    expect(SRC).toMatch(/messages: sessionEntries\(snapshot\)/);
    expect(SRC).not.toMatch(/messages: feedRef\.current/);
    expect(SRC).toMatch(/if \(hasTurns && !saved\)/);
  });

  it('the close path checks what it can send, and a turn triggers a save', () => {
    expect(SRC).toMatch(/unloadSave\(\{ feed: feedRef\.current/);
    expect(SRC).toMatch(/const sent = navigator\.sendBeacon/);
    expect(SRC).toMatch(/setTurnsDone\(n => n \+ 1\)/);
  });

  it('/clear resets the saved record through forgetSavedChat', () => {
    expect(SRC).toMatch(/if \(cmdToken === '\/clear'\) \{ setFeed\(\[\]\); forgetSavedChat\(\{ currentSessionId, savedFeedRef, saveChain \}\); return; \}/);
  });

  it('distil prints through distillSummary', () => {
    expect(SRC).toMatch(/content: distillSummary\(d\)/);
  });
});
