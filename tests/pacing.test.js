/**
 * src/kernel/pacing.cjs — what the operator's requests-per-minute limit does.
 *
 * The bucket is real. Only the clock is faked (Date + setTimeout), so a limit
 * of 3 a minute is proved without waiting a minute. Numbers are arbitrary and
 * belong to no provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pacing = require('../src/kernel/pacing.cjs');

beforeEach(() => {
  pacing._reset();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

const KEY = 'https://example.test#k1';

describe('pace()', () => {
  it('lets calls through up to the limit, then delays the next one until a slot frees', async () => {
    const done = [];
    for (let i = 0; i < 3; i++) await pacing.pace(KEY, 3);
    const fourth = pacing.pace(KEY, 3).then(() => done.push('fourth'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(done, 'the fourth call ran inside the minute').toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);
    await fourth;
    expect(done).toEqual(['fourth']);
  });

  it('says so once, on the first wait, with how long and which limit', async () => {
    const waits = [];
    for (let i = 0; i < 2; i++) await pacing.pace(KEY, 2);
    const p = pacing.pace(KEY, 2, { onWait: (w) => waits.push(w) });
    await vi.advanceTimersByTimeAsync(61_000);
    await p;
    expect(waits).toHaveLength(1);
    expect(waits[0].rpm).toBe(2);
    expect(waits[0].waitMs).toBeGreaterThan(50_000);
    expect(waits[0].waitMs).toBeLessThanOrEqual(60_000);
  });

  it('does not announce anything when it did not have to wait', async () => {
    const waits = [];
    await pacing.pace(KEY, 5, { onWait: (w) => waits.push(w) });
    expect(waits).toEqual([]);
  });

  it.each([[0], [null], [undefined]])('a limit of %s never waits', async (rpm) => {
    const waits = [];
    for (let i = 0; i < 50; i++) await pacing.pace(KEY, rpm, { onWait: (w) => waits.push(w) });
    expect(waits).toEqual([]);
  });

  it('a lowered limit applies to the bucket that already exists', async () => {
    for (let i = 0; i < 3; i++) await pacing.pace(KEY, 10);
    const waits = [];
    const p = pacing.pace(KEY, 3, { onWait: (w) => waits.push(w) }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    await p;
    expect(waits).toHaveLength(1);
  });

  it('gives up past the cap with a flagged error that carries the limit and the wait', async () => {
    for (let i = 0; i < 2; i++) await pacing.pace(KEY, 2);
    const err = await pacing.pace(KEY, 2, { maxWaitMs: 5_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.localThrottle).toBe(true);
    expect(err.rpm).toBe(2);
    expect(err.waitMs).toBeGreaterThan(50_000);
    expect(err.message).toMatch(/Settings → Keys/);
  });

  it('stops waiting the moment the caller cancels', async () => {
    for (let i = 0; i < 2; i++) await pacing.pace(KEY, 2);
    const ac = new AbortController();
    const p = pacing.pace(KEY, 2, { signal: ac.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort(new Error('stopped by the operator'));
    await vi.advanceTimersByTimeAsync(10);
    const err = await p;
    expect(err.message).toBe('stopped by the operator');
    expect(err.localThrottle).toBeUndefined();
  });

  it('an already-cancelled caller never takes a slot', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stopped'));
    await pacing.pace(KEY, 1, { signal: ac.signal }).catch(() => {});
    // The one slot is still free.
    const waits = [];
    await pacing.pace(KEY, 1, { onWait: (w) => waits.push(w) });
    expect(waits).toEqual([]);
  });
});
