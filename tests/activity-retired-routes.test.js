/**
 * Three activity routes retired 2026-09-23 (Bible §21), and they stay retired.
 *
 * Proved dead on a running install (agent C3, isolated home, :3140) and by
 * `git grep` (no caller anywhere in src/, server/, services/, tools/, scripts/):
 *
 *   GET  /api/telemetry/live   answered HTTP 200 carrying the kernel's
 *                              {"error":"UNAUTHORIZED_SESSION"} body — its
 *                              loopback fetch never forwarded the session.
 *   POST /api/activity/search  answered {"documents":[]} for every query: it
 *                              walked <install>/Data/Second_Brain/*, which no
 *                              install has, and its keyword regex was built
 *                              from a template literal where `\b` is a
 *                              backspace, so it could not match anything even
 *                              if the folders existed. It also lazily loaded
 *                              pdf-parse — parser surface for a dead route.
 *   GET  /api/pipeline-metrics answered "$0/mo" x3 always: it read
 *                              src/blocks/activity/clients.json, a file that
 *                              exists in no install.
 *
 * The survivors in analytics.cjs are GET /api/telemetry and GET/POST
 * /api/audit — both called (TelemetryContext.jsx, App.jsx).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockDir = path.join(ROOT, 'src', 'blocks', 'activity');
const manifest = JSON.parse(fs.readFileSync(path.join(blockDir, 'block.manifest.json'), 'utf8'));
const analytics = fs.readFileSync(path.join(blockDir, 'api', 'analytics.cjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RETIRED = [
  ['GET', '/api/telemetry/live', /router\.get\(\s*'\/telemetry\/live'/],
  ['POST', '/api/activity/search', /router\.post\(\s*'\/activity\/search'/],
  ['GET', '/api/pipeline-metrics', /router\.get\(\s*'\/pipeline-metrics'/],
];

describe('retired activity routes stay retired', () => {
  for (const [method, p, re] of RETIRED) {
    it(`${method} ${p} is neither registered nor declared`, () => {
      expect(analytics).not.toMatch(re);
      expect(manifest.routes.some(r => r.path === p)).toBe(false);
    });
  }

  it('the called survivors are still served', () => {
    expect(analytics).toMatch(/router\.get\(\s*'\/telemetry'/);
    expect(analytics).toMatch(/router\.get\(\s*'\/audit'/);
    expect(analytics).toMatch(/router\.post\(\s*'\/audit'/);
  });

  it('activity no longer loads a PDF parser', () => {
    expect(analytics).not.toMatch(/pdf-parse/);
  });
});
