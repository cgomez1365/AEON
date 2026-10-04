/**
 * commandRegistry: a command that declares takesAgent / takesHistory gets the
 * terminal's agent and its recent turns (capped) in the body it proxies —
 * /handoff needs both. A command that declares neither gets neither: its body
 * is exactly what it was.
 *
 * Drives the REAL scan of src/blocks/*\/block.manifest.json and the real
 * dispatch, against stand-in handlers for the declared routes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const commandRegistryFactory = require('../src/kernel/commandRegistry.cjs');

let server;
let savedPort;
const seen = [];

beforeEach(async () => {
  seen.length = 0;
  const app = express();
  // The server's app-wide JSON limit (server/earlyware.cjs APP_JSON_LIMIT).
  app.use(express.json({ limit: '10mb' }));
  app.post('/api/agents/handoff', (req, res) => { seen.push({ route: 'handoff', body: req.body }); res.json({ ok: true, text: 'saved' }); });
  app.post('/api/memory/add', (req, res) => { seen.push({ route: 'add', body: req.body }); res.json({ ok: true, text: 'saved' }); });
  app.get('/api/memory', (req, res) => { seen.push({ route: 'memory', query: req.query }); res.json({ ok: true, text: 'list' }); });
  const registry = commandRegistryFactory({ blockReadiness: {}, isVercel: false });
  app.use('/api', registry.router);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  savedPort = process.env.PORT;
  process.env.PORT = String(server.address().port);
});
afterEach(() => {
  try { server.close(); } catch {}
  if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
});

const dispatch = async (body) => {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/commands/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe('takesAgent / takesHistory', () => {
  it('/handoff forwards agent, capped history (20 turns, 4,000 chars each) and the note', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${'x'.repeat(5000)}`, agent: 'ledger', extra: 'dropped' }));
    const r = await dispatch({ cmd: '/handoff', arg: 'the April close', agent: 'ledger', history });
    expect(r.status).toBe(200);
    const body = seen.find((s) => s.route === 'handoff').body;
    expect(body.note).toBe('the April close');
    expect(body.agent).toBe('ledger');
    expect(body.history).toHaveLength(20);
    expect(body.history[0].content.startsWith('10:')).toBe(true);
    expect(body.history.every((t) => t.content.length === 4000)).toBe(true);
    expect(body.history[0]).toEqual({ role: 'user', content: body.history[0].content, agent: 'ledger' });
  });

  it('/handoff with no agent sends agent: null (the operator\'s own AEON) and no history when none was sent', async () => {
    await dispatch({ cmd: '/handoff' });
    const body = seen.find((s) => s.route === 'handoff').body;
    expect(body.agent).toBeNull();
    expect(body).not.toHaveProperty('history');
  });

  it('a command without the flags gets neither field', async () => {
    await dispatch({ cmd: '/remember', arg: 'The operator prefers mornings', agent: 'ledger', history: [{ role: 'user', content: 'x' }] });
    const body = seen.find((s) => s.route === 'add').body;
    expect(body).toEqual({ text: 'The operator prefers mornings' });
  });

  it('GET commands are unchanged', async () => {
    await dispatch({ cmd: '/memory', arg: 'mornings', agent: 'ledger', history: [{ role: 'user', content: 'x' }] });
    expect(seen.find((s) => s.route === 'memory').query).toEqual({ q: 'mornings' });
  });

  it('GET /api/commands exposes takesAgent and takesHistory', async () => {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/commands`);
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.commands || Object.values(data.registry || {}));
    const handoff = list.find((c) => c.cmd === '/handoff');
    expect(handoff).toMatchObject({ takesAgent: true, takesHistory: true, route: '/api/agents/handoff', method: 'POST' });
    expect(list.find((c) => c.cmd === '/remember')).toMatchObject({ takesAgent: false, takesHistory: false });
  });
});
