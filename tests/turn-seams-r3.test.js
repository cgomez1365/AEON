/**
 * 3.3.0 review round 3 — the turn engine at its seams, each a regression test
 * that failed before its fix:
 *
 *   A  a tool-call opener cut in half by the output limit ("```aeon-to" |
 *      "ol") was shown as text and never run
 *   B  a one-line call quoted inside a sentence ran, and the rest of the
 *      sentence was lost
 *   C  a continuation that restarted a long answer from the top (more than
 *      1,000 characters of repeat) was shown twice
 *   D  an overlap that is a short repeating pattern was trimmed, losing data
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');
const protocol = require('../src/kernel/toolProtocol.cjs');
const continuation = require('../src/kernel/continuation.cjs');

function fakeToolbox() {
  const outcomes = [];
  let calls = 0;
  return {
    nonce: 'abc123',
    callsLeft: () => 6 - calls,
    writesLeft: () => 3,
    outcomes: () => outcomes.slice(),
    async run(call, { onStart }) {
      calls++;
      if (onStart) onStart({ id: `t${calls}`, n: calls, tool: call.tool, label: call.tool });
      const o = { id: `t${calls}`, n: calls, tool: call.tool, ok: call.ok !== false, status: call.ok === false ? 'error' : 'ok', code: call.error || null, text: 'RES', summary: 's', preview: 'RES', chars: 3, truncated: false, ms: 1, saved: false, args: call.args };
      outcomes.push(o);
      return o;
    },
  };
}
const turn = async (rounds, { toolbox = fakeToolbox() } = {}) => {
  const { stream, calls } = fakeStream(rounds);
  const c = collector();
  const r = await runAgentTurn({ kernelLLM: { stream }, messages: [{ role: 'user', content: 'x' }], emit: c.emit, toolbox });
  return { r, c, calls, toolbox };
};
const chunk = (s, n = 5) => { const o = []; for (let i = 0; i < s.length; i += n) o.push(s.slice(i, i + n)); return o; };

describe('A — an opener cut by the output limit completes in the next part', () => {
  it('"```aeon-to" | "ol\\n{...}" runs the call and never shows the fence', async () => {
    const tb = fakeToolbox();
    const { r, c, calls } = await turn([
      { tokens: ['Let me look.\n', '```aeon-to'], truncated: true },
      { tokens: ['ol\n{"tool":"vault_list","path":"Notes"}\n```\n'] },
      { tokens: ['Listed.'] },
    ], { toolbox: tb });
    expect(c.tokens()).not.toMatch(/aeon-to|```/);
    expect(r.toolCalls).toBe(1);
    expect(tb.outcomes()[0].tool).toBe('vault_list');
    expect(tb.outcomes()[0].args).toEqual({ path: 'Notes' });
    // The model is shown its own cut-off text, the held opener included.
    const asked = calls[1].messages;
    expect(asked[asked.length - 2]).toEqual({ role: 'assistant', content: 'Let me look.\n```aeon-to' });
    expect(c.tokens()).toBe('Let me look.\nListed.');
  });

  it('a held "```" that turns out to be an ordinary code block is shown once, in place', async () => {
    const { r, c } = await turn([
      { tokens: ['Here:\n', '```'], truncated: true },
      { tokens: ['js\nconst a = 1;\n```\nDone.'] },
    ]);
    expect(r.toolCalls).toBe(0);
    expect(c.tokens()).toBe('Here:\n```js\nconst a = 1;\n```\nDone.');
  });

  it('with no continuation left, the held text is shown as before', async () => {
    const { stream } = fakeStream([{ tokens: ['Look.\n', '```aeon-to'], truncated: true }]);
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream }, messages: [{ role: 'user', content: 'x' }], emit: c.emit, toolbox: fakeToolbox(), autoContinue: false });
    expect(r.toolCalls).toBe(0);
    expect(c.tokens()).toBe('Look.\n```aeon-to');
  });
});

describe('B — a one-line call is a call only when it ends its line', () => {
  it('quoted inside a sentence: not run, and the whole sentence is shown', async () => {
    const line = 'You can write ```aeon-tool {"tool":"vault_list","path":"Notes"}``` to list a folder, and that is all.';
    const { r, c } = await turn([{ tokens: [line] }, { tokens: ['Never asked.'] }]);
    expect(r.toolCalls).toBe(0);
    expect(c.tokens()).toBe(line);
  });

  it('quoted inside a sentence that goes on to a new line: not run either', async () => {
    const text = 'Write ```aeon-tool {"tool":"vault_list","path":"Notes"}``` then wait.\nThat is the syntax.';
    const { r, c } = await turn([{ tokens: chunk(text, 3) }]);
    expect(r.toolCalls).toBe(0);
    expect(c.tokens()).toBe(text);
  });

  it('at the end of its line, or of the stream, it still runs', async () => {
    const a = await turn([{ tokens: chunk('Checking.\n```aeon-tool {"tool":"vault_list","path":"Notes"}```\nignored') }, { tokens: ['Done.'] }]);
    expect(a.r.toolCalls).toBe(1);
    expect(a.c.tokens()).not.toMatch(/ignored|aeon-tool/);
    const b = await turn([{ tokens: ['```aeon-tool {"tool":"vault_list","path":"Notes"}```  '] }, { tokens: ['Done.'] }]);
    expect(b.r.toolCalls).toBe(1);
  });

  it('the scanner on its own: prose after the closing fence falls through to text', () => {
    let shown = '';
    const s = protocol.createScanner({ onText: (t) => { shown += t; } });
    for (const ch of 'A ```aeon-tool {"tool":"vault_list"}``` b\n') expect(s.push(ch)).toBeNull();
    expect(s.end({}).block).toBeNull();
    expect(shown).toBe('A ```aeon-tool {"tool":"vault_list"}``` b\n');
  });
});

describe('C — a long restart is dropped however long it is', () => {
  const para = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains one more thing.`).join(' ');
  for (const cut of [600, 1500, 2500, 3500]) {
    it(`part 1 cut at ${cut} characters, part 2 restarts from the top in small tokens`, async () => {
      const { c } = await turn([{ tokens: chunk(para.slice(0, cut)), truncated: true }, { tokens: chunk(para) }]);
      expect(c.tokens().split('Sentence number 0 ').length - 1).toBe(1);
      expect(c.tokens()).toBe(para);
    });
  }

  it('a long repeat that turns into new text before the end of the part is shown as written', async () => {
    const prev = para.slice(0, 3000);
    const head = `${para.slice(0, 1500)} — but this part says something new.`;
    let out = '';
    const seam = continuation.createSeam(prev, { onText: (t) => { out += t; } });
    for (const t of chunk(head, 7)) seam.push(t);
    seam.end();
    expect(out).toBe(head);
  });

  it('cut again while still repeating: nothing new, nothing shown', () => {
    const prev = para.slice(0, 3000);
    let out = '';
    const seam = continuation.createSeam(prev, { onText: (t) => { out += t; } });
    for (const t of chunk(para.slice(0, 2000), 7)) seam.push(t);
    expect(seam.end().dropped).toBe(2000);
    expect(out).toBe('');
  });
});

describe('D — repetitive data is not trimmed at the seam', () => {
  it('"Row: 0 0 0 …" continued with more zeros keeps every zero', () => {
    const prev = 'Row: 0 0 0 0 0 0 0 0';
    const head = ' 0 0 0 0 0 0 0 0 0 1 end';
    let out = '';
    const s = continuation.createSeam(prev, { onText: (t) => { out += t; } });
    s.push(head);
    s.end();
    expect(prev + out).toBe(prev + head);
  });

  it('an ordinary repeated overlap is still removed', () => {
    expect(continuation.overlapLength('…and the vault keys', 'the vault keys are kept')).toBe('the vault keys'.length);
  });
});
