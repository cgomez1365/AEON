/**
 * A tool call written as a bare JSON line, without the aeon-tool fence.
 *
 * Found filming 2026-10-29 (AEON 3.5.1, Phi-4 Mini Q4 via llama.cpp, Local
 * only): asked "Write a two-sentence welcome for a bike shop's spring
 * newsletter.", the reply showed the answer, then the line
 *   {"tool": "artifact_save", "name": "velocity_cycles_spring_welcome"}
 * then the answer again in quotes. Small models write the call inline.
 *
 * Only a fenced block is a call (toolProtocol.cjs), so the bare line is never
 * run. It is hidden like a block; after answer text it ends the round like a
 * block (what follows is the model's idea of the payload), and the operator
 * is told in a notice.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const p = require('../src/kernel/toolProtocol.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

const chunk = (s, n) => { const o = []; for (let i = 0; i < s.length; i += n) o.push(s.slice(i, i + n)); return o; };
function scan(parts) {
  let visible = '';
  const sc = p.createScanner({ onText: (t) => { visible += t; } });
  let block = null;
  for (const c of parts) { const r = sc.push(c); if (r) { block = r.block; break; } }
  const tail = sc.end({});
  return { visible, block: block || tail.block, strays: sc.strays() };
}

const ANSWER = 'Spring is here at Velocity Cycles! Roll in for a free tune-up check and ride into the season with us.';
const LIVE = `${ANSWER}\n{"tool": "artifact_save", "name": "velocity_cycles_spring_welcome"}\n"${ANSWER}"`;

describe('the scanner hides a bare tool call line', () => {
  it('the live reply: the answer once, no JSON, at every chunk size', () => {
    for (let n = 1; n <= 40; n++) {
      const r = scan(chunk(LIVE, n));
      expect(r.visible, `chunks of ${n}`).toBe(`${ANSWER}\n`);
      expect(r.block).toMatchObject({ unfenced: true, tool: 'artifact_save' });
      expect(r.strays).toEqual(['artifact_save']);
    }
  });

  it('a bare line before any answer text: only the line goes', () => {
    const r = scan(chunk(`{"tool":"memory_save","text":"x"}\n${ANSWER}`, 3));
    expect(r.visible).toBe(ANSWER);
    expect(r.block).toBeNull();
    expect(r.strays).toEqual(['memory_save']);
  });

  it('a bare line that ends the stream with no newline is hidden too', () => {
    const r = scan([`${ANSWER}\n{"tool": "artifact_save", "name": "x"}`]);
    expect(r.visible).toBe(`${ANSWER}\n`);
    expect(r.block).toMatchObject({ unfenced: true });
  });

  it('JSON that is not a call to an AEON tool is ordinary text', () => {
    for (const text of [
      'Data:\n{"tool": "hammer", "size": 3}\nend',
      'Data:\n{"name": "x", "tool": "vault_search"}\nend',
      'Data:\n{ "a": 1 }\nend',
      'Data:\n{"tool": "vault_search", "query": "x"} is the shape.\nend',
      'Data:\n```json\n{"tool": "vault_search", "query": "x"}\n```\nend',
      'Inline {"tool": "vault_search", "query": "x"} mid-line.\nend',
    ]) {
      const r = scan(chunk(text, 2));
      expect(r.visible, text).toBe(text);
      expect(r.block, text).toBeNull();
      expect(r.strays, text).toEqual([]);
    }
  });

  it('a fenced call is still a call', () => {
    const r = scan([`${ANSWER}\n\`\`\`aeon-tool\n{"tool": "artifact_save", "name": "w"}\n---\nbody\n\`\`\`\n`]);
    expect(p.parseBlock(r.block)).toMatchObject({ ok: true, tool: 'artifact_save', args: { name: 'w', content: 'body' } });
  });
});

describe('in a turn', () => {
  it('the bare call is never run, the answer is shown once, and a notice says why', async () => {
    const { stream, calls } = fakeStream([{ tokens: chunk(LIVE, 4) }, { tokens: ['SECOND ROUND'] }]);
    const c = collector();
    const ran = [];
    const toolbox = {
      nonce: 'abc123', callsLeft: () => 5, writesLeft: () => 3, outcomes: () => [],
      async run(call) { ran.push(call); return { id: 't', n: 1, tool: call.tool, ok: true, status: 'ok', text: '' }; },
    };
    const r = await runAgentTurn({ kernelLLM: { stream }, messages: [{ role: 'user', content: 'x' }], emit: c.emit, toolbox });
    expect(ran).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(r.text).toBe(`${ANSWER}\n`);
    expect(c.tokens()).toBe(r.text);
    expect(c.of('tool_call')).toEqual([]);
    expect(c.of('notice').map((n) => n.code)).toContain('unfenced-tool');
  });
});
