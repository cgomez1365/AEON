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
  BEACON_MAX_BYTES, SAVED_CHIP_OUTPUT_MAX,
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

  // Both 404s below are the Dashboard block missing, which is 'unavailable'
  // since the review follow-up: still not saved, still not 'gone'.
  it('a 404 for a NEW record (no id sent) is a failure, not a retry loop', () => {
    expect(readSaveResponse({ ok: false, status: 404, body: { error: 'not mounted' }, sentId: null }).kind).toBe('unavailable');
  });

  it('a 404 that is not the route\'s own answer (block not mounted) does not drop the id', () => {
    expect(readSaveResponse({ ok: false, status: 404, body: null, sentId: 'X' }).kind).toBe('unavailable');
    expect(readSaveResponse({ ok: false, status: 404, body: { error: 'Cannot POST' }, sentId: 'X' }).kind).toBe('unavailable');
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

// Review follow-ups (sweep, 2026-09-29).
describe('a saved chat stays saveable', () => {
  it('a chip\'s long output is shortened in the saved copy, and says so; short ones and the screen are untouched', () => {
    const long = 'x'.repeat(SAVED_CHIP_OUTPUT_MAX + 5000);
    const feed = [
      { id: 1, type: 'msg', role: 'user', content: '/doc big.md' },
      { id: 2, type: 'chip', pid: '0001', kind: 'CMD', label: '/doc big.md', status: 'ok', output: long },
      { id: 3, type: 'chip', pid: '0002', kind: 'CMD', label: '/gpu', status: 'ok', output: 'ok' },
    ];
    const kept = sessionEntries(feed);
    expect(kept[1].output.length).toBeLessThan(SAVED_CHIP_OUTPUT_MAX + 200);
    expect(kept[1].output).toMatch(/\[… 5000 more characters — shortened in the saved copy of this chat\]$/);
    expect(kept[2]).toBe(feed[2]);
    expect(feed[1].output).toBe(long);
  });

  it('chat history unavailable (Dashboard stopped or removed) is its own answer, with the remedy', () => {
    const stopped = readSaveResponse({ ok: false, status: 503, body: { error: 'block "dashboard" is stopped (manual-start block)' }, sentId: 'A' });
    expect(stopped).toMatchObject({ kind: 'unavailable', error: expect.stringMatching(/block start dashboard/) });
    const removed = readSaveResponse({ ok: false, status: 404, body: { error: 'Not found' }, sentId: null });
    expect(removed).toMatchObject({ kind: 'unavailable', error: expect.stringMatching(/block restore dashboard/) });
    expect(readSaveResponse({ ok: false, status: 404, body: null, sentId: 'A' }).kind).toBe('unavailable');
    // The route's own 404 for the id it was sent is still 'gone'.
    expect(readSaveResponse({ ok: false, status: 404, body: { error: 'Session not found', id: 'A' }, sentId: 'A' }).kind).toBe('gone');
  });
});

describe('the component, wired to the follow-ups', () => {
  const code = SRC.replace(/^\s*\/\/.*$/gm, '');
  const body = (from, to) => code.slice(code.indexOf(from), code.indexOf(to, code.indexOf(from)));

  it('New chat proceeds when history is unavailable, and sets feedRef before a queued save can read it', () => {
    const nc = body('const newChat = useCallback(', '}, [saveSession]);');
    expect(nc).toMatch(/saved\?\.unavailable && hasTurns/);
    expect(nc.indexOf('feedRef.current = fresh;')).toBeGreaterThan(-1);
    expect(nc.indexOf('feedRef.current = fresh;')).toBeLessThan(nc.indexOf('setFeed(fresh);'));
  });

  it('an unavailable history is said once for automatic saves, and a manual Save is not called saved', () => {
    const ss = body('const saveSession = useCallback(', '}, [fetchSessions]);');
    expect(ss).toMatch(/if \(out\.kind === 'unavailable'\) \{\s*if \(!autoSaved \|\| !historyDownSaid\.current\)/);
    expect(code).toMatch(/saveSession\(\)\.then\(d => d && d\.id && push/);
  });

  it('a loaded chat is swapped in behind any save in flight', () => {
    const ls = body('const loadSession = useCallback(', '}, []);');
    expect(ls).toMatch(/await \(saveChain\.current = saveChain\.current\.then\(\(\) => \{/);
    expect(ls.indexOf('feedRef.current = next;')).toBeLessThan(ls.indexOf('currentSessionId.current = d.id;'));
  });

  it('naming waits for a second question, retries a bounded number of times, and stops once settled', () => {
    const ss = body('const saveSession = useCallback(', '}, [fetchSessions]);');
    expect(ss).toMatch(/questions >= 2 && asked < NAMING_TRIES/);
    expect(ss).toMatch(/d\.nameSetBy === 'model' \|\| d\.code === 'operator_named' \|\| d\.code === 'no_model'/);
  });

  it('a command\'s narration is saved when it lands', () => {
    const narr = body("fetch('/api/commands/narrate'", '})();');
    expect(narr.match(/setTurnsDone\(k => k \+ 1\)/g)).toHaveLength(2);
  });

  it('deleting a row it could not read asks first, and a refused delete is said', () => {
    const del = body('const deleteSession = useCallback(', '}, [fetchSessions]);');
    expect(del).toMatch(/s\?\.unreadable && !window\.confirm\(/);
    expect(del).toMatch(/if \(!r\.ok\)/);
    expect(del).toMatch(/was not deleted/);
    expect(code).toMatch(/s\.mismatch \? 'ID DOES NOT MATCH FILE NAME' : 'UNREADABLE'/);
    expect(code).toMatch(/\{s\.deletable !== false && <button onClick=\{\(e\) => deleteSession\(s\.id, e, s\)\}/);
  });

  it('a vision refusal shows the server\'s reason, not "is the backend running?"', () => {
    const v = body('const resolveImageContext = async', '[VISION] ${e.message}');
    expect(v).toMatch(/data\?\.error\s*\?\s*`\[VISION\] \$\{data\.error\}/);
  });
});
