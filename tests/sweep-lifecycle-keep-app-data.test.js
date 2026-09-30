/**
 * --keep-app skips the app refusals (the app is not touched) but must still
 * refuse --replace-data when run from the drive's own checkout: the builder's
 * source home IS the drive's AEON-Data, so it would be moved aside and copied
 * back onto itself (final review of the sweep follow-ups, 2026-09-29).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { keepAppRefusal } = require('../scripts/build-usb-carry.cjs');

describe('keepAppRefusal', () => {
  it('refuses replacing the data from inside the app that uses it', () => {
    expect(keepAppRefusal({ app: '/Volumes/AEON/AEON/AEON', self: true, dataAction: 'replace' })).toMatch(/copy it back onto itself/);
  });
  it('allows a launcher/runtime refresh from the drive itself (data kept)', () => {
    expect(keepAppRefusal({ app: '/Volumes/AEON/AEON/AEON', self: true, checkout: true, dataAction: 'keep' })).toBeNull();
  });
  it('allows replacing the data from another AEON', () => {
    expect(keepAppRefusal({ app: '/Volumes/AEON/AEON/AEON', self: false, checkout: true, dataAction: 'replace' })).toBeNull();
  });
});
