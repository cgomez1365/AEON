/**
 * Arguments are split the way a person types them.
 *
 * The usage line prints placeholders as <filePath> <content>. An operator typed
 * them literally — `/writefile <C:\Users\…\aeon> <this is a test>` — and the
 * dispatcher handed fs/write a path with the brackets in it, so mkdir failed
 * on a folder named "<C:\Users\cgome\Documents". A value in quotes or angle
 * brackets is one value, with the wrapper removed (2026-09-07).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const commandRegistryFactory = require('../src/kernel/commandRegistry.cjs');

let servers, seen, savedPort;
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port })); });

beforeEach(async () => {
  servers = []; seen = [];
  // Stand in for the block route the dispatcher proxies to.
  const block = express(); block.use(express.json());
  block.post('/api/fs/write', (req, res) => { seen.push(req.body); res.json({ success: true, path: req.body.filePath }); });
  block.post('/api/fs/read', (req, res) => { seen.push(req.body); res.json({ success: true, text: 'ok' }); });
  const b = await listen(block); servers.push(b.server);
  savedPort = process.env.PORT; process.env.PORT = String(b.port);   // the dispatcher addresses itself by PORT
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort; });

async function dispatch(cmd, arg) {
  const { router } = commandRegistryFactory({ blockReadiness: {}, isVercel: false });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const h = await listen(app); servers.push(h.server);
  const r = await fetch(`http://127.0.0.1:${h.port}/api/commands/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, arg, confirmed: true }) });   // /writefile is dangerous: pre-confirm, as the terminal does after the operator says yes
  return { status: r.status, body: await r.json() };
}

describe('typed arguments', () => {
  it('angle-bracket placeholders typed literally are unwrapped', async () => {
    const r = await dispatch('/writefile', '<C:\\Users\\cgome\\Documents\\aeon.md> <this is a test to see if this works>');
    expect(r.status).toBe(200);
    expect(seen[0]).toEqual({ filePath: 'C:\\Users\\cgome\\Documents\\aeon.md', content: 'this is a test to see if this works' });
  });

  it('a quoted path with spaces is one value', async () => {
    const r = await dispatch('/writefile', '"C:\\Users\\cgome\\My Docs\\note.md" hello there');
    expect(r.status).toBe(200);
    expect(seen[0]).toEqual({ filePath: 'C:\\Users\\cgome\\My Docs\\note.md', content: 'hello there' });
  });

  it('bare values still work as before', async () => {
    await dispatch('/writefile', 'notes.md some longer content here');
    expect(seen[0]).toEqual({ filePath: 'notes.md', content: 'some longer content here' });
  });

  it('a single-param command unwraps too', async () => {
    await dispatch('/read', '<C:\\Users\\cgome\\Documents\\memo.pdf>');
    expect(seen[0].filePath).toBe('C:\\Users\\cgome\\Documents\\memo.pdf');
  });

  it('the missing-values error says not to type the brackets', async () => {
    const r = await dispatch('/writefile', 'only-a-path.md');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/angle brackets mark placeholders/);
  });
});
