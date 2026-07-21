const { createClient } = require("@supabase/supabase-js");
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

const mapCamel = (c) => ({
  id: c.id, name: c.name, email: c.email, phone: c.phone,
  role: c.role, resumeText: c.resume_text, source: c.source,
  status: c.status, grade: c.grade, score: c.score,
  gradeRationale: c.grade_rationale, topStrengths: c.top_strengths,
  redFlags: c.red_flags, interviewRecommendation: c.interview_recommendation,
  submittedAt: c.submitted_at, gradedAt: c.graded_at
});

// Route: /api/ats/candidates — 2-Way Sync
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  if (req.method === 'GET') {
    if (isCloud) {
      const { data, error } = await supabase
        .from('aeon_candidates')
        .select('*')
        .order('submitted_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data.map(mapCamel));
    }

    const local = loadLocal();
    res.status(200).json(local);
    supabase.from('aeon_candidates').select('*').order('submitted_at', { ascending: false }).then(({ data, error }) => {
      if (!error && data) saveLocal(data.map(mapCamel));
    });
    return;
  }

  if (req.method === 'DELETE') {
    const id = req.params.id || (req.query && req.query.id);
    if (!id) return res.status(400).json({ error: 'Candidate ID is required' });

    if (isCloud) {
      const { error } = await supabase.from('aeon_candidates').delete().eq('id', id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ message: 'Candidate deleted successfully' });
    }

    const entries = loadLocal().filter(c => c.id !== id);
    saveLocal(entries);
    res.status(200).json({ message: 'Candidate deleted successfully' });
    supabase.from('aeon_candidates').delete().eq('id', id).then(({ error }) => {
      if (error) console.error('[AEON] Supabase delete mirror error:', error.message);
    });
    return;
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => {
    app[m]('/api/ats/candidates', (req, res) => _handler(req, res));
    app[m]('/api/ats/candidates/:id', (req, res) => _handler(req, res));
  });
};
