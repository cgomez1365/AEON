/**
 * The terminal distils the chat on screen, and shows the quotes /ask-doc needs.
 *
 *   - Memory Core's button distils the newest chat SAVED to disk; a live chat
 *     is not on disk until saved, so it once returned memories from an
 *     unrelated conversation. The terminal's DISTIL → MEMORY sends its live
 *     feed instead, built exactly as the server builds a saved one.
 *   - A palette pick gave "/ask-doc " and left the operator to remember that
 *     the document comes first and needs quotes. The registry already knew
 *     the fields; now the pick inserts the quotes and a hint shows the rest.
 *
 * No DOM in this suite (environment: 'node'): the decisions are pure exports,
 * and the last block checks the component calls them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { liveTranscript, pickInsertion, usageHint, namesDocument, paramNames } from '../src/components/Terminal2.jsx';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'components', 'Terminal2.jsx'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'block.manifest.json'), 'utf8'));
const REGISTRY = (MANIFEST.contract?.commands || []).filter(Boolean);

describe('the live transcript', () => {
  it('is the conversation turns only, as "role: content" lines', () => {
    const feed = [
      { id: 0, type: 'msg', role: 'system', content: 'AEON online' },
      { id: 1, type: 'chip', cmd: '/help' },
      { id: 2, type: 'msg', role: 'error', content: 'oops' },
      { id: 3, type: 'msg', role: 'user', content: 'what is due friday' },
      { id: 4, type: 'msg', role: 'assistant', content: 'the vendor invoice' },
    ];
    expect(liveTranscript(feed)).toBe('user: what is due friday\nassistant: the vendor invoice');
  });

  it('is nothing to send until there are two turns', () => {
    expect(liveTranscript([{ type: 'msg', role: 'user', content: 'hi' }])).toBeNull();
    expect(liveTranscript([])).toBeNull();
    expect(liveTranscript(undefined)).toBeNull();
  });

  it('keeps the last 30 turns, each cut to 400 characters, empty content as empty', () => {
    const feed = Array.from({ length: 35 }, (_, i) => ({ type: 'msg', role: i % 2 ? 'assistant' : 'user', content: i === 34 ? 'x'.repeat(500) : (i === 33 ? undefined : `t${i}`) }));
    const lines = liveTranscript(feed).split('\n');
    expect(lines).toHaveLength(30);
    expect(lines[0]).toBe('assistant: t5');
    expect(lines[28]).toBe('assistant: ');
    expect(lines[29]).toBe(`user: ${'x'.repeat(400)}`);
  });
});

describe('picking a command from the palette', () => {
  const askDoc = { cmd: '/ask-doc', params: [{ name: 'path' }, { name: 'query' }] };

  it('puts the caret between the quotes when the first field names a document', () => {
    const { text, caret } = pickInsertion(askDoc);
    expect(text).toBe('/ask-doc ""');
    expect(caret).toBe(text.length - 1);
  });

  it('keeps the old trailing space otherwise', () => {
    for (const c of [{ cmd: '/ask', params: [{ name: 'query' }] }, { cmd: '/read', param: 'path' }, { cmd: '/help' }]) {
      const { text, caret } = pickInsertion(c);
      expect(text).toBe(`${c.cmd} `);
      expect(caret).toBe(text.length);
    }
  });

  it('matches a document field by its whole name, in any case', () => {
    expect(pickInsertion({ cmd: '/x', params: [{ name: 'Title' }] }).text).toBe('/x ""');
    expect(pickInsertion({ cmd: '/x', params: ['FILE'] }).text).toBe('/x ""');
    expect(pickInsertion({ cmd: '/x', params: [{ name: 'filePath' }] }).text).toBe('/x ');
    for (const n of ['path', 'file', 'filename', 'title', 'doc', 'document']) expect(namesDocument(n)).toBe(true);
    for (const n of ['docs', 'filePath', 'query', '', null]) expect(namesDocument(n)).toBe(false);
  });

  it('reads params as strings or { name }, and ignores the nameless', () => {
    expect(paramNames({ params: ['a', { name: 'b' }, { type: 'string' }, null, ''] })).toEqual(['a', 'b']);
    expect(paramNames({ param: 'only-singular' })).toEqual([]);
  });
});

describe('the usage hint', () => {
  const commands = [
    { cmd: '/ask-doc', params: [{ name: 'path' }, { name: 'query' }] },
    { cmd: '/writefile', params: [{ name: 'filePath' }, { name: 'content' }] },
    { cmd: '/strings', params: ['title', 'body'] },
    { cmd: '/help' },
  ];

  it('shows what the command still expects', () => {
    expect(usageHint('/ask-doc "Org Behavior.pdf" wh', commands)).toBe('/ask-doc "path" <query>');
    expect(usageHint('/ask-doc', commands)).toBe('/ask-doc "path" <query>');
    expect(usageHint('/writefile', commands)).toBe('/writefile <filePath> <content>');
    expect(usageHint('/strings x', commands)).toBe('/strings "title" <body>');
  });

  it('shows nothing for plain text, unknown commands, or commands without fields', () => {
    expect(usageHint('hello', commands)).toBeNull();
    expect(usageHint('/nope', commands)).toBeNull();
    expect(usageHint('/help', commands)).toBeNull();
    expect(usageHint('/ASK-DOC', commands)).toBeNull();
    expect(usageHint('', commands)).toBeNull();
  });

  it('reads the real /ask-doc declaration from the aeon_matrix manifest', () => {
    const real = REGISTRY.find((c) => c.cmd === '/ask-doc');
    expect(real, 'aeon_matrix declares /ask-doc').toBeDefined();
    expect(usageHint('/ask-doc ', REGISTRY)).toBe('/ask-doc "path" <query>');
  });
});

describe('the component uses them', () => {
  it('a palette pick goes through pickInsertion, not a bare setInput', () => {
    expect(SRC).toMatch(/onClick=\{\(\) => pickCommand\(c\)\}/);
    expect(SRC).toMatch(/pickInsertion\(c\)/);
    expect(SRC).not.toMatch(/setInput\(c\.cmd \+ ' '\)/);
    expect(SRC).toMatch(/requestAnimationFrame\(/);
  });

  it('DISTIL → MEMORY sits between SAVE and history, and is disabled in flight', () => {
    const save = SRC.indexOf('<Archive size={11} /> SAVE');
    const distil = SRC.indexOf("'DISTIL → MEMORY'");
    const history = SRC.indexOf('<History size={11} /> HISTORY');
    expect(save).toBeGreaterThan(-1);
    expect(distil).toBeGreaterThan(save);
    expect(history).toBeGreaterThan(distil);
    expect(SRC).toMatch(/onClick=\{distillChat\} disabled=\{distilling\}/);
    expect(SRC).toMatch(/DISTILLING…/);
  });

  it('sends the live transcript and nothing else', () => {
    expect(SRC).toMatch(/liveTranscript\(feedRef\.current/);
    // The transcript, plus which agent's memory it goes to (2026-10-02) —
    // a scope, not a different conversation.
    expect(SRC).toMatch(/body: JSON\.stringify\(\{ transcript, \.\.\.agentBody\(\) \}\)/);
    const call = SRC.slice(SRC.indexOf("fetch('/api/memory/distill'"), SRC.indexOf('distillSummary(d)'));
    expect(call).not.toMatch(/force|sessionId/);
  });

  it('renders the hint above the input row, never as the placeholder', () => {
    const hint = SRC.indexOf('{hint && (');
    const inputRow = SRC.indexOf("<div style={{ display: 'flex', alignItems: 'flex-end'");
    expect(hint).toBeGreaterThan(-1);
    expect(inputRow).toBeGreaterThan(hint);
    expect(SRC).toMatch(/useMemo\(\(\) => usageHint\(input, commands\), \[input, commands\]\)/);
    expect(SRC).not.toMatch(/placeholder=\{hint/);
  });
});
