/**
 * The HOTSWAP CHAT MODEL dropdown reads the field the data is actually in,
 * AND reaches it at all — its internal call carries the operator's session.
 *
 * Found live, 2026-09-20 (operator: "model picker failed?", then "restarted
 * - failed -" after the first fix). Two real, separate defects stacked:
 *
 *   1. /api/settings/nervous-system's buildNervousSystem() names this field
 *      `registryModels` (src/blocks/settings/api/settings.js:566);
 *      /god/models read `p.models`, a key that response never sets. Fixed
 *      first — real, but NOT sufficient on its own, which is why the
 *      operator saw it still fail after restarting.
 *   2. /api/settings/nervous-system declares `auth: true` in the settings
 *      block's manifest, enforced for real by manifestRouteAuth.cjs
 *      ("Loopback is not authentication" — its own comment). /god/models'
 *      internal `fetch()` carried no cookie and no bearer header, so it
 *      401'd on every call once an operator account existed — `ns.providers`
 *      was always undefined, `groups` was always `[]`, and the dropdown
 *      never had anything to show regardless of fix #1. This is the SAME
 *      defect class dashboard/api/chat.cjs already named forwardedAuth() for
 *      a different route; console.cjs never got the fix.
 *
 * The stub below enforces auth exactly like the real gate does, so a test
 * that forgets to forward the header fails here the same way the operator's
 * browser did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let servers = [];
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } servers = []; });

const OPERATOR_COOKIE = 'aeon_session=real-operator-session-token';

/** Mirrors manifestRouteAuth.cjs: a declared auth:true route 401s without a real session — loopback alone is not enough. */
function requireSession(req, res, next) {
  const authed = req.headers.cookie === OPERATOR_COOKIE || req.headers.authorization === 'Bearer real-operator-bearer-token';
  if (!authed) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true, reason: 'no-session' });
  }
  next();
}

async function mountWithNervousSystem(providers, { enforceAuth = true } = {}) {
  const app = express(); app.use(express.json());
  app.get('/api/settings/nervous-system', enforceAuth ? requireSession : (req, res, next) => next(), (req, res) => res.json({ providers }));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  process.env.PORT = String(server.address().port);

  delete require.cache[require.resolve('../src/kernel/routers/console.cjs')];
  const consoleFactory = require('../src/kernel/routers/console.cjs');
  app.use('/api/console', consoleFactory({ storage: { VAULT_ROOT: '/tmp/x', DATA_ROOT: '/tmp/y' } }));

  const port = server.address().port;
  return (reqHeaders) => fetch(`http://127.0.0.1:${port}/api/console/models`, { headers: reqHeaders }).then((r) => r.json());
}

describe('/god/models reads registryModels, not models — WITH a real operator session', () => {
  it('a provider with a real model list (registryModels) is not reported empty', async () => {
    const getModels = await mountWithNervousSystem({
      groq: { id: 'groq', label: 'Groq', configured: true, registryModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] },
      openrouter: { id: 'openrouter', label: 'OpenRouter', configured: true, registryModels: ['openrouter/free', 'anthropic/claude-sonnet-5'] },
    });
    const body = await getModels({ cookie: OPERATOR_COOKIE });
    expect(body.ok).toBe(true);
    const groq = body.groups.find((g) => g.provider === 'groq');
    const openrouter = body.groups.find((g) => g.provider === 'openrouter');
    expect(groq.hasKey).toBe(true);
    // models is now sortModels()'s output shape: {id, free}[], sorted free-first
    // then by the intelligence heuristic — see tests/model-intelligence.test.js
    // for that logic's own coverage; this file only checks it's wired in.
    expect(groq.models.map((m) => m.id)).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    expect(openrouter.models.map((m) => m.id)).toContain('openrouter/free');
    expect(openrouter.models.find((m) => m.id === 'openrouter/free').free).toBe(true);
  });

  it('a provider with genuinely no models still reports empty honestly, not a crash', async () => {
    const getModels = await mountWithNervousSystem({
      custom: { id: 'custom', label: 'Custom', configured: false, registryModels: [] },
    });
    const body = await getModels({ cookie: OPERATOR_COOKIE });
    const custom = body.groups.find((g) => g.provider === 'custom');
    expect(custom.models).toEqual([]);
    expect(custom.hasKey).toBe(false);
  });

  it('still tolerates a plain `models` field if some future caller sets one', async () => {
    const getModels = await mountWithNervousSystem({
      legacy: { id: 'legacy', label: 'Legacy', configured: true, models: ['old-style-field'] },
    });
    const body = await getModels({ cookie: OPERATOR_COOKIE });
    expect(body.groups.find((g) => g.provider === 'legacy').models).toEqual([{ id: 'old-style-field', free: false }]);
  });

  it('the response names its own sort order — the "small note" the CEO asked for', async () => {
    const getModels = await mountWithNervousSystem({ groq: { id: 'groq', configured: true, registryModels: [] } });
    const body = await getModels({ cookie: OPERATOR_COOKIE });
    expect(body.sortNote).toMatch(/free.*first/i);
    expect(body.sortNote).toMatch(/not a benchmark/i);
  });
});

describe('/god/models forwards the caller\'s session to its internal call', () => {
  it('the operator\'s cookie reaches nervous-system, and groups populate', async () => {
    const getModels = await mountWithNervousSystem({
      groq: { id: 'groq', label: 'Groq', configured: true, registryModels: ['openai/gpt-oss-120b'] },
    });
    const body = await getModels({ cookie: OPERATOR_COOKIE });
    expect(body.ok).toBe(true);
    expect(body.groups.find((g) => g.provider === 'groq').models).toEqual([{ id: 'openai/gpt-oss-120b', free: false }]);
  });

  it('a bearer token works too, not only a cookie', async () => {
    const getModels = await mountWithNervousSystem({
      groq: { id: 'groq', label: 'Groq', configured: true, registryModels: ['openai/gpt-oss-120b'] },
    });
    const body = await getModels({ authorization: 'Bearer real-operator-bearer-token' });
    expect(body.groups.find((g) => g.provider === 'groq').models).toEqual([{ id: 'openai/gpt-oss-120b', free: false }]);
  });

  // This is the operator's exact live symptom, reproduced: the browser DID
  // carry a real session to the terminal's own request, but console.cjs's
  // internal call to nervous-system was the one that dropped it — proven
  // here by calling WITHOUT forwarding a session ourselves and confirming
  // the internal auth gate is what empties the result, not the caller.
  it('with no session at all, nervous-system 401s internally and groups come back empty — not a crash', async () => {
    const getModels = await mountWithNervousSystem({
      groq: { id: 'groq', label: 'Groq', configured: true, registryModels: ['openai/gpt-oss-120b'] },
    });
    const body = await getModels({});
    expect(body.ok).toBe(true);        // /god/models itself still answers —
    expect(body.groups).toEqual([]);   // — but with nothing in it, exactly what the operator saw.
  });
});
