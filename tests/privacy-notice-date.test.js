/**
 * PRIVACY.md carries a "Last changed" date that people rely on. 3.3.0 changed
 * the notice (agent tools, a new data flow on by default) and left the date at
 * 2026-09-30 (review round 4). This pins the notice's text to its date: when
 * the text changes, this fails until the date is moved to the day of the
 * change and both are pinned here again.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATE_RE = /^\*Last changed (\d{4}-\d\d-\d\d) ·.*\*$/m;

// The date and the text it dates. Change both together.
const PINNED = {
  date: '2026-10-04',
  bodySha256: '339b5fa86753a3e9b50fd409b3e696ba6974f25b6f16ddfdd46384a0dc4148f4',
};

describe('PRIVACY.md — its "Last changed" date moves with its text', () => {
  const text = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');

  it('has a "Last changed" date, and it is the pinned one', () => {
    expect(DATE_RE.exec(text)?.[1]).toBe(PINNED.date);
  });

  it('the text is the one that date was set for (changed it? move the date and pin both here)', () => {
    const body = text.replace(DATE_RE, '');
    expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(PINNED.bodySha256);
  });
});
