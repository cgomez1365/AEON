/**
 * Stopping a block stops its scheduled work, not only its routes.
 *
 * Measured 2026-10-02 (block-builder readiness audit, throwaway block
 * card_watch with a 3 s deps.lifecycle.setInterval job, isolated AEON_HOME):
 *
 *   POST /api/build/blocks/card_watch/stop  → routes answered 503
 *   runs.json: 6 at stop, 10 ten seconds later       — the job kept running
 *   restart with the block still stopped              — the job ran again
 *
 * The run state was enforced in blockHost's HTTP gate only. A block that acts
 * on a timer — the first customer's is a scraper that places bids — kept
 * acting after the operator pressed Stop. This drives the REAL block host with
 * the REAL runState: no stubbed timers, no stubbed state.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stop-jobs-'));
process.env.AEON_DB_DIR = path.join(TMP, 'db');          // before runState resolves it
const runState = require('../src/kernel/runState.cjs');
const { createBlockHost } = require('../src/kernel/blockHost.cjs');
const EXPRESS_PATH = require.resolve('express');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hosts = [];

// One block per host, each with its own id, so the global tick counters and
// the run-state entries cannot leak between tests.
function mountTicker(id, { stoppedAtMount = false } = {}) {
  const root = path.join(TMP, `blocks_${id}`);
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify({
    manifestVersion: '1.1.0', id, label: id, icon: 'Clock', route: `/${id}`,
    description: 'fixture: a block with a scheduled job', category: 'tools', tier: 'experimental', version: '0.0.1',
    api_routes: true, provides: { routes: true, api: true, models: [] },
    contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false },
      storage: { type: 'none', scope: 'block', access: 'scoped' } },
  }));
  fs.writeFileSync(path.join(dir, 'api', `${id}.cjs`), `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (deps) => {
  const t = (globalThis.__aeonTicks ||= {});
  t[${JSON.stringify(id)}] = { interval: 0, event: 0, lifecycle: deps.lifecycle };
  deps.lifecycle.setInterval(() => { t[${JSON.stringify(id)}].interval++; }, 10);
  deps.lifecycle.listen(process, 'aeon-test-${id}', () => { t[${JSON.stringify(id)}].event++; });
  const router = express.Router();
  router.get('/${id}/status', (_q, s) => s.json({ ok: true }));
  return router;
};`);
  if (stoppedAtMount) runState.registerManual(id, { by: 'test' });   // installed = stopped
  const host = createBlockHost({
    blocksDir: root,
    baseDeps: {},
    createScopedDeps: (b) => ({ ...b }),
    registry: [], readiness: {},
    getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
    log: { log() {}, warn() {}, error() {} },
    enforceRouteAuth: false,
  });
  host.rescan('test');
  hosts.push(host);
  return () => globalThis.__aeonTicks[id];
}

afterAll(() => {
  for (const h of hosts) h.dispose();
  delete globalThis.__aeonTicks;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('a stopped block\'s lifecycle timers and listeners do not fire', () => {
  it('stop pauses a running block\'s interval; start resumes it with no remount', async () => {
    const ticks = mountTicker('job_stop');
    await sleep(80);
    expect(ticks().interval).toBeGreaterThan(0);
    expect(ticks().lifecycle.isRunning()).toBe(true);

    runState.setRunning('job_stop', false, { operator: 'test', allowAuto: true });
    expect(ticks().lifecycle.isRunning()).toBe(false);
    await sleep(15);                                   // a tick already queued may land
    const atStop = ticks().interval;
    await sleep(120);
    expect(ticks().interval).toBe(atStop);

    runState.setRunning('job_stop', true, { operator: 'test' });
    await sleep(80);
    expect(ticks().interval).toBeGreaterThan(atStop);
  });

  it('a block that is stopped when it mounts (a reboot) does not run its job', async () => {
    const ticks = mountTicker('job_boot_stopped', { stoppedAtMount: true });
    await sleep(120);
    expect(ticks().interval).toBe(0);
    runState.setRunning('job_boot_stopped', true, { operator: 'test' });
    await sleep(80);
    expect(ticks().interval).toBeGreaterThan(0);
  });

  it('a stopped block\'s event listener does not fire', async () => {
    const ticks = mountTicker('job_listen');
    process.emit('aeon-test-job_listen');
    expect(ticks().event).toBe(1);
    runState.setRunning('job_listen', false, { operator: 'test', allowAuto: true });
    process.emit('aeon-test-job_listen');
    expect(ticks().event).toBe(1);
    runState.setRunning('job_listen', true, { operator: 'test' });
    process.emit('aeon-test-job_listen');
    expect(ticks().event).toBe(2);
  });
});
