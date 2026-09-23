/**
 * Resume Grader — its routes need a session once an operator account exists.
 *
 * Measured by agent C3 (2026-09-23) and relayed by the master: the kernel's
 * manifest auth (src/kernel/manifestRouteAuth.cjs) matches a request's method
 * against each declared route's method, and never matches `ALL`. The route
 * generator (scripts/gen-block-routes.cjs) emits `ALL` for a computed
 * registration, and grade-resume.js registered its route as
 *   ['get', 'post', 'options'].forEach(m => app[m]('/api/resume-grader/grade', h))
 * so the manifest said `ALL /api/resume-grader/grade` and the grade — a paid
 * model call with a résumé in it — answered without a session. The kernel side
 * belongs to another agent; the block now registers the verbs it serves by
 * name, so the manifest declares them and the guard can match them.
 *
 * This drives the REAL guard factory with a stub session store (an account
 * exists, no request carries a valid session) in front of the REAL plugins.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK = path.join(ROOT, 'src', 'blocks', 'resume_grader');
const manifest = () => { delete require_.cache[require_.resolve(path.join(BLOCK, 'block.manifest.json'))]; return require_(path.join(BLOCK, 'block.manifest.json')); };

let server;
afterEach(async () => { if (server) await new Promise((r) => server.close(r)); server = null; });

async function mount({ validSession }) {
  const { manifestAuthGuard } = require_(path.join(ROOT, 'src', 'kernel', 'manifestRouteAuth.cjs'));
  const sessions = {
    hasAccount: () => true,
    isPreAuthRequest: (req) => req.method === 'OPTIONS',
    validateSession: () => (validSession ? { ok: true, user: 'op' } : { ok: false, reason: 'no-session' }),
  };
  const kernelLLM = async () => JSON.stringify({ score: 70, subscores: { skills: 28, experience: 21, seniority: 11, requirements: 10 } });
  const app = express();
  app.use(express.json());
  app.use(manifestAuthGuard(manifest(), sessions));
  for (const f of ['grade-resume.js', 'extract-resume.js']) {
    const mod = path.join(BLOCK, 'api', f);
    delete require_.cache[require_.resolve(mod)];
    require_(mod)(app, { kernelLLM });
  }
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  return (method, url, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

describe('resume_grader routes are declared by verb', () => {
  it('the manifest declares no ALL route — the guard cannot match one', () => {
    const routes = manifest().routes;
    expect(routes.filter((r) => r.method === 'ALL')).toEqual([]);
    expect(routes).toContainEqual({ method: 'POST', path: '/api/resume-grader/grade', auth: true });
  });

  it('without a session, grading is refused once an account exists', async () => {
    const call = await mount({ validSession: false });
    const r = await call('POST', '/api/resume-grader/grade', { resume: 'Jane Doe, engineer.' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('UNAUTHORIZED_SESSION');
  });

  it('without a session, the upload is refused too', async () => {
    const call = await mount({ validSession: false });
    const r = await call('POST', '/api/resume-grader/extract', { filename: 'cv.txt', data: Buffer.from('Jane Doe').toString('base64') });
    expect(r.status).toBe(401);
  });

  it('with a session, grading works', async () => {
    const call = await mount({ validSession: true });
    const r = await call('POST', '/api/resume-grader/grade', { resume: 'Jane Doe, engineer.' });
    expect(r.status).toBe(200);
    expect(r.body.result.score).toBe(70);
  });

  it('a GET still says which verb to use, and still needs a session', async () => {
    const open = await mount({ validSession: true });
    expect((await open('GET', '/api/resume-grader/grade')).status).toBe(405);
    await new Promise((r) => server.close(r)); server = null;
    const closed = await mount({ validSession: false });
    expect((await closed('GET', '/api/resume-grader/grade')).status).toBe(401);
  });
});

describe('declared dependencies survive normalisation', () => {
  it('writer\'s requires.blocks is not hidden by an empty dependencies list', () => {
    const std = require_(path.join(ROOT, 'src', 'kernel', 'blockStandard.cjs'));
    expect(std.normalizeManifest('writer').dependencies).toContain('memory_core');
  });
});
