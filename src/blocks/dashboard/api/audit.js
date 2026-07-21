const { createClient } = require("@supabase/supabase-js");

const getSupabase = () => createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
);

// Route: /api/audit
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabase = getSupabase();

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('aeon_audit_log').select('*').order('timestamp', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data.reverse());
  }

  if (req.method === 'POST') {
    const { agent, action, details, statusCode, telemetryTokens } = req.body;
    const newEntry = {
      id: `audit_${Date.now()}`,
      agent: agent || 'SYSTEM',
      action: action || 'UNKNOWN',
      details: details || '',
      status_code: statusCode || 200,
      telemetry_tokens: telemetryTokens || 0,
      timestamp: new Date().toISOString()
    };
    const { error } = await supabase.from('aeon_audit_log').insert([newEntry]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, log: newEntry });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/audit', (req, res) => _handler(req, res)));
};
