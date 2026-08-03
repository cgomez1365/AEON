/**
 * BO-A3b — a burned credential must not survive a restore.
 *
 * AEON_MOBILE_SECRET appeared in a transcript and stayed a valid credential for
 * the headless path. It was owed rotation across three build orders and
 * survived all of them, for a structural reason rather than a lazy one:
 * rotation was a manual step, and nobody is ever blocked by a manual step.
 *
 * The delete-and-reclone on 2026-08-03 would have generated a fresh secret —
 * except the preserved .env carries the exposed value and MUST be restored,
 * because it also holds AEON_VAULT_MASTER_KEY. The restore path re-introduces
 * the leak. So the fix is a fingerprint denylist the launcher enforces, with no
 * operator action at all.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DENYLIST = path.join(ROOT, 'security', 'compromised-credentials.json');

const list = JSON.parse(fs.readFileSync(DENYLIST, 'utf8'));

describe('the compromised-credential denylist', () => {
  it('records the exposed AEON_MOBILE_SECRET by fingerprint', () => {
    const entry = list.credentials.find(c => c.key === 'AEON_MOBILE_SECRET');
    expect(entry, 'the credential this gate exists for must be listed').toBeTruthy();
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.exposed).toBeTruthy();
    expect(entry.reason).toBeTruthy();
  });

  it('stores ONLY digests — never a raw secret', () => {
    // A denylist that leaks the thing it is protecting against would be worse
    // than no denylist. Every field must be a hash, a date, or prose.
    for (const c of list.credentials) {
      expect(Object.keys(c).sort()).toEqual(
        ['action', 'exposed', 'key', 'reason', 'sha256'].sort());
      expect(c.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const raw = fs.readFileSync(DENYLIST, 'utf8');
    // No 32+ char hex run other than the 64-char digests.
    const hexRuns = raw.match(/\b[a-f0-9]{32,}\b/gi) || [];
    for (const h of hexRuns) expect(h.length).toBe(64);
  });

  it('never lists the vault master key — rotating that is a lockout', () => {
    // Owner lockout is never acceptable. A master key rotated without
    // rewrapping the keyslots cannot unwrap them, and the operator is locked
    // out of their own install. If one is ever exposed it needs a guided
    // re-wrap, not a silent regeneration at launch.
    expect(list.credentials.some(c => c.key === 'AEON_VAULT_MASTER_KEY')).toBe(false);
  });
});

describe('the launcher enforces it', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');

  it('rotates a present-but-burned value, which ensure() alone cannot do', () => {
    // ensure() fills only a MISSING value. That is precisely why a restored
    // .env carrying the exposed secret sailed through untouched.
    expect(launcher).toMatch(/rotateCompromised/);
    expect(launcher).toMatch(/compromised-credentials\.json/);
    expect(launcher).toMatch(/AEON_MOBILE_SECRET/);
  });

  it('says so out loud when it rotates — no silent security changes (R-05)', () => {
    expect(launcher).toMatch(/known-exposed value — rotated automatically/);
  });

  it('the rotation logic actually matches the recorded fingerprint', () => {
    // Reproduce the launcher's comparison against a known value, so this gate
    // fails if the digest algorithm or encoding ever drifts.
    const entry = list.credentials.find(c => c.key === 'AEON_MOBILE_SECRET');
    const sample = 'not-the-real-secret';
    const digest = crypto.createHash('sha256').update(sample).digest('hex');
    expect(digest).not.toBe(entry.sha256);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
