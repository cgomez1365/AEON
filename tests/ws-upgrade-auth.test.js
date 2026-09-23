/**
 * /ws carries the live terminal event stream. It had no origin check and no
 * session check (src/kernel/ws.cjs attached a bare WebSocket.Server).
 *
 * Measured 2026-09-23 on a live server with an operator account and the guard
 * ON: a client sending `Origin: https://evil.example` and no session opened
 * ws://127.0.0.1:<port>/ws and received {"type":"connected"} — any web page
 * the operator visits can do that from their browser, because WebSocket has
 * no CORS: the server is the only place the origin can be checked. HTTP
 * middleware (the session guard) never sees an upgrade.
 *
 * The rule now, mirroring the rest of AEON exactly:
 *  - a browser origin that is not this server's own (or an allow-listed one)
 *    is refused, account or not;
 *  - once an operator account exists, a valid session is required (the same
 *    validateSession the HTTP guard uses: cookie, Bearer, ?token=, or the
 *    AEON_MOBILE_SECRET machine bearer);
 *  - with no account, nothing in AEON can hold a session, so none is asked for.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const attachWS = require('../src/kernel/ws.cjs');
const { createSessionValidator } = require('../src/kernel/server-utils/sessionValidator.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ws-auth-'));
const sessions = createSessionValidator({
  securityDir: path.join(TMP, 'Vault', 'blocks', 'security'),
  legacyUserFile: path.join(TMP, 'secrets', 'aeon-user.json'),
  bootTime: Date.now() - 1000,
  mobileSecret: 'machine-fixture-secret',
});

const stream = new EventEmitter();
let server;
let port;
let wss;

beforeAll(async () => {
  server = http.createServer();
  wss = attachWS(server, {
    aeonTerminalStream: stream,
    sessions,
    allowedOrigins: ['http://localhost:3000'],
    log: { log() {}, warn() {} },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  try { wss?.close(); } catch {}
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  try { fs.rmSync(sessions.AUTH_FILE, { force: true }); } catch {}
});

function seedAccount() {
  const now = Date.now();
  sessions.saveUser({
    username: 'operator', role: 'operator', salt: 's', passHash: 'h',
    sessions: { 'ws-fixture-token': { created: now, lastSeen: now, expires: now + 3_600_000 } },
  });
}

/** Resolves {opened, status, firstMessage}. Never hangs. */
function tryOpen({ origin, headers = {}, query = '' } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers: h });
    const done = (v) => { try { ws.terminate(); } catch {} resolve(v); };
    ws.on('message', (m) => done({ opened: true, firstMessage: JSON.parse(String(m)) }));
    ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }));
    ws.on('error', () => done({ opened: false, status: 0 }));
    setTimeout(() => done({ opened: false, status: -1 }), 3000);
  });
}

const OWN = () => `http://127.0.0.1:${port}`;

describe('origin — refused whether or not an account exists', () => {
  it('a foreign page is refused before any account exists', async () => {
    const r = await tryOpen({ origin: 'https://evil.example' });
    expect(r.opened, 'a foreign origin opened the event stream').toBe(false);
    expect(r.status).toBe(403);
  });

  it('a foreign page is refused with a valid session cookie too (cookies ride along cross-site)', async () => {
    seedAccount();
    const r = await tryOpen({ origin: 'https://evil.example', headers: { Cookie: 'aeon_session=ws-fixture-token' } });
    expect(r.opened).toBe(false);
    expect(r.status).toBe(403);
  });

  it('another localhost port is a different origin and is refused', async () => {
    const r = await tryOpen({ origin: 'http://localhost:8080' });
    expect(r.opened).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('no account — open by design, like every other AEON route', () => {
  it('the server\'s own origin connects without a session', async () => {
    const r = await tryOpen({ origin: OWN() });
    expect(r.opened).toBe(true);
    expect(r.firstMessage.type).toBe('connected');
  });

  it('an allow-listed origin (the Vite dev server) connects', async () => {
    const r = await tryOpen({ origin: 'http://localhost:3000' });
    expect(r.opened).toBe(true);
  });

  it('a non-browser client (no Origin header) connects', async () => {
    const r = await tryOpen({});
    expect(r.opened).toBe(true);
  });
});

describe('account present — a session is required', () => {
  it('own origin, no session: refused 401', async () => {
    seedAccount();
    const r = await tryOpen({ origin: OWN() });
    expect(r.opened, 'no session, yet the stream opened').toBe(false);
    expect(r.status).toBe(401);
  });

  it('no Origin header does not skip the session check', async () => {
    seedAccount();
    const r = await tryOpen({});
    expect(r.status).toBe(401);
  });

  it('a wrong token is refused', async () => {
    seedAccount();
    const r = await tryOpen({ origin: OWN(), headers: { Cookie: 'aeon_session=not-a-token' } });
    expect(r.status).toBe(401);
  });

  it.each([
    ['cookie', { headers: { Cookie: 'aeon_session=ws-fixture-token' } }],
    ['bearer', { headers: { Authorization: 'Bearer ws-fixture-token' } }],
    ['query token', { query: '?token=ws-fixture-token' }],
    ['machine secret', { headers: { Authorization: 'Bearer machine-fixture-secret' } }],
  ])('own origin with a valid %s connects', async (_label, opts) => {
    seedAccount();
    const r = await tryOpen({ origin: OWN(), ...opts });
    expect(r.opened).toBe(true);
    expect(r.firstMessage.type).toBe('connected');
  });

  it('an authorised client still receives the event stream', async () => {
    seedAccount();
    const got = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: OWN(), Cookie: 'aeon_session=ws-fixture-token' } });
      const seen = [];
      ws.on('message', (m) => {
        seen.push(JSON.parse(String(m)));
        if (seen.length === 1) stream.emit('log', { type: 'TEST', message: 'hello' });
        if (seen.length === 2) { ws.terminate(); resolve(seen); }
      });
      setTimeout(() => { ws.terminate(); resolve(seen); }, 3000);
    });
    expect(got.map((e) => e.type)).toEqual(['connected', 'TEST']);
  });
});
