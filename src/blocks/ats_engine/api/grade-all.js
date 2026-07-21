const { createClient } = require("@supabase/supabase-js");
const fs = require('fs');
const path = require('path');

// kernelLLM injected by the block host — same compliance-first rubric as grade.js.
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

// Route: /api/ats/grade-all — 2-Way Sync
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();

  let ungraded;
  let allLocal;
  if (isCloud) {
    const { data, error: fetchErr } = await supabase.from('aeon_candidates').select('*').is('grade', null);
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    ungraded = data || [];
  } else {
    allLocal = loadLocal();
    ungraded = allLocal.filter(c => !c.grade).map(c => ({
      ...c, resume_text: c.resumeText || c.resume_text, job_description: c.jobDescription || c.job_description
    }));
  }

  if (ungraded.length === 0) return res.status(200).json({ success: true, graded: 0, message: 'All candidates already graded.' });

  if (!_kernelLLM) return res.status(503).json({ error: 'kernelLLM unavailable — grading requires the AEON kernel.' });

  let gradedCount = 0;

  for (const c of ungraded) {
    try {
      const prompt = `You are a structured, compliance-first technical recruiter. Grade this candidate using ONLY job-related criteria.
COMPLIANCE (EEOC, mandatory): judge only skills, experience, education, and measurable qualifications. IGNORE and never mention age, gender, race, religion, national origin, disability, health, family status, photos, or name/address-based inferences.
RUBRIC (score 0-100): skills match 40 · relevant experience 30 · seniority fit 15 · role-specific requirements 15. Bands: A>=85 B70-84 C55-69 D40-54 F<40.
ROLE: ${c.role}
JOB DESCRIPTION: ${c.job_description || '(none — use general expectations for the role)'}
RESUME: ${c.resume_text || '(None)'}
Respond in strict JSON: { "grade": "A|B|C|D|F", "score": 0-100, "rationale": "job-related evidence only", "topStrengths": [], "redFlags": [], "interviewRecommendation": "RECOMMEND|MAYBE|PASS" }`;

      const llmOut = await _kernelLLM(prompt, { role: 'grading', background: true });
      let raw = ((typeof llmOut === 'string' ? llmOut : llmOut?.text || llmOut?.response || '') + '')
        .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const g = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      const sc = Math.max(0, Math.min(100, Number(g.score) || 0));
      g.score = sc;
      g.grade = sc >= 85 ? 'A' : sc >= 70 ? 'B' : sc >= 55 ? 'C' : sc >= 40 ? 'D' : 'F';

      const updates = {
        grade: g.grade,
        score: g.score,
        grade_rationale: g.rationale,
        top_strengths: g.topStrengths,
        red_flags: g.redFlags,
        interview_recommendation: g.interviewRecommendation,
        status: g.interviewRecommendation === 'RECOMMEND' ? 'GRADED_A' : 'GRADED',
        graded_at: new Date().toISOString()
      };

      if (isCloud) {
        await supabase.from('aeon_candidates').update(updates).eq('id', c.id);
      } else {
        const idx = allLocal.findIndex(x => x.id === c.id);
        if (idx !== -1) {
          allLocal[idx] = {
            ...allLocal[idx],
            grade: g.grade, score: g.score, gradeRationale: g.rationale,
            topStrengths: g.topStrengths, redFlags: g.redFlags,
            interviewRecommendation: g.interviewRecommendation,
            status: updates.status, gradedAt: updates.graded_at
          };
        }
        supabase.from('aeon_candidates').update(updates).eq('id', c.id).then();
      }
      gradedCount++;
    } catch (e) {
      console.error(`[ATS BATCH] Failed to grade ${c.name}:`, e.message);
    }
  }

  if (!isCloud && allLocal) saveLocal(allLocal);
  return res.status(200).json({ success: true, graded: gradedCount, total: ungraded.length });
};

module.exports = (app, deps) => {
  if (deps && deps.kernelLLM) _kernelLLM = deps.kernelLLM;
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/ats/grade-all', (req, res) => _handler(req, res)));
};
