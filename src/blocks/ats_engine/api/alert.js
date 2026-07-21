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

// Route: /api/ats/alert — 2-Way Sync
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { candidateId } = req.body;
  if (!candidateId) return res.status(400).json({ error: 'candidateId required.' });

  const supabase = getSupabase();
  let c;

  if (isCloud) {
    const { data, error: fetchErr } = await supabase.from('aeon_candidates').select('*').eq('id', candidateId).single();
    if (fetchErr || !data) return res.status(404).json({ error: 'Candidate not found.' });
    c = data;
  } else {
    const local = loadLocal().find(x => x.id === candidateId);
    if (!local) return res.status(404).json({ error: 'Candidate not found.' });
    c = {
      ...local,
      top_strengths: local.topStrengths || local.top_strengths,
      red_flags: local.redFlags || local.red_flags,
      interview_recommendation: local.interviewRecommendation || local.interview_recommendation,
    };
  }

  const prompt = `Draft a concise internal hiring alert email (under 100 words) for a business owner. The subject line should be urgent and clear.
Candidate: ${c.name}
Role: ${c.role}
Grade: ${c.grade} (${c.score}/100)
Strengths: ${(c.top_strengths || []).join(', ')}
Red Flags: ${(c.red_flags || []).join(', ') || 'None'}
Recommendation: ${c.interview_recommendation}

Respond in JSON: { "subject": "...", "body": "..." }`;

  // Nervous-system rule: blocks never pick providers or models. The kernel
  // resolves the "analyst" role from Settings and handles fallbacks itself.
  try {
    const port = Number(process.env.PORT) || 3001;
    const r = await fetch(`http://127.0.0.1:${port}/api/ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, role: 'analyst', background: true }),
    });
    const d = await r.json();
    if (!r.ok || !d.text) throw new Error(d.error || `kernel LLM error ${r.status}`);

    let raw = d.text;
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const alert = JSON.parse(raw);

    return res.status(200).json({ success: true, alert });
  } catch (err) {
    return res.status(500).json({ error: 'Alert generation failed: ' + err.message });
  }
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/ats/alert', (req, res) => _handler(req, res)));
};
