/**
 * Run-state writes must not lose concurrent registrations.
 *
 * Audit 2026-08-11 P1-10: 60 isolated processes calling registerManual()
 * against one DB root retained 48. Three defects stacked:
 *
 *   1. read-modify-write with no lock — last write wins;
 *   2. save() wrote directly onto the live file with no temp+rename, so a crash
 *      mid-write left truncated JSON, and load()'s catch turned that into {} —
 *      every manual block silently reverting to mode:'auto', which means
 *      always-running. A stopped block answering requests is the bad direction;
 *   3. a 2s read cache. A write that starts from a cached copy re-publishes
 *      state up to two seconds stale, reverting whatever another process wrote
 *      in between. A lock around a cached read protects nothing.
 *
 * Cross-process measurement (harness in the build report), 60 writers:
 *   pre-fix   the state file did not survive the run at all
 *   post-fix  60/60, zero missing, no stray temp or lock files
 *
 * Those functions are synchronous, so an in-process test cannot interleave them
 * — the cross-process harness is the real proof and it lives in the report.
 * What IS assertable here are the properties that make the harness pass: the
 * critical section reads fresh, the write is atomic, and nothing is left behind.
 */
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dir;
let rs;
let stateFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-rs-'));
  process.env.AEON_DB_DIR = dir;
  stateFile = path.join(dir, 'aeon-block-runstate.json');
  // Module-scope path resolution: clear the require cache so AEON_DB_DIR takes.
  delete require.cache[require.resolve('../src/kernel/runState.cjs')];
  rs = require('../src/kernel/runState.cjs');
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('run-state durability', () => {
  it('registers and persists a manual block', () => {
    rs.registerManual('blk_a');
    expect(rs.getState('blk_a').mode).toBe('manual');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).blk_a).toBeTruthy();
  });

  it('is idempotent — a second register does not clobber operator state', () => {
    rs.registerManual('blk_a');
    rs.setRunning('blk_a', true);
    rs.registerManual('blk_a');
    expect(rs.getState('blk_a').running, 'a re-register reset a running block').toBe(true);
  });

  it('leaves no temp or lock file behind', () => {
    rs.registerManual('blk_a');
    rs.setRunning('blk_a', true);
    const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(stray, `stray: ${stray.join(', ')}`).toEqual([]);
  });

  // Defect 3, directly. A writer must observe another writer's committed state
  // even inside the 2s cache window.
  it('starts a write from disk, not from the cache', () => {
    rs.registerManual('blk_a');
    rs.getState('blk_a'); // warm the cache

    // Another process commits blk_b while our cache is still warm.
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    onDisk.blk_b = { mode: 'manual', running: true, registeredBy: 'other-process' };
    fs.writeFileSync(stateFile, JSON.stringify(onDisk, null, 2));

    // Our write must preserve it rather than publish a stale snapshot.
    rs.registerManual('blk_c');

    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(after.blk_b, "another process's registration was reverted").toBeTruthy();
    expect(after.blk_c).toBeTruthy();
    expect(after.blk_a).toBeTruthy();
  });

  it('setRunning refuses a block that is not manual', () => {
    expect(rs.setRunning('never_registered', true).ok).toBe(false);
  });

  // The pre-fix write was a direct writeFileSync onto the live file, so a crash
  // mid-write left truncated JSON that load() caught and turned into {} — every
  // manual block reverting to auto, meaning always-running. The fix is that
  // rename is atomic, so a reader sees the whole old file or the whole new one
  // and truncation is never observable. Assert the reachable property: the file
  // parses after every write.
  it('leaves the state file parseable after every write', () => {
    rs.registerManual('blk_a');
    rs.setRunning('blk_a', true);
    rs.registerManual('blk_b');
    rs.setRunning('blk_a', false);

    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(() => JSON.parse(raw), 'state file is not valid JSON').not.toThrow();

    const parsed = JSON.parse(raw);
    expect(parsed.blk_a.mode).toBe('manual');
    expect(parsed.blk_a.running).toBe(false);
    expect(parsed.blk_b.mode).toBe('manual');
  });
});
