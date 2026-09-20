/**
 * /god/keys joins the credential POOL, not a single env-var slot.
 *
 * Found live, 2026-09-20: the operator reported "hot swap based on keys and
 * models is not working — mightve gotten disconnected". Root cause —
 * src/kernel/routers/console.cjs's /keys handler predates BO-KEYPOOL
 * (18c5cea, same day) and still wrote ONE key per provider to a single env
 * var via POST /api/settings/secrets. Rotation reads a POOL of vault refs
 * per connection (POST /api/connections/:id/keys, src/kernel/keyPool.cjs) —
 * a key added from the terminal never reached it. This is the file's OWN
 * stated doctrine broken by omission: "God mode NEVER bypasses the nervous
 * system... key adds proxy to /api/settings/secrets... so the terminal and
 * the Settings panel stay one source of truth" — true of the route that no
 * longer existed, silent about the one that replaced it.
 *
 * A second defect stacked on top, found the same night once the operator
 * actually exercised the terminal live: /api/connections and
 * /api/connections/:id/keys both declare `auth: true` in the settings
 * block's manifest, enforced for real by manifestRouteAuth.cjs ("Loopback
 * is not authentication"). console.cjs's internal fetch() to them carried
 * no cookie and no bearer header, so both 401'd on every real call once an
 * operator account existed — this route could never actually have worked
 * live, the same class of gap /god/models had (see
 * tests/god-models-registry-models.test.js). The stub below enforces auth
 * exactly like the real gate does.
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
  if (!authed) return res.status(401).json({ success: false, error: 'UNAUTHORIZED_SESSION', requires_auth: true, reason: 'no-session' });
  next();
}

/**
 * Mounts the REAL console router next to STUB /api/connections routes, on
 * ONE server — /god/keys must reach them by loopback HTTP, exactly as it
 * does in production (server/server.js mounts them as siblings under /api).
 */
async function mountWithConnections({ endpoints, onAddKey, enforceAuth = true }) {
  const app = express();
  app.use(express.json());

  const gate = enforceAuth ? requireSession : (req, res, next) => next();
  app.get('/api/connections', gate, (req, res) => res.json({ endpoints, roles: {} }));
  app.post('/api/connections/:id/keys', gate, (req, res) => {
    onAddKey(req.params.id, req.body);
    res.json({ ok: true, endpoint: { id: req.params.id }, keyPool: { total: 2 } });
  });
  // The OLD target — must NEVER be hit by the fixed handler.
  const legacySecretsHits = [];
  app.post('/api/settings/secrets', (req, res) => {
    legacySecretsHits.push(req.body);
    res.json({ ok: true });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  process.env.PORT = String(server.address().port);

  // console.cjs reads process.env.PORT at require-call time — fresh module
  // per test so it picks up THIS server's port.
  delete require.cache[require.resolve('../src/kernel/routers/console.cjs')];
  const consoleFactory = require('../src/kernel/routers/console.cjs');
  const consoleRouter = consoleFactory({ storage: { VAULT_ROOT: '/tmp/x', DATA_ROOT: '/tmp/y' } });
  app.use('/api/console', consoleRouter);

  return { server, legacySecretsHits, port: server.address().port };
}

const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('/god/keys adds to the connection pool, not a single env var — WITH a real operator session', () => {
  it('resolves the connection by provider and POSTs to /api/connections/:id/keys', async () => {
    const added = [];
    const { legacySecretsHits, port } = await mountWithConnections({
      endpoints: [{ id: 'ep-groq-1', provider: 'groq' }],
      onAddKey: (id, body) => added.push({ id, body }),
    });

    const r = await post(port, '/api/console/keys', { provider: 'groq', key: 'gsk_abcdefghijklmnop' }, { cookie: OPERATOR_COOKIE });
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(added).toEqual([{ id: 'ep-groq-1', body: { apiKey: 'gsk_abcdefghijklmnop' } }]);
    expect(legacySecretsHits.length).toBe(0);               // the old, disconnected path is never touched
    expect(body.text).toMatch(/pool now rotates/);
    expect(body.text).not.toMatch(/run \/restart/i);          // a pool add needs no restart — the old copy told the operator to run one
  });

  it('accepts the command-bus single-string arg form ("groq gsk_...")', async () => {
    const added = [];
    const { port } = await mountWithConnections({
      endpoints: [{ id: 'ep-or-1', provider: 'openrouter' }],
      onAddKey: (id, body) => added.push({ id, body }),
    });

    const r = await post(port, '/api/console/keys', { arg: 'openrouter sk-or-v1-abcdefgh' }, { cookie: OPERATOR_COOKIE });
    expect(r.status).toBe(200);
    expect(added[0]).toEqual({ id: 'ep-or-1', body: { apiKey: 'sk-or-v1-abcdefgh' } });
  });

  it('says plainly when no connection exists yet, instead of guessing one', async () => {
    const { port } = await mountWithConnections({ endpoints: [], onAddKey: () => {} });
    const r = await post(port, '/api/console/keys', { provider: 'gemini', key: 'AIzaSyABCDEFGHIJKLMN' }, { cookie: OPERATOR_COOKIE });
    const body = await r.json();
    expect(r.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.text).toMatch(/Settings → Connections/);
  });

  it('still refuses an unknown provider and a too-short key before any network call', async () => {
    const { port } = await mountWithConnections({ endpoints: [], onAddKey: () => {} });
    const bad = await post(port, '/api/console/keys', { provider: 'notarealprovider', key: 'whatever12345' }, { cookie: OPERATOR_COOKIE });
    expect(bad.status).toBe(400);
    const short = await post(port, '/api/console/keys', { provider: 'groq', key: 'short' }, { cookie: OPERATOR_COOKIE });
    expect(short.status).toBe(400);
  });
});

describe('/god/keys forwards the caller\'s session to its internal calls', () => {
  it('a bearer token reaches both /api/connections and /api/connections/:id/keys', async () => {
    const added = [];
    const { port } = await mountWithConnections({
      endpoints: [{ id: 'ep-groq-1', provider: 'groq' }],
      onAddKey: (id, body) => added.push({ id, body }),
    });
    const r = await post(port, '/api/console/keys', { provider: 'groq', key: 'gsk_abcdefghijklmnop' }, { authorization: 'Bearer real-operator-bearer-token' });
    expect(r.status).toBe(200);
    expect(added.length).toBe(1);
  });

  // Reproduces the operator's exact live report: the fix that resolved the
  // connection correctly still could not add a key, because the internal
  // calls carried no session — the SAME defect class as /god/models', now
  // pinned here too.
  it('with no session forwarded, both internal calls 401 and the operator sees why, not a crash', async () => {
    const { port } = await mountWithConnections({
      endpoints: [{ id: 'ep-groq-1', provider: 'groq' }],
      onAddKey: () => {},
    });
    const r = await post(port, '/api/console/keys', { provider: 'groq', key: 'gsk_abcdefghijklmnop' });
    const body = await r.json();
    expect(r.status).not.toBe(200);
    expect(body.ok).not.toBe(true);
  });
});
