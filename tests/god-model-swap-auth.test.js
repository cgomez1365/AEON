/**
 * /god/model-swap forwards the caller's session to /api/settings/nl.
 *
 * The third and last of console.cjs's internal loopback calls to inherit
 * this defect class (see tests/god-models-registry-models.test.js and
 * tests/god-keys-pool.test.js for the other two, found the same night).
 * /api/settings/nl declares `auth: true` in the settings block's manifest;
 * a bare fetch() with no cookie and no bearer header 401s on it once an
 * operator account exists, so every hotswap the operator picked from the
 * terminal dropdown would have silently failed even after the dropdown
 * itself started showing real models. Had no test coverage at all before
 * this — the field-name bug in /god/models is what surfaced the whole
 * class of defect live; this route was never separately exercised.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let servers = [];
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } servers = []; });

const OPERATOR_COOKIE = 'aeon_session=real-operator-session-token';

function requireSession(req, res, next) {
  const authed = req.headers.cookie === OPERATOR_COOKIE || req.headers.authorization === 'Bearer real-operator-bearer-token';
  if (!authed) return res.status(401).json({ success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true, reason: 'no-session' });
  next();
}

async function mount() {
  const app = express(); app.use(express.json());
  const calls = [];
  app.post('/api/settings/nl', requireSession, (req, res) => {
    calls.push(req.body.phrase);
    res.json({ ok: true, role: 'chat', provider: 'groq', model: 'openai/gpt-oss-120b', message: 'chat → groq / openai/gpt-oss-120b' });
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  process.env.PORT = String(server.address().port);

  delete require.cache[require.resolve('../src/kernel/routers/console.cjs')];
  const consoleFactory = require('../src/kernel/routers/console.cjs');
  app.use('/api/console', consoleFactory({ storage: { VAULT_ROOT: '/tmp/x', DATA_ROOT: '/tmp/y' } }));

  const port = server.address().port;
  return { calls, swap: (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/console/model-swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }) };
}

describe('/god/model-swap', () => {
  it('with the operator\'s session forwarded, the swap phrase reaches /api/settings/nl and succeeds', async () => {
    const { calls, swap } = await mount();
    const r = await swap({ role: 'chat', provider: 'groq', model: 'openai/gpt-oss-120b' }, { cookie: OPERATOR_COOKIE });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(calls).toEqual(['set chat to groq openai/gpt-oss-120b']);
  });

  it('a bearer token works too', async () => {
    const { calls, swap } = await mount();
    await swap({ role: 'chat', provider: 'groq', model: 'openai/gpt-oss-120b' }, { authorization: 'Bearer real-operator-bearer-token' });
    expect(calls.length).toBe(1);
  });

  // Reproduces the live defect class: without a forwarded session, the
  // swap the operator picked from the dropdown silently fails.
  it('with no session forwarded, the swap 401s instead of silently succeeding', async () => {
    const { calls, swap } = await mount();
    const r = await swap({ role: 'chat', provider: 'groq', model: 'openai/gpt-oss-120b' });
    const body = await r.json();
    expect(r.status).toBe(401);
    expect(body.ok).not.toBe(true);
    expect(calls.length).toBe(0);
  });
});
