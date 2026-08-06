/**
 * BO-D2b — the operator gate, generalized.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (2026-08-05): `/scan` answered the
 * operator with "Unauthorized: an operator session ... required". Reproduced
 * live on 2026-08-06 against a running server:
 *
 *   POST /api/commands/dispatch {"cmd":"/scan"}
 *   → "OS endpoints disabled: sign in, or configure AEON_MOBILE_SECRET
 *      for headless access."
 *
 * BO-C2 already moved the read-only Operator Console widget off
 * `requireShellAuth`. `/scan` proves the pattern is wider: routes the
 * operator legitimately needs sit behind the RAW EXECUTION gate, which
 * demands a session from every origin, while the global guard that would
 * have created that session is opt-in and off by default. So a fresh
 * install refuses its owner a sync.
 *
 * THE RULE, and it is a narrow one:
 *
 *   reads, reports and syncs  →  requireOperator
 *   anything that EXECUTES    →  requireShellAuth, unchanged
 *
 * §13's position is not weakened by this. This suite therefore asserts BOTH
 * directions — the second half is the one that matters, because a gate audit
 * that only proves things opened up is how a security fix becomes a
 * regression.
 *
 * Drives the REAL routers. Nothing is re-implemented inline.
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

const createOsRouter = require('../src/blocks/host_os/api/os.cjs');
const createSystemRouter = require('../src/blocks/host_os/api/system.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-gate-scope-'));
const AUDIT_FILE = path.join(TMP, 'audit.json');
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

/**
 * Build the routers with a requireShellAuth that REFUSES, exactly as it does
 * on a fresh install with no operator session. Any route still carrying that
 * gate will 401 here; any route that has moved will not.
 */
function makeApp() {
  fs.writeFileSync(AUDIT_FILE, JSON.stringify([{ id: 'a1', action: 'OS_ACTION', details: 'x', status_code: 0 }]), 'utf8');

  const refuse = (_req, res) => res.status(401).json({
    error: 'OS endpoints disabled: sign in, or configure AEON_MOBILE_SECRET for headless access.',
  });

  const deps = {
    isVercel: false,
    WORKSPACE: TMP,
    ALLOWED_ROOTS: [TMP],
    AUDIT_FILE,
    NOTES_FILE: path.join(TMP, 'notes.json'),
    TERMINAL_HISTORY_FILE: path.join(TMP, 'history.json'),
    writeOSAudit: () => {},
    requireShellAuth: refuse,
    supabase: null,
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createOsRouter(deps));
  app.use('/api', createSystemRouter(deps));
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

/** Drive a route without a session and report the status. */
async function call(app, method, url, body) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

describe('routes that only read, report or sync', () => {
  /**
   * These must not sit behind the execution gate. Each is listed with WHAT it
   * does, because that — not its URL — is what decides its gate.
   */
  const READS = [
    ['GET', '/api/os/actions', undefined, 'lists which actions this install supports; runs none of them'],
    ['GET', '/api/host_os/audit', undefined, 'reads the audit log — same kind as the widget BO-C2 already moved'],
    ['POST', '/api/system/scan', {}, 'pulls Supabase notes/history to disk and pushes blocks up; no shell'],
  ];

  for (const [method, url, body, why] of READS) {
    it(`${method} ${url} answers the operator — ${why}`, async () => {
      const app = makeApp();
      const status = await call(app, method, url, body);
      // 401 here means the route is still behind requireShellAuth, which is
      // the defect: a fresh install has no session and the global guard that
      // would create one is off by default.
      expect(status).not.toBe(401);
      expect(status).not.toBe(404);
    });
  }
});

describe('routes that execute — the gate does NOT move', () => {
  /**
   * The half of this audit that protects §13. If any of these stops
   * refusing, the build order has traded a usability fix for a hole.
   */
  const EXECUTES = [
    ['POST', '/api/os/action', { action: 'getStatus' }, 'execFile — the single execution entry point'],
    ['POST', '/api/os/open', { filePath: TMP }, 'launches a native application'],
    ['POST', '/api/desktop-tasks', { command: 'echo hi' }, 'enqueues a command for execution'],
    ['POST', '/api/system/restart', {}, 'restarts the process'],
    ['POST', '/api/host_os/safe-mode', { enabled: false }, 'disables the refusal that guards execution — turning this off is a step toward running something, so it keeps the execution gate'],
  ];

  for (const [method, url, body, why] of EXECUTES) {
    it(`${method} ${url} still refuses without a shell session — ${why}`, async () => {
      const app = makeApp();
      const status = await call(app, method, url, body);
      expect(status).toBe(401);
    });
  }
});
