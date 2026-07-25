// Stateless resume-vs-JD grader — the shipped ATS in its simplest form:
// paste a resume + a job description, get an instant compliance-first fit score.
// No candidate records, no storage, no pipeline. (The legacy candidate-pipeline
// endpoints — intake/candidates/grade/grade-all/alert — remain mounted but the
// shipped UI no longer uses them.)
let _kernelLLM = null;

function bandFromScore(sc) {
  return sc >= 85 ? 'A' : sc >= 70 ? 'B' : sc >= 55 ? 'C' : sc >= 40 ? 'D' : 'F';
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

  try {
    const llmOut = await _kernelLLM(prompt, { role: 'grading' });
    let raw = (typeof llmOut === 'string' ? llmOut : llmOut?.text || llmOut?.response || '') + '';
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const data = JSON.parse(m ? m[0] : raw);
    const sc = Math.max(0, Math.min(100, Number(data.score) || 0));
    data.score = sc;
    data.grade = bandFromScore(sc);
    return res.status(200).json({ success: true, result: data });
  } catch (err) {
    return res.status(500).json({ error: 'Grading failed: ' + err.message });
  }
}

module.exports = (app, deps) => {
  if (deps && deps.kernelLLM) _kernelLLM = deps.kernelLLM;
  ['get', 'post', 'options'].forEach(m => app[m]('/api/ats/grade-resume', (req, res) => handler(req, res)));
};
