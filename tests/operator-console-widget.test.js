/**
 * BO-A5a — the Operator Console's unpaid obligations, built as a widget.
 *
 * God Mode became the Operator Console and the execution surface was deleted.
 * The obligations that came with the rename — capability badges, preflight
 * preview, an audit screen, and safe mode — had been outstanding since
 * 2026-08-02. They are built under BO-A2's widget contract rather than as
 * bespoke settings pages, so two build orders close with one piece of work.
 *
 * These drive the REAL host_os router. Safe mode is asserted by DRIVING an
 * action and watching it be refused — not by checking that a flag exists.
 * "Every security fix needs a functional test, not only an absence test" is a
 * standing rule of this build order, and a safe-mode toggle that only greys out
 * a button is decoration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const createOsRouter = require('../src/blocks/host_os/api/os.cjs');
const { buildWidgetCatalogue } = require('../src/kernel/widgets.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-console-'));
const AUDIT_FILE = path.join(TMP, 'audit.json');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const audits = [];

function makeApp() {
  audits.length = 0;
  fs.writeFileSync(AUDIT_FILE, JSON.stringify([
    { id: 'a1', action: 'OS_ACTION', details: 'getStatus: read host OS version', status_code: 0, timestamp: new Date().toISOString() },
  ], null, 2));

  const router = createOsRouter({
    isVercel: false,
    WORKSPACE: TMP,
    ALLOWED_ROOTS: [TMP],
    AUDIT_FILE,
    writeOSAudit: (action, details, code) => audits.push({ action, details, code }),
    // The gate under test is safe mode, not auth — let every request through so
    // a refusal can only come from safe mode itself.
    requireShellAuth: (_req, _res, next) => next(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

/** Minimal in-process request driver — no port, no listener. */
function call(app, method, url, body) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    // BO-C2: the widget route carries requireOperator now (a read gate), not the
    // injected requireShellAuth stub, so the driver must present a realistic
    // origin. 127.0.0.1 with no account configured is the owner at their own
    // keyboard on a fresh install — the one case that must never be refused.
    // The gate is exercised for real here rather than stubbed away.
    const req = {
      method, url, headers: { 'content-type': 'application/json' },
      body: body || {}, ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }, connection: { remoteAddress: '127.0.0.1' },
    };
    const res = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { chunks.push(JSON.stringify(b)); return this.end(); },
      send(b) { chunks.push(String(b)); return this.end(); },
      end() {
        if (done) return this;
        done = true;
        let parsed = null;
        try { parsed = JSON.parse(chunks.join('')); } catch {}
        resolve({ status: this.statusCode, body: parsed });
        return this;
      },
    };
    app.handle(req, res, () => { if (!done) { done = true; resolve({ status: 404, body: null }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ status: -1, body: null }); } }, 5000);
  });
}

describe('capability badges and preflight preview', () => {
  it('names what this install can actually do', async () => {
    const r = await call(makeApp(), 'GET', '/api/host_os/widget');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.capabilities)).toBe(true);
    expect(r.body.capabilities.length).toBeGreaterThan(0);
    for (const c of r.body.capabilities) {
      expect(c.id).toBeTruthy();
      expect(c.description).toBeTruthy();
    }
  });

  it('shows the exact executable and argv BEFORE anything is approved', async () => {
    const r = await call(makeApp(), 'GET', '/api/host_os/widget');
    const status = r.body.capabilities.find(c => c.id === 'getStatus');
    expect(Array.isArray(status.preflight)).toBe(true);
    expect(status.preflight.length).toBeGreaterThan(0);
    // An argument ARRAY, never an interpolated command string — that is the
    // structural property the shell removal bought.
    expect(status.preflight.every(a => typeof a === 'string')).toBe(true);
    expect(status.preflight.join(' ')).not.toMatch(/[;&|`$]/);
  });

  it('surfaces the recent audit trail', async () => {
    const r = await call(makeApp(), 'GET', '/api/host_os/widget');
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.items[0].label).toMatch(/getStatus|no OS actions/);
  });
});

describe('the audit screen', () => {
  it('returns real entries', async () => {
    const r = await call(makeApp(), 'GET', '/api/host_os/audit');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.entries.length).toBe(1);
  });

  it('reports an unreadable trail rather than rendering it as clean (R-05)', async () => {
    const app = makeApp();
    fs.writeFileSync(AUDIT_FILE, '{ not json');
    const r = await call(app, 'GET', '/api/host_os/audit');
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/audit unreadable/);
  });
});

describe('safe mode actually refuses — driven, not asserted', () => {
  it('permits an action when off, refuses the SAME action when on', async () => {
    const app = makeApp();

    // Off by default: the action reaches the executor. It may still fail for
    // environmental reasons, but it must NOT be refused by safe mode (423).
    const before = await call(app, 'POST', '/api/os/action', { action: 'getStatus' });
    expect(before.status).not.toBe(423);

    const on = await call(app, 'POST', '/api/host_os/safe-mode', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.safeMode).toBe(true);

    // Same request, now refused. This is the assertion the obligation is for.
    const after = await call(app, 'POST', '/api/os/action', { action: 'getStatus' });
    expect(after.status).toBe(423);
    expect(after.body.safeMode).toBe(true);
    expect(after.body.error).toMatch(/Safe mode is on/);
  });

  it('is enforced at the execution entry point, not in the UI', () => {
    // The refusal must sit in the route that spawns, so a caller bypassing the
    // settings screen is refused too.
    const src = fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'os.cjs'), 'utf8');
    const actionIdx = src.indexOf("router.post('/os/action'");
    const guardIdx = src.indexOf('if (safeMode)');
    expect(actionIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(actionIdx);
    // And before anything is executed.
    expect(guardIdx).toBeLessThan(src.indexOf('execFile(spec.file'));
  });

  it('records both the toggle and every refusal in the audit trail', async () => {
    const app = makeApp();
    await call(app, 'POST', '/api/host_os/safe-mode', { enabled: true });
    await call(app, 'POST', '/api/os/action', { action: 'getStatus' });

    expect(audits.some(a => a.action === 'SAFE_MODE' && a.details === 'enabled')).toBe(true);
    expect(audits.some(a => a.action === 'OS_ACTION_REFUSED')).toBe(true);
  });

  it('can be turned back off — it is a switch, not a trap', async () => {
    const app = makeApp();
    await call(app, 'POST', '/api/host_os/safe-mode', { enabled: true });
    const off = await call(app, 'POST', '/api/host_os/safe-mode', { enabled: false });
    expect(off.body.safeMode).toBe(false);
    const after = await call(app, 'POST', '/api/os/action', { action: 'getStatus' });
    expect(after.status).not.toBe(423);
  });
});

describe('it is a widget, not a bespoke page', () => {
  it('host_os declares the widget and the kernel accepts it', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'block.manifest.json'), 'utf8'));
    expect(manifest.widget).toBeTruthy();
    expect(manifest.widget.endpoint).toBe('/api/host_os/widget');

    const { widgets, refused } = buildWidgetCatalogue([{ id: 'host_os', ...manifest }]);
    expect(refused).toEqual([]);
    expect(widgets[0].label).toBe('Operator Console');
  });

  it('the widget endpoint is a route host_os genuinely declares', () => {
    // The gate reads the generated manifest, so a widget pointing at a route
    // the block does not serve is refused.
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'block.manifest.json'), 'utf8'));
    const declared = (manifest.routes || []).some(r => r.path === '/api/host_os/widget');
    expect(declared, 'the generator must have picked the widget route up').toBe(true);
  });
});
