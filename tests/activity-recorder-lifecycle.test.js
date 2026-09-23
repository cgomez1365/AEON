/**
 * Activity's API goes when the block goes; its recorder follows it in and out.
 *
 * Measured 2026-09-23 on a throwaway install: after
 * `POST /api/build/blocks/activity/uninstall`, /api/audit answered 404 but
 * /api/token-analytics/heatmap and /summary still answered 200 — server.js
 * mounted a second instance of the block's router at boot and kept it. The
 * Dashboard's "The Activity block is not installed" panels key on that 404.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createActivityRecorder } = require('../src/kernel/activityRecorder.cjs');
const { liveBlockModule } = require('../src/kernel/liveBlockModule.cjs');

const tmp = [];
const mkdtemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

describe('the kernel no longer holds its own copy of the activity routes', () => {
  it('server.js does not require or mount the block\'s router', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    expect(src).not.toMatch(/require\('\.\.\/src\/blocks\/activity\/api\/token-analytics\.cjs'\)/);
    expect(src).toMatch(/createActivityRecorder/);
  });

  it('the Matrix index scheduler is wired whether or not the Matrix is there at boot', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    expect(src).not.toMatch(/require\('\.\.\/src\/blocks\/aeon_matrix\/api\/ingest\.cjs'\)/);
    const sched = src.indexOf('vaultSync.setIndexScheduler(');
    const firstTry = src.indexOf('try {', src.indexOf('const _matrixIngest'));
    expect(sched).toBeGreaterThan(-1);
    expect(sched).toBeLessThan(firstTry);
  });
});

describe('a kernel hook into a block follows the block', () => {
  it('absent at boot, present after a restore, one instance across remove/restore', () => {
    const blocksDir = mkdtemp('aeon-live-');
    const made = [];
    const get = liveBlockModule({ blocksDir, file: 'aeon_matrix/api/ingest.cjs', deps: { made } });
    expect(get()).toBeNull();
    fs.mkdirSync(path.join(blocksDir, 'aeon_matrix', 'api'), { recursive: true });
    fs.writeFileSync(path.join(blocksDir, 'aeon_matrix', 'api', 'ingest.cjs'),
      `module.exports = (deps) => { deps.made.push(1); return { runSecondBrainScan: async () => 'scanned' }; };\n`);
    expect(typeof get().runSecondBrainScan).toBe('function');
    fs.renameSync(path.join(blocksDir, 'aeon_matrix'), path.join(blocksDir, 'parked'));
    expect(get()).toBeNull();
    fs.renameSync(path.join(blocksDir, 'parked'), path.join(blocksDir, 'aeon_matrix'));
    expect(get()).not.toBeNull();
    expect(made).toHaveLength(1);
  });
});

describe('the recorder follows the block', () => {
  it('records while the block is there, stops when it is removed, resumes when restored', () => {
    const blocksDir = mkdtemp('aeon-rec-blocks-');
    const api = path.join(blocksDir, 'activity', 'api');
    fs.mkdirSync(api, { recursive: true });
    const log = path.join(blocksDir, 'calls.log');
    fs.writeFileSync(path.join(api, 'token-analytics.cjs'),
      `module.exports = (deps) => ({ _recordActivity: (t) => require('fs').appendFileSync(deps.LOG, t + '\\n') });\n`);
    const record = createActivityRecorder({ blocksDir, deps: { LOG: log } });

    expect(record(10)).toBe(true);
    const parked = path.join(blocksDir, 'parked');
    fs.renameSync(path.join(blocksDir, 'activity'), parked);
    expect(record(20)).toBe(false);
    fs.renameSync(parked, path.join(blocksDir, 'activity'));
    expect(record(30)).toBe(true);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['10', '30']);
  });

  it('the real activity block records into the data root it is given', () => {
    const data = mkdtemp('aeon-rec-data-');
    const record = createActivityRecorder({
      blocksDir: path.join(ROOT, 'src', 'blocks'),
      deps: {
        getDataFile: (rel) => path.join(data, rel),
        getLocalFile: (rel) => path.join(data, rel),
        TOKEN_LEDGER_FILE: path.join(data, 'db', 'token_ledger.json'),
        AUDIT_FILE: path.join(data, 'db', 'audit.jsonl'),
        LOG_FILE: path.join(data, 'db', 'log.txt'),
      },
    });
    fs.mkdirSync(path.join(data, 'activity'), { recursive: true });
    expect(record(42, 'stub-model', 'custom', { success: true })).toBe(true);
    const days = JSON.parse(fs.readFileSync(path.join(data, 'activity', 'activity_heatmap.json'), 'utf8'));
    const today = Object.values(days)[0];
    expect(today.requests).toBe(1);
    expect(today.tokens).toBe(42);
  });
});
