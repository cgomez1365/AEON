/**
 * The task cron runs a task at the interval its schedule says.
 *
 * services/system.js read schedules with substring checks in a fixed order,
 * and three of the schedules it lists ran at the wrong rate (found
 * 2026-10-02, block-builder readiness audit):
 *
 *   "every 15 min"  contains "5 min"  → ran every 5 minutes
 *   "every 6 hours" contains "hour"   → ran every hour
 *   "every monday"  contains "day"    → ran every day
 *
 * A schedule that fires three or six times as often as written is a cost
 * and rate-limit problem for anything it drives.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import os from 'os';

const require = createRequire(import.meta.url);
const { parseCronish } = require('../services/system.js')({
  ROOT: os.tmpdir(), getLocalFile: () => '', logTrivial: () => {}, WORKSPACE: '', writeOSAudit: () => {}, kernelLLM: null,
});
const MIN = 60000;

describe('parseCronish', () => {
  it.each([
    ['every 15 min', 15 * MIN],
    ['every 15m', 15 * MIN],
    ['every 6 hours', 360 * MIN],
    ['every 6h', 360 * MIN],
    ['every monday', 7 * 24 * 60 * MIN],
  ])('%s — the schedules that used to run at the wrong rate', (s, ms) => {
    expect(parseCronish(s)).toBe(ms);
  });

  it.each([
    ['every 5 min', 5 * MIN],
    ['every 30 min', 30 * MIN],
    ['every hour', 60 * MIN],
    ['daily', 24 * 60 * MIN],
    ['every day', 24 * 60 * MIN],
    ['every week', 7 * 24 * 60 * MIN],
  ])('%s — the schedules that were already right stay right', (s, ms) => {
    expect(parseCronish(s)).toBe(ms);
  });

  it('an unreadable or zero schedule is null, never a guess', () => {
    expect(parseCronish('sometimes')).toBeNull();
    expect(parseCronish('every 0 min')).toBeNull();
    expect(parseCronish('')).toBeNull();
  });
});
