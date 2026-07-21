const { createClient } = require("@supabase/supabase-js");
const fs = require('fs');
const path = require('path');

// Injected by the block host — kernelLLM routes through whatever provider is
// actually alive (local Ollama today, cloud when keys are rotated back in).
let _kernelLLM = null;

const isCloud = !!process.env.VERCEL;
const ATS_FILE = path.join(__dirname, '..', '..', '..', '..', 'db', 'aeon_ats.json');

const getSupabase = () => createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
);

const loadLocal = () => {
  if (!fs.existsSync(ATS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ATS_FILE, 'utf8')); } catch { return []; }
};
const saveLocal = (data) => { try { fs.writeFileSync(ATS_FILE, JSON.stringify(data, null, 2)); } catch {} };

// Route: /api/ats/grade
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { candidateId } = req.body;
  if (!candidateId) return res.status(400).json({ error: 'candidateId required.' });

  const supabase = getSupabase();
  let candidate;

  if (isCloud) {
    const { data, error: fetchErr } = await supabase.from('aeon_candidates').select('*').eq('id', candidateId).single();
    if (fetchErr || !data) return res.status(404).json({ error: 'Candidate not found.' });
    candidate = data;
  } else {
    const locals = loadLocal();
    const local = locals.find(c => c.id === candidateId);
    if (!local) return res.status(404).json({ error: 'Candidate not found.' });
    candidate = {
      ...local,
      resume_text: local.resumeText || local.resume_text,
      job_description: local.jobDescription || local.job_description,
    };
  }

  const prompt = `You are a structured, compliance-first technical recruiter. Evaluate the candidate against the job description using ONLY job-related criteria.

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
Grade bands: A ≥ 85 · B 70-84 · C 55-69 · D 40-54 · F < 40
Recommendation: RECOMMEND if A/B with no critical gap · MAYBE if C or B with one critical gap · PASS otherwise.

### TARGET JOB DESCRIPTION ###
${candidate.job_description || '(No Job Description provided. Grade based on general role expectations for: ' + candidate.role + ')'}

### CANDIDATE RESUME RAW TEXT ###
${candidate.resume_text || '(No resume provided — grade based on available info only.)'}

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

  if (!_kernelLLM) return res.status(503).json({ error: 'kernelLLM unavailable — grading requires the AEON kernel.' });

  try {
    const llmOut = await _kernelLLM(prompt, { role: 'grading' });
    let rawResponse = (typeof llmOut === 'string' ? llmOut : llmOut?.text || llmOut?.response || '') + '';
    rawResponse = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // Models sometimes wrap or preface JSON — extract the outermost object.
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    const gradeData = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse);
    // Enforce band consistency: score is truth, grade derives from it.
    const sc = Math.max(0, Math.min(100, Number(gradeData.score) || 0));
    gradeData.score = sc;
    gradeData.grade = sc >= 85 ? 'A' : sc >= 70 ? 'B' : sc >= 55 ? 'C' : sc >= 40 ? 'D' : 'F';

    const updates = {
      grade: gradeData.grade,
      score: gradeData.score,
      grade_rationale: gradeData.rationale,
      top_strengths: gradeData.topStrengths,
      red_flags: gradeData.redFlags,
      interview_recommendation: gradeData.interviewRecommendation,
      status: gradeData.interviewRecommendation === 'RECOMMEND' ? 'GRADED_A' : 'GRADED',
      graded_at: new Date().toISOString()
    };

    if (isCloud) {
      const { data: updated, error: updateErr } = await supabase.from('aeon_candidates').update(updates).eq('id', candidateId).select().single();
      if (updateErr) throw new Error(updateErr.message);
      const formatted = {
        ...updated, resumeText: updated.resume_text,
        gradeRationale: updated.grade_rationale, topStrengths: updated.top_strengths,
        redFlags: updated.red_flags, interviewRecommendation: updated.interview_recommendation,
        submittedAt: updated.submitted_at, gradedAt: updated.graded_at
      };
      return res.status(200).json({ success: true, candidate: formatted });
    }

    const locals = loadLocal();
    const idx = locals.findIndex(c => c.id === candidateId);
    if (idx !== -1) {
      locals[idx] = {
        ...locals[idx],
        grade: updates.grade, score: updates.score,
        gradeRationale: updates.grade_rationale, topStrengths: updates.top_strengths,
        redFlags: updates.red_flags, interviewRecommendation: updates.interview_recommendation,
        status: updates.status, gradedAt: updates.graded_at
      };
      saveLocal(locals);
    }
    res.status(200).json({ success: true, candidate: locals[idx] || candidate });

    supabase.from('aeon_candidates').update(updates).eq('id', candidateId).then(({ error }) => {
      if (error) console.error('[AEON] Supabase grade mirror error:', error.message);
    });
  } catch (err) {
    return res.status(500).json({ error: 'Grading failed: ' + err.message });
  }
};

module.exports = (app, deps) => {
  if (deps && deps.kernelLLM) _kernelLLM = deps.kernelLLM;
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/ats/grade', (req, res) => _handler(req, res)));
};
