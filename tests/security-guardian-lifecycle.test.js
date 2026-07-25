import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const { createEarlyware } = require('../server/earlyware.cjs');
const mountGuardian = require('../src/blocks/security/api/guardian.cjs');

// Mirrors the block host: a FRESH lifecycle per mount, a SHARED earlyware
// registry across "rescans". BO4 requires that repeated Security rescans leave
// exactly one Guardian in the chain and exactly one live watchdog timer.
function makeLifecycle() {
  const timers = new Set();
  const cleanups = [];
  return {
    timers,
    handle: {
      onCleanup: (fn) => cleanups.push(fn),
      setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); if (t.unref) t.unref(); timers.add(t); return t; },
      clearInterval: (t) => { clearInterval(t); timers.delete(t); },
      setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); timers.add(t); return t; },
      listen: (emitter, evt, fn) => { emitter.on(evt, fn); },
    },
    teardown() {
      for (const fn of cleanups) { try { fn(); } catch {} }
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      timers.clear();
    },
  };
}

describe('Guardian rescan lifecycle (BO4)', () => {
  const earlyware = createEarlyware();
  const registerEarlyMiddleware = (fn, id) => earlyware.register(fn, id);
  const lifecycles = [];

  function mountOnce() {
    const lc = makeLifecycle();
    lifecycles.push(lc);
    mountGuardian(express.Router(), {
      lifecycle: lc.handle,
      registerEarlyMiddleware,
      writeOSAudit: () => {},
    });
    return lc;
  }

  afterEach(() => { for (const lc of lifecycles) lc.teardown(); });

  it('registers the watchdog through the lifecycle, not as a raw interval', () => {
    const lc = mountOnce();
    expect(lc.timers.size).toBe(1); // the watchdog is lifecycle-tracked
  });

  it('leaves exactly one Guardian and one watchdog after ten rescans', () => {
    for (let i = 0; i < 10; i++) {
      // A rescan tears down the previous block, then remounts.
      if (lifecycles.length) lifecycles[lifecycles.length - 1].teardown();
      mountOnce();
    }
    // One Guardian in the shared earlyware chain — not ten.
    expect(earlyware.list().filter((id) => id === 'security-guardian').length).toBe(1);
    // Every torn-down lifecycle released its watchdog; only the current holds one.
    const current = lifecycles[lifecycles.length - 1];
    expect(current.timers.size).toBe(1);
    for (let i = 0; i < lifecycles.length - 1; i++) {
      expect(lifecycles[i].timers.size).toBe(0);
    }
  });
});
