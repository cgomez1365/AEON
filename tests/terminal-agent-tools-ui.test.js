/**
 * 3.3.0 — the terminal shows what an agent's tools really did.
 *
 * The chat stream reports each tool use (`tool_call`), its real result
 * (`tool_result`), each automatic continuation (`continue`) and engine notices
 * (`notice`). A model may only say it read or saved something when a result
 * for it exists in that turn, and the operator can only check that if the
 * result is on screen: a TOOL chip above the answer, a ✎ line for every
 * write, a note when an answer was joined from parts.
 *
 * The component cannot be rendered here (environment: 'node'), so the
 * decisions are pure functions, tested here; the last block checks runChat
 * and runCommand actually use them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  toolChipFromCall, toolChipUpdate, continueStatusText, continuedNoticeText, noticeEntry,
  dispatchBody, takeSSEFrames, sessionEntries, chatHistory,
} from '../src/components/Terminal2.jsx';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal2.jsx'), 'utf8');
const RUN_CHAT = SRC.slice(SRC.indexOf('const runChat = async'), SRC.indexOf('const stopChat = useCallback'));
const RUN_COMMAND = SRC.slice(SRC.indexOf('const runCommand = async'), SRC.indexOf('const runShell = async'));

const CALL = { id: 't1', n: 1, tool: 'vault_read', args: { path: 'Notes/plan.md' }, write: false, label: 'vault_read Notes/plan.md' };

describe('a tool call becomes a TOOL chip, filled in by its real result', () => {
  it('tool_call → a running chip with the server\'s label and no output yet', () => {
    expect(toolChipFromCall(CALL)).toEqual({
      type: 'chip', kind: 'TOOL', label: 'vault_read Notes/plan.md', status: 'running',
      toolId: 't1', write: false, expanded: false, output: null,
    });
    expect(toolChipFromCall({ ...CALL, id: 't2', tool: 'artifact_save', write: true, label: 'artifact_save March' }).write).toBe(true);
  });

  it('a call with no label is labelled from its tool and arguments, never with the long text', () => {
    const chip = toolChipFromCall({ id: 't3', tool: 'scratchpad_write', args: { mode: 'append', content: '<812 characters>' } });
    expect(chip.label).toBe('scratchpad_write append');
    expect(toolChipFromCall({ id: 't4' }).label).toBe('?');
  });

  it('an ok result: EXIT 0, the preview as output, the summary on the label', () => {
    const chip = toolChipFromCall(CALL);
    const upd = toolChipUpdate(chip, { id: 't1', ok: true, status: 'ok', summary: 'characters 0–812 of 812', preview: '# Plan\n- ship', chars: 812, truncated: false, ms: 14 });
    expect(upd).toEqual({ status: 'ok', latencyMs: 14, output: '# Plan\n- ship', label: 'vault_read Notes/plan.md — characters 0–812 of 812' });
  });

  it('a capped result says how much the model got', () => {
    const upd = toolChipUpdate(toolChipFromCall(CALL), { ok: true, summary: 's', preview: 'p', chars: 8000, truncated: true, ms: 3 });
    expect(upd.output).toBe('p\n\n_(8,000 characters sent to the model; capped)_');
  });

  it('an error or a refusal is EXIT 1 and carries its reason', () => {
    const refused = toolChipUpdate(toolChipFromCall(CALL), { ok: false, status: 'refused', code: 'traversal', summary: 'refused: path leaves the Vault', preview: 'The path "../x" leaves the Vault.', ms: 1 });
    expect(refused.status).toBe('fail');
    expect(refused.output).toMatch(/leaves the Vault/);
    expect(refused.label).toMatch(/— refused: path leaves the Vault$/);
    // No preview: the summary is the output, never an empty box.
    expect(toolChipUpdate(toolChipFromCall(CALL), { ok: false, summary: 'timed out' }).output).toBe('timed out');
  });
});

describe('auto-continue and engine notices', () => {
  it('the grey line while continuing', () => {
    expect(continueStatusText({ part: 2, max: 5, reason: 'max_tokens' })).toBe('continuing… part 2 of up to 5');
  });

  it('"continued automatically" only when the answer has more than one part', () => {
    expect(continuedNoticeText({ parts: 3 })).toBe('Continued automatically, 3 parts.');
    expect(continuedNoticeText({ parts: 1 })).toBeNull();
    expect(continuedNoticeText({})).toBeNull();
    expect(continuedNoticeText(null)).toBeNull();
  });

  it('a warn notice is a WARN line, an info notice a SYS line', () => {
    expect(noticeEntry({ level: 'warn', code: 'unbacked-claim', message: 'No search tool succeeded in this reply' }))
      .toEqual({ type: 'msg', role: 'warning', content: '↪ No search tool succeeded in this reply' });
    expect(noticeEntry({ level: 'info', code: 'tools-off', message: 'tools are off' }).role).toBe('system');
  });
});

describe('dispatchBody — /handoff gets the chat, other commands do not', () => {
  const feed = [
    { id: 1, type: 'msg', role: 'user', content: 'hi', agent: 'scout' },
    { id: 2, type: 'chip', kind: 'TOOL', label: 'vault_list', output: 'x' },
    { id: 3, type: 'msg', role: 'assistant', content: 'hello', agent: 'scout' },
    { id: 4, type: 'msg', role: 'system', content: '↪ note' },
  ];

  it('a takesHistory command carries the turns a chat turn would send, chips and notices left out', () => {
    const body = dispatchBody({ cmdToken: '/handoff', arg: '', confirmed: false, agentBody: { agent: 'scout' }, spec: { cmd: '/handoff', takesHistory: true }, feed });
    expect(body).toEqual({ cmd: '/handoff', arg: '', confirmed: false, agent: 'scout', history: chatHistory(feed) });
    expect(body.history).toEqual([
      { role: 'user', content: 'hi', agent: 'scout' },
      { role: 'assistant', content: 'hello', agent: 'scout' },
    ]);
  });

  it('a command without it is unchanged', () => {
    expect(dispatchBody({ cmdToken: '/memory', arg: 'x', confirmed: true, agentBody: {}, spec: { cmd: '/memory' }, feed }))
      .toEqual({ cmd: '/memory', arg: 'x', confirmed: true });
    expect(dispatchBody({ cmdToken: '/nope', arg: '', confirmed: false, agentBody: {}, spec: undefined, feed })).not.toHaveProperty('history');
  });
});

describe('tool chips are not conversation', () => {
  it('chatHistory leaves TOOL chips out; a save keeps them, as chips', () => {
    const chip = { id: 9, ...toolChipFromCall(CALL), output: 'a'.repeat(10) };
    const feed = [{ id: 1, type: 'msg', role: 'user', content: 'q' }, chip];
    expect(chatHistory(feed)).toEqual([{ role: 'user', content: 'q' }]);
    expect(sessionEntries(feed)[1]).toMatchObject({ type: 'chip', kind: 'TOOL' });
  });
});

describe('tool frames survive a read split anywhere', () => {
  it('every event arrives whole, whatever the chunk boundary', () => {
    const wire = [
      ['tool_call', CALL],
      ['tool_result', { id: 't1', n: 1, tool: 'vault_read', ok: true, status: 'ok', code: null, summary: 's', preview: 'line\n\nwith blank', chars: 4, truncated: false, ms: 2, notice: null }],
      ['continue', { part: 2, max: 5, reason: 'max_tokens' }],
      ['notice', { level: 'warn', code: 'tool-limit', message: 'm' }],
    ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    for (let cut = 0; cut <= wire.length; cut++) {
      const a = takeSSEFrames(wire.slice(0, cut));
      const b = takeSSEFrames(a.rest + wire.slice(cut));
      const frames = [...a.frames, ...b.frames];
      expect(frames.map(f => f.event), `cut at ${cut}`).toEqual(['tool_call', 'tool_result', 'continue', 'notice']);
      expect(JSON.parse(frames[1].data).preview).toBe('line\n\nwith blank');
    }
  });
});

describe('the component uses them', () => {
  it('runChat handles each new event', () => {
    for (const ev of ['tool_call', 'tool_result', 'continue', 'notice']) {
      expect(RUN_CHAT, ev).toContain(`eventType === '${ev}'`);
    }
    expect(RUN_CHAT).toMatch(/pushBefore\(msgId, \{ \.\.\.toolChipFromCall\(payload\)/);
    expect(RUN_CHAT).toMatch(/patch\(chipId, \(c\) => toolChipUpdate\(c, payload\)\)/);
    expect(RUN_CHAT).toMatch(/patch\(msgId, \{ continuing: continueStatusText\(payload\) \}\)/);
    expect(RUN_CHAT).toMatch(/noticeEntry\(payload\)/);
    expect(RUN_CHAT).toMatch(/continuedNoticeText\(meta\)/);
  });

  it('a write\'s notice is pushed into the feed, not only into the chip', () => {
    expect(RUN_CHAT).toMatch(/if \(payload\.notice\) pushBefore\(msgId, \{ type: 'msg', role: 'system', content: `✎ \$\{payload\.notice\}` \}\)/);
  });

  it('a tool still running when the reply ends is marked, not left spinning', () => {
    expect(RUN_CHAT).toMatch(/for \(const id of toolPending\)/);
    expect(RUN_CHAT).toMatch(/No result: the reply ended before this tool finished\./);
  });

  it('runCommand builds its body with dispatchBody and the command\'s registry spec', () => {
    expect(RUN_COMMAND).toMatch(/JSON\.stringify\(dispatchBody\(\{/);
    expect(RUN_COMMAND).toMatch(/spec: commands\.find\(c => c\.cmd === cmdToken\)/);
  });

  it('the streaming answer shows the continuing line', () => {
    expect(SRC).toMatch(/entry\.streaming && entry\.continuing &&/);
  });
});
