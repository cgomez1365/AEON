import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createEarlyware } = require('../server/earlyware.cjs');

describe('earlyware registry (BO4)', () => {
  it('replaces a middleware registered under the same id instead of stacking', () => {
    const ew = createEarlyware();
    ew.register(() => {}, 'security-guardian');
    for (let i = 0; i < 10; i++) ew.register(() => {}, 'security-guardian');
    expect(ew.count).toBe(1);
    expect(ew.list()).toEqual(['security-guardian']);
  });

  it('keeps distinct ids separate and always appends anonymous registrations', () => {
    const ew = createEarlyware();
    ew.register(() => {}, 'security-guardian');
    ew.register(() => {}, 'shield');
    ew.register(() => {}); // anonymous
    ew.register(() => {}); // anonymous — must NOT collapse into one
    expect(ew.count).toBe(4);
    expect(ew.list()).toEqual(['security-guardian', 'shield', 'anonymous', 'anonymous']);
  });

  it('runs registered middleware in order and can remove by id', () => {
    const ew = createEarlyware();
    const order = [];
    ew.register((req, res, next) => { order.push('a'); next(); }, 'a');
    ew.register((req, res, next) => { order.push('b'); next(); }, 'b');
    let reachedEnd = false;
    ew.middleware({}, {}, () => { reachedEnd = true; });
    expect(order).toEqual(['a', 'b']);
    expect(reachedEnd).toBe(true);

    expect(ew.remove('a')).toBe(true);
    expect(ew.count).toBe(1);
    expect(ew.remove('missing')).toBe(false);
  });

  it('surfaces a thrown middleware error to next(err) instead of swallowing it', () => {
    const ew = createEarlyware();
    ew.register(() => { throw new Error('boom'); }, 'x');
    let captured = null;
    ew.middleware({}, {}, (e) => { captured = e; });
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe('boom');
  });

  it('ignores non-function registrations', () => {
    const ew = createEarlyware();
    ew.register(null, 'nope');
    ew.register(undefined);
    expect(ew.count).toBe(0);
  });
});
