/**
 * The aeon-tool scanner, hardened after the 3.3.0 correctness review
 * (2026-10-03, round 1): CRLF line endings, a close fence on the JSON line, an
 * example inside an ordinary code block, and a call cut off by the output
 * limit keeping the tool's name. Each case runs at every chunk split.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const p = require('../src/kernel/toolProtocol.cjs');
const agents = require('../src/kernel/agents.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

// Every way of cutting `input` in two, plus one character at a time.
function scanAll(input, opts = {}) {
  const runs = [];
  const splits = [[input], [...input]];
  for (let i = 1; i < input.length; i++) splits.push([input.slice(0, i), input.slice(i)]);
  for (const chunks of splits) {
    let visible = '';
    const s = p.createScanner({ onText: (t) => { visible += t; }, ...opts });
    let block = null;
    for (const c of chunks) { const r = s.push(c); if (r && !block) block = r.block; }
    const tail = s.end();
    if (!block && tail.block) block = tail.block;
    runs.push({ visible, block, unterminated: !!tail.unterminated });
  }
  return runs;
}

describe('CRLF line endings', () => {
  it('a block written with \\r\\n is recognised, and none of it is shown', () => {
    for (const r of scanAll('Sure.\r\n```aeon-tool\r\n{"tool":"vault_list","path":""}\r\n```\r\n')) {
      expect(r.block).toBeTruthy();
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'vault_list' });
      expect(r.visible).toBe('Sure.\r\n');
    }
  });
});

describe('the close fence on the JSON line', () => {
  it('{"tool": ...}``` is a complete call', () => {
    for (const r of scanAll('Ok.\n```aeon-tool\n{"tool":"vault_list","path":""}```')) {
      expect(r.unterminated).toBe(false);
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'vault_list', args: { path: '' } });
      expect(r.visible).toBe('Ok.\n');
    }
  });
  it('a multi-line header closed on its last line', () => {
    for (const r of scanAll('```aeon-tool\n{"tool": "vault_search",\n "query": "march"}```\n')) {
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'vault_search', args: { query: 'march' } });
    }
  });
});

describe('a closing fence with text after it on the same line', () => {
  // Review 2026-10-03 (round 2, live run X09): "``` AFTERBLOCK" did not close
  // the block, and a valid call failed as "header is not valid JSON".
  it('closes the block; the text after the fence is not shown and the call runs', () => {
    for (const r of scanAll('now.\n```aeon-tool\n{"tool":"vault_list","path":"Notes"}\n``` AFTERBLOCK\n')) {
      expect(r.unterminated).toBe(false);
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'vault_list', args: { path: 'Notes' } });
      expect(r.visible).toBe('now.\n');
    }
  });
  it('inside the content part, "``` js" is still a nested code fence, not the close', () => {
    const input = '```aeon-tool\n{"tool":"artifact_save","name":"n"}\n---\n``` js\nlet a = 1;\n```\n```\n';
    for (const r of scanAll(input)) {
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'artifact_save' });
      expect(p.parseBlock(r.block).args.content).toContain('let a = 1;');
    }
  });
});

describe('an example inside an ordinary code block is text, never a call', () => {
  it('```markdown … ```aeon-tool … ``` … ```', () => {
    const input = 'Here is how:\n```markdown\n```aeon-tool\n{"tool":"vault_list"}\n```\n```\nThat is all.';
    for (const r of scanAll(input)) {
      expect(r.block).toBeNull();
      expect(r.visible).toBe(input);
    }
  });
  it('a tilde block, and a real call after the example still runs', () => {
    const input = '~~~\n```aeon-tool\n{"tool":"memory_save","text":"example only"}\n```\n~~~\nNow for real:\n```aeon-tool\n{"tool":"vault_list","path":""}\n```\n';
    for (const r of scanAll(input)) {
      expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'vault_list' });
      expect(r.visible).toBe('~~~\n```aeon-tool\n{"tool":"memory_save","text":"example only"}\n```\n~~~\nNow for real:\n');
    }
  });
  it('a continuation that starts inside the code block its first part opened', () => {
    const state = p.codeFenceState('Example:\n```js\nconst a = 1;\n');
    expect(state).toEqual({ char: '`', len: 3 });
    expect(p.codeFenceState('```js\nx\n```\n')).toBeNull();
    for (const r of scanAll('```aeon-tool\n{"tool":"vault_list"}\n```\n```\ndone', { initialFence: state })) {
      expect(r.block).toBeNull();
    }
  });
});

describe('a call cut off by the output limit', () => {
  let vault;
  beforeEach(() => {
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cutoff-')));
    agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
  });
  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  it('keeps the tool it named on the chip, and is not run', async () => {
    const all = agents.list(vault, { withStats: false });
    const toolbox = agentTools.createToolbox({ vaultRoot: vault, agent: agents.get(vault, 'Ledger', all), agents: all, contextTokens: 32768 });
    const f = fakeStream([
      { tokens: ['Saving.\n```aeon-tool\n{"tool":"artifact_save","name":"Report"}\n---\n# Report\nlong text that never'], truncated: true },
      { tokens: ['I will save a shorter one.'] },
    ]);
    const c = collector();
    await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], toolbox, emit: c.emit, autoContinue: false });
    const [started] = c.of('tool_call');
    const [result] = c.of('tool_result');
    expect(started.label).toBe('artifact_save (could not be read)');
    expect(result).toMatchObject({ tool: 'artifact_save', ok: false, code: 'cut-off' });
    expect(f.calls[1].messages.at(-1).content).toMatch(/cut off by the output limit .* not run\. Send a shorter call: save a shorter document, or save it as several artifacts/);
    expect(fs.existsSync(path.join(vault, 'Agents', 'Ledger', 'artifacts'))).toBe(false);
  });
});
