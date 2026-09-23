// Stateless resume-vs-JD grader — the shipped ATS in its simplest form:
// paste a resume + a job description, get an instant compliance-first fit score.
// No candidate records, no storage, no pipeline. (The legacy candidate-pipeline
// endpoints — intake/candidates/grade/grade-all/alert — were removed in the
// 2026-07-24 cleanup; this comment said they were still mounted.)
let _kernelLLM = null;

function bandFromScore(sc) {
  return sc >= 85 ? 'A' : sc >= 70 ? 'B' : sc >= 55 ? 'C' : sc >= 40 ? 'D' : 'F';
}

// The rubric DEFINES the score as the weighted sum of these four. A model
// asked for both routinely mis-adds: measured 2026-09-23, score 91 over
// subscores summing to 74 — the UI showed an "A" above bars that add up to a
// C. When the breakdown is complete, the sum is computed here.
const SUBSCORE_MAX = { skills: 40, experience: 30, seniority: 15, requirements: 15 };

function reconcile(data) {
  const out = { ...data };
  const subs = data && typeof data.subscores === 'object' && data.subscores ? data.subscores : null;
  const complete = subs && Object.keys(SUBSCORE_MAX).every((k) => Number.isFinite(Number(subs[k])));
  const modelScore = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
  if (complete) {
    const clamped = {};
    for (const [k, max] of Object.entries(SUBSCORE_MAX)) clamped[k] = Math.max(0, Math.min(max, Math.round(Number(subs[k]))));
    out.subscores = clamped;
    out.score = Object.values(clamped).reduce((a, b) => a + b, 0);
    if (Number.isFinite(Number(data.score)) && modelScore !== out.score) {
      out.scoreNote = `The model's overall score (${modelScore}) did not match its own breakdown (${out.score}). The breakdown is the rubric's definition of the score, so ${out.score} is shown.`;
    }
  } else {
    out.score = modelScore;
  }
  out.grade = bandFromScore(out.score);
  // Rubric: RECOMMEND needs an A or B; a C is at most MAYBE; below that, PASS.
  const rec = String(data.interviewRecommendation || '').toUpperCase();
  if (out.grade === 'C' && rec === 'RECOMMEND') out.interviewRecommendation = 'MAYBE';
  else if ((out.grade === 'D' || out.grade === 'F') && rec && rec !== 'PASS') out.interviewRecommendation = 'PASS';
  return out;
}

/**
 * One call to the grading role. The streaming transport is preferred because
 * it reports whether the model stopped at its output limit — kernelLLM's
 * blocking form returns the text alone, so a cut-off JSON answer surfaced as
 * "Unexpected token … is not valid JSON".
 */
async function askGrader(prompt) {
  if (typeof _kernelLLM.stream === 'function') {
    // Streams time out only until headers arrive; keep the blocking call's
    // 240 s bound so a stalled answer cannot hang the grade forever.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 240000);
    try {
      const r = await _kernelLLM.stream([{ role: 'user', content: prompt }], { role: 'grading', onToken: () => {}, signal: ac.signal });
      if (r.cancelled && !r.text) throw new Error('The model did not finish within 4 minutes.');
      return { text: r.text || '', truncated: !!(r.truncated || r.cancelled) };
    } finally { clearTimeout(timer); }
  }
  const out = await _kernelLLM(prompt, { role: 'grading' });
  return { text: (typeof out === 'string' ? out : out?.text || out?.response || '') + '', truncated: null };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { resume, jobDescription } = req.body || {};
  if (!resume || !String(resume).trim()) return res.status(400).json({ error: 'Paste your resume text.' });
  if (!_kernelLLM) return res.status(503).json({ error: 'Grading requires the AEON kernel — no AI provider is available. Add a key in Settings or start a local model.' });

  const prompt = `You are a structured, compliance-first technical recruiter. Evaluate the resume against the job description using ONLY job-related criteria.

COMPLIANCE RULES (mandatory — EEOC):
- Base every judgment ONLY on skills, experience, education, and measurable qualifications relevant to the role.
- COMPLETELY IGNORE and NEVER mention: age, gender, race, ethnicity, religion, national origin, disability, health, marital/family status, pregnancy, photos, name-based inferences, address/zip, or graduation years used to infer age.
- If the resume contains such information, exclude it from consideration entirely.
- Employment gaps may be noted only as neutral facts, never speculated about.

SCORING RUBRIC (score = weighted sum, 0-100):
- Skills match vs required skills: 40 pts
- Relevant experience (depth + recency in comparable roles): 30 pts
- Scope/seniority fit (not over/under-leveled): 15 pts
- Role-specific requirements (certs, tooling, domain): 15 pts
Grade bands: A >= 85 - B 70-84 - C 55-69 - D 40-54 - F < 40
Recommendation: RECOMMEND if A/B with no critical gap - MAYBE if C or B with one critical gap - PASS otherwise.

### TARGET JOB DESCRIPTION ###
${jobDescription && String(jobDescription).trim() ? jobDescription : '(No job description provided — grade against general expectations you infer from the resume\'s target role.)'}

### CANDIDATE RESUME RAW TEXT ###
${resume}

Respond in strict JSON only, using the following schema exactly:
{
  "grade": "A|B|C|D|F",
  "score": 0-100,
  "subscores": { "skills": 0-40, "experience": 0-30, "seniority": 0-15, "requirements": 0-15 },
  "rationale": "2-3 sentences citing only job-related evidence from the resume.",
  "topStrengths": ["strength1", "strength2"],
  "redFlags": ["job-related gap 1", "missing required skill"],
  "interviewRecommendation": "RECOMMEND|MAYBE|PASS"
}`;

  let answer;
  try {
    answer = await askGrader(prompt);
  } catch (err) {
    // A rate limit clears in seconds and must not read as a fault; "nothing is
    // configured" is fixed in Settings; anything else is the provider's error.
    const rateLimited = !!err.rateLimited || err.status === 429;
    const status = rateLimited ? 429 : err.noProviderAvailable ? 503 : 502;
    return res.status(status).json({
      error: rateLimited
        ? `${err.message} Nothing was graded — try again in a minute.`
        : err.noProviderAvailable
          ? 'No model is assigned to grading. Assign one in Settings → Model Assignment (the Grading role), or install a local model.'
          : `Grading failed: ${err.message}`,
      rateLimited,
    });
  }

  const raw = answer.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  let data = null;
  try { data = JSON.parse(m ? m[0] : raw); } catch { data = null; }
  if (!data || typeof data !== 'object') {
    if (answer.truncated) {
      return res.status(502).json({
        truncated: true,
        error: 'The model\'s answer was cut off at its output limit before the grade was finished. '
          + 'Assign a model with a larger output budget to the Grading role in Settings (free OpenRouter models stop at 1024 tokens, and reasoning models spend part of that thinking), or shorten the résumé and job description.',
      });
    }
    return res.status(502).json({
      error: 'The model did not answer with a grade (its reply was not the JSON the grader asks for). Try again, or assign a different model to the Grading role in Settings.',
      preview: raw.slice(0, 160),
    });
  }
  return res.status(200).json({ success: true, result: reconcile(data), ...(answer.truncated ? { truncated: true } : {}) });
}

// Each verb is registered BY NAME. This was a forEach over
// ['get', 'post', 'options'] calling app[m](PATH, h) — a computed verb,
// which scripts/gen-block-routes.cjs can only declare as method ALL — and the
// kernel's manifest auth never matches ALL, so once an operator account
// existed the grade still answered without a session (measured by agent C3,
// 2026-09-23; tests/resume-grader-route-auth.test.js). Named verbs are
// declared as POST/GET and guarded. OPTIONS (CORS preflight) is pre-auth by
// design and is not a declared route.
module.exports = (app, deps) => {
  if (deps && deps.kernelLLM) _kernelLLM = deps.kernelLLM;
  app.post('/api/resume-grader/grade', (req, res) => handler(req, res));
  app.get('/api/resume-grader/grade', (req, res) => handler(req, res));
  app.options('/api/resume-grader/grade', (req, res) => handler(req, res));
};
