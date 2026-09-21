/**
 * Boot revoke is a PROCESS-boot defence, not a block-mount one.
 *
 * 2026-09-20 (BO-FLEET stranger installs, two independent runs): installing a
 * store pack triggers a kernel rescan, the rescan re-mounts the Security block,
 * and the Guardian's boot-revoke ran again — clearing every session, including
 * the operator's, mid-install. The operator had to log in again before they
 * could press Start, with no message saying why.
 *
 * The intent (guardian.cjs header): "sessions from a previous boot are dead".
 * A previous BOOT — not a previous mount. Sessions created after this process
 * started are already protected by the stateless bootTime comparison, so the
 * eager wipe only needs to happen once per process.
 *
 * Drives the REAL guardian and the REAL session store in an isolated vault.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-guardian-once-'));
process.env.VAULT_PATH = path.join(TMP, 'Vault');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
process.env.AEON_DB_DIR = path.join(TMP, 'db');

const express = require('express');
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const { createEarlyware } = require('../server/earlyware.cjs');
const mountGuardian = require('../src/blocks/security/api/guardian.cjs');

function mount() {
  const timers = new Set();
  const earlyware = createEarlyware();
  mountGuardian(express.Router(), {
    lifecycle: {
      onCleanup() {},
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); timers.add(t); return t; },
      clearInterval: (t) => { clearInterval(t); timers.delete(t); },
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.add(t); return t; },
      listen() {},
    },
    registerEarlyMiddleware: (fn, id) => earlyware.register(fn, id),
    writeOSAudit: () => {},
  });
  return () => { for (const t of timers) { clearInterval(t); clearTimeout(t); } };
}

const sessionCount = () => Object.keys(sessions.loadUser()?.sessions || {}).length;
const putSession = (token) => {
  const u = sessions.loadUser();
  u.sessions[token] = { created: Date.now(), lastSeen: Date.now(), expires: Date.now() + 3.6e6 };
  sessions.saveUser(u);
};

describe('Guardian boot-revoke runs once per process', () => {
  const stops = [];
  beforeAll(() => {
    sessions.saveUser({ username: 'scratch', salt: 's', passHash: 'h', role: 'operator', sessions: { stale: { created: 1, lastSeen: 1, expires: Date.now() + 3.6e6 } } });
    sessions.savePolicy({ lockEveryLaunch: true, guardEnabled: true });
  });
  afterAll(() => { for (const s of stops) s(); fs.rmSync(TMP, { recursive: true, force: true }); });

  it('clears a previous boot\'s sessions when the Guardian first mounts (the defence stays)', () => {
    expect(sessionCount()).toBe(1);
    stops.push(mount());
    expect(sessionCount()).toBe(0);
  });

  it('does NOT clear the operator\'s session when the block is re-mounted by a rescan', () => {
    putSession('operator-session-after-boot');
    expect(sessionCount()).toBe(1);
    stops.push(mount());               // what an install's rescan does
    stops.push(mount());               // and a second install
    expect(sessionCount()).toBe(1);    // was 0: install logged the operator out
  });
});
