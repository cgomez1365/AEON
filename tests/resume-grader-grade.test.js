/**
 * Resume Grader — the score the operator reads must be the one the breakdown
 * adds up to, and a failed grade must say why.
 *
 * Measured live 2026-09-23 (agent C2, stub model on a throwaway install):
 *
 *   A model answered score 91 with subscores 30 + 22 + 12 + 10 = 74. The block
 *   trusted the 91, derived grade "A", and the UI showed an A over four bars
 *   that add up to a C — with RECOMMEND beside a red flag on a REQUIRED cert.
 *   Models are poor at their own arithmetic; the rubric defines the score AS
 *   the weighted sum, so the sum is computed here, not asked for.
 *
 *   An answer cut off at the model's output limit → HTTP 500
 *   "Grading failed: Unexpected token 'P', "Point 1. T"... is not valid JSON".
 *   A 429 → HTTP 500 "Grading failed: custom is rate-limited…".
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'src', 'blocks', 'resume_grader', 'api', 'grade-resume.js');

let server;
afterEach(async () => { if (server) await new Promise((r) => server.close(r)); server = null; });

/** Mount the real plugin with a fake kernelLLM. `answer` drives both transports. */
async function mount(answer, { withStream = true } = {}) {
  delete require_.cache[require_.resolve(MOD)];
  const calls = [];
  const kernelLLM = async (prompt, opts) => { calls.push({ opts }); const a = await answer(); return a.text; };
  if (withStream) kernelLLM.stream = async (messages, opts) => { calls.push({ opts, stream: true }); return answer(); };
  const app = express();
  app.use(express.json());
  require_(MOD)(app, { kernelLLM });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  const grade = (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/resume-grader/grade', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
  return { grade, calls };
}

const RESUME = { resume: 'Jane Doe. Senior engineer. 4 years Node.js and React.', jobDescription: 'Senior engineer. Required: Kubernetes certification.' };
const json = (o) => ({ text: JSON.stringify(o), truncated: false });

describe('the score is the breakdown\'s sum', () => {
  it('recomputes a score the model mis-added, and says so', async () => {
    const { grade } = await mount(async () => json({
      grade: 'A', score: 91, subscores: { skills: 30, experience: 22, seniority: 12, requirements: 10 },
      rationale: 'r', topStrengths: ['a'], redFlags: ['No Kubernetes certification (required)'], interviewRecommendation: 'RECOMMEND',
    }));
    const r = await grade(RESUME);
    expect(r.status).toBe(200);
    expect(r.body.result.score).toBe(74);
    expect(r.body.result.grade).toBe('B');
    expect(r.body.result.scoreNote).toMatch(/91/);
  });

  it('clamps a subscore above its rubric maximum', async () => {
    const { grade } = await mount(async () => json({
      score: 100, subscores: { skills: 55, experience: 30, seniority: 15, requirements: 15 }, interviewRecommendation: 'RECOMMEND',
    }));
    const r = await grade(RESUME);
    expect(r.body.result.subscores.skills).toBe(40);
    expect(r.body.result.score).toBe(100);
  });

  it('a C or below cannot carry RECOMMEND — the rubric caps it', async () => {
    const { grade } = await mount(async () => json({
      score: 80, subscores: { skills: 20, experience: 20, seniority: 10, requirements: 10 }, interviewRecommendation: 'RECOMMEND',
    }));
    const r = await grade(RESUME);
    expect(r.body.result.score).toBe(60);
    expect(r.body.result.grade).toBe('C');
    expect(r.body.result.interviewRecommendation).toBe('MAYBE');
  });

  it('keeps the model\'s score when it gave no usable breakdown', async () => {
    const { grade } = await mount(async () => json({ score: 66, interviewRecommendation: 'MAYBE' }));
    const r = await grade(RESUME);
    expect(r.body.result.score).toBe(66);
    expect(r.body.result.grade).toBe('C');
    expect(r.body.result.scoreNote).toBeUndefined();
  });
});

describe('a failed grade says why', () => {
  it('an answer cut off at the output limit is named as such, not a JSON parse error', async () => {
    const { grade } = await mount(async () => ({ text: '{"grade":"B","score":72,"subscores":{"skills":3', truncated: true, truncationReason: 'max_tokens' }));
    const r = await grade(RESUME);
    expect(r.status).toBe(502);
    expect(r.body.truncated).toBe(true);
    expect(r.body.error).toMatch(/cut off/i);
    expect(r.body.error).not.toMatch(/Unexpected token/);
  });

  it('an answer that is not JSON says so in words', async () => {
    const { grade } = await mount(async () => ({ text: 'Point 1. This candidate is strong because', truncated: false }));
    const r = await grade(RESUME);
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/not.*(JSON|a grade)/i);
    expect(r.body.error).not.toMatch(/Unexpected token/);
  });

  it('a rate limit is a 429 that says to retry', async () => {
    const { grade } = await mount(async () => { const e = new Error('custom is rate-limited right now (HTTP 429). This is temporary'); e.rateLimited = true; throw e; });
    const r = await grade(RESUME);
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/rate-limited/);
  });

  it('grades through the grading role on the streaming transport', async () => {
    const { grade, calls } = await mount(async () => json({ score: 70, subscores: { skills: 28, experience: 21, seniority: 11, requirements: 10 } }));
    await grade(RESUME);
    expect(calls[0]).toMatchObject({ stream: true });
    expect(calls[0].opts.role).toBe('grading');
  });

  it('still grades on a kernel with no streaming transport', async () => {
    const { grade, calls } = await mount(async () => json({ score: 70, subscores: { skills: 28, experience: 21, seniority: 11, requirements: 10 } }), { withStream: false });
    const r = await grade(RESUME);
    expect(r.status).toBe(200);
    expect(r.body.result.score).toBe(70);
    expect(calls[0].opts.role).toBe('grading');
  });
});
