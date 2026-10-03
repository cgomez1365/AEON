/**
 * The dependency audit gate does not go red on the day after launch (A005,
 * A023, A034).
 *
 * Both acceptances in tools/scan/audit-gate.cjs were dated 2026-10-01, and a
 * new high advisory in @grpc/grpc-js (1240623) was published on 2026-09-30, so
 * the CI security leg failed that day and would have kept failing. The gate
 * also audited --omit=dev while launch.js installs devDependencies and runs the
 * build toolchain on every customer machine.
 *
 * The verdict logic is checked on a fixed report, never the network: requiring
 * the gate must not run npm audit.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'tools', 'scan', 'audit-gate.cjs');
const src = fs.readFileSync(GATE, 'utf8');

// Checked BEFORE the require: a gate without this guard runs npm audit (and
// process.exit) the moment a test loads it.
const guarded = /if \(require\.main === module\) main\(\);/.test(src);
const gate = guarded ? require(GATE) : null;

// The advisories open at fe93dbf, as `npm audit --json` reports them.
const via = (source, severity, title) => ({ source, severity, title, url: '', range: '' });
const REPORT_AT_LAUNCH = {
  vulnerabilities: {
    vite: { name: 'vite', severity: 'high', via: [via(1116229, 'moderate', 'optimized deps .map'), via(1120784, 'moderate', 'launch-editor'), via(1123525, 'high', 'server.fs.deny bypass'), 'esbuild'] },
    esbuild: { name: 'esbuild', severity: 'moderate', via: [via(1102341, 'moderate', 'dev server requests')] },
    '@grpc/grpc-js': { name: '@grpc/grpc-js', severity: 'high', via: [via(1240623, 'high', 'getAuthContext'), via(1240625, 'low', 'error messages')] },
    '@firebase/firestore': { name: '@firebase/firestore', severity: 'high', via: ['@grpc/grpc-js'] },
    firebase: { name: 'firebase', severity: 'high', via: ['@firebase/firestore', '@firebase/firestore-compat'] },
  },
};
// The same report after vite moved to 6.4.3 (2026-10-03): the vite and
// esbuild advisories are gone, grpc-js through firebase is still there.
const REPORT_AFTER_VITE6 = {
  vulnerabilities: Object.fromEntries(Object.entries(REPORT_AT_LAUNCH.vulnerabilities)
    .filter(([name]) => name !== 'vite' && name !== 'esbuild')),
};
const dayAfter = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

describe('audit gate', () => {
  it('can be required without running npm audit', () => {
    expect(guarded).toBe(true);
    expect(typeof gate.evaluate).toBe('function');
  });

  it('passes on 2026-10-03 with the advisories open after the vite 6.4.3 upgrade', () => {
    const r = gate.evaluate(REPORT_AFTER_VITE6, '2026-10-03');
    expect(r.blocking).toEqual([]);
    expect(r.expired).toEqual([]);
    expect(r.unused).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.accepted.map(a => a.id).sort()).toEqual([1240623]);
  });

  it('no longer accepts the vite advisory 6.4.3 fixed: it blocks if it comes back', () => {
    expect(Object.keys(gate.ACCEPTED)).not.toContain('1123525');
    const r = gate.evaluate(REPORT_AT_LAUNCH, '2026-10-03');
    expect(r.blocking.map(b => b.id)).toEqual([1123525]);
    expect(r.ok).toBe(false);
  });

  it('still fails the day after an acceptance\'s review date', () => {
    for (const [id, a] of Object.entries(gate.ACCEPTED)) {
      const r = gate.evaluate(REPORT_AFTER_VITE6, dayAfter(a.review));
      expect(r.expired.map(e => String(e.id)), id).toContain(id);
      expect(r.ok, id).toBe(false);
    }
  });

  it('fails on a high advisory nobody reviewed', () => {
    const report = { vulnerabilities: { left: { via: [via(9999999, 'high', 'new')] } } };
    const r = gate.evaluate(report, '2026-10-02');
    expect(r.blocking.map(b => b.id)).toEqual([9999999]);
    expect(r.ok).toBe(false);
  });

  it('names an acceptance whose advisory is gone, instead of keeping it silently', () => {
    const r = gate.evaluate({ vulnerabilities: {} }, '2026-10-02');
    expect(r.ok).toBe(true);
    expect(r.unused.sort()).toEqual(Object.keys(gate.ACCEPTED).sort());
  });

  it('audits what launch.js installs on a customer machine, devDependencies included', () => {
    expect(gate.AUDIT_COMMAND).toMatch(/^npm audit --json/);
    expect(gate.AUDIT_COMMAND).not.toMatch(/--omit|--production|--only/);
  });

  it('every acceptance has a reason, a real date, and a line in docs/DEPENDENCY_DECISIONS.md', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'DEPENDENCY_DECISIONS.md'), 'utf8');
    for (const [id, a] of Object.entries(gate.ACCEPTED)) {
      expect(a.reason.length, id).toBeGreaterThan(80);
      expect(a.review, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(a.review)), id).toBe(false);
      const line = doc.split('\n').find(l => l.startsWith(`| ${id} `));
      expect(line, `${id} missing from the decisions table`).toBeTruthy();
      expect(line, id).toContain(`accepted to ${a.review}`);
    }
  });
});
