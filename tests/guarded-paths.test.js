/**
 * /blocks/* must sit behind the operator gate like every other kernel route.
 *
 * 2026-09-21 (found by the runtime-UI spike): isGuardedPath was
 * /^\/(api|block|core|events|ws)\b/. `\b` needs a word/non-word boundary and
 * "block" followed by "s" has none, so /blocks/registry answered 200 with no
 * token while /api/* answered 401. Anyone who could reach the port could read
 * every installed block's manifest — names, routes, permissions, required
 * secrets. Guard-on installs and, worse, the exposed-bind first-run lockdown
 * (which uses the same predicate) both missed it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isGuardedPath } = require('../src/kernel/server-utils/sessionValidator.cjs');

describe('isGuardedPath', () => {
  it.each([
    '/api/tasks', '/api/store/install', '/core/state', '/events', '/ws',
    '/block/reports/x', '/blocks/registry', '/blocks',
  ])('guards %s', (p) => {
    expect(isGuardedPath(p)).toBe(true);
  });

  it.each([
    '/', '/public/x.png', '/assets/index.js', '/brand/mark.svg', '/blocksmith', '/apiary', '/wsx',
  ])('does not guard %s', (p) => {
    expect(isGuardedPath(p)).toBe(false);
  });
});
