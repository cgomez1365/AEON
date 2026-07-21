const { createClient } = require("@supabase/supabase-js");
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

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

// Route: /api/ats/intake
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = getSupabase();
  const { name, email, phone, role, jobDescription, resumeBase64, source } = req.body;
  if (!name || !role || !jobDescription) return res.status(400).json({ error: 'Name, Role, and Job Description are required' });
  if (!resumeBase64) return res.status(400).json({ error: 'Resume PDF is required' });

  let resumeText = '';
  try {
    const buffer = Buffer.from(resumeBase64, 'base64');
    const pdfData = await pdfParse(buffer);
    resumeText = pdfData.text.trim();
    if (!resumeText) throw new Error('PDF extraction returned empty text. Ensure it is not an image-only PDF.');
  } catch (err) {
    return res.status(422).json({ error: 'Failed to extract text from PDF: ' + err.message });
  }

  const candidate = {
    id: `ATS-${Date.now()}`,
    name,
    email: email || null,
    phone: phone || null,
    role,
    job_description: jobDescription,
    resume_text: resumeText,
    source: source || 'manual',
    status: 'NEW',
    grade: null,
    score: null,
    grade_rationale: null,
    top_strengths: null,
    red_flags: null,
    interview_recommendation: null,
    submitted_at: new Date().toISOString(),
    graded_at: null
  };

  if (isCloud) {
    const { data, error } = await supabase.from('aeon_candidates').insert([candidate]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const formatted = {
      ...data,
      jobDescription: data.job_description, resumeText: data.resume_text,
      gradeRationale: data.grade_rationale, topStrengths: data.top_strengths,
      redFlags: data.red_flags, interviewRecommendation: data.interview_recommendation,
      submittedAt: data.submitted_at, gradedAt: data.graded_at
    };
    return res.status(200).json({ success: true, candidate: formatted });
  }

  const localCandidate = {
    id: candidate.id, name, email: email || '', phone: phone || '',
    role, resumeText, source: source || 'manual', status: 'NEW',
    grade: null, score: null, gradeRationale: null, topStrengths: null,
    redFlags: null, interviewRecommendation: null,
    submittedAt: candidate.submitted_at, gradedAt: null
  };
  const entries = loadLocal();
  entries.push(localCandidate);
  saveLocal(entries);
  res.status(200).json({ success: true, candidate: localCandidate });

  supabase.from('aeon_candidates').insert([candidate]).then(({ error }) => {
    if (error) console.error('[AEON] Supabase intake mirror error:', error.message);
  });
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/ats/intake', (req, res) => _handler(req, res)));
};
