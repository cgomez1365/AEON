// Route: /api/ollama-status
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
  // Active model: env override, else the first model the daemon actually has.
  let OLLAMA_MODEL = process.env.OLLAMA_MODEL || null;

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, { 
      headers: {
        'X-AEON-SSH-Identity': process.env.OLLAMA_SSH_KEY || ''
      },
      signal: AbortSignal.timeout(4000) 
    });
    if (!response.ok) throw new Error("Offline");
    const data = await response.json();
    const models = (data.models || []).map(m => m.name);
    if (!OLLAMA_MODEL) OLLAMA_MODEL = models[0] || null;
    return res.status(200).json({ online: true, host: OLLAMA_HOST, activeModel: OLLAMA_MODEL, availableModels: models });
  } catch (err) {
    return res.status(200).json({ online: false, host: OLLAMA_HOST, activeModel: OLLAMA_MODEL, availableModels: [], fallback: 'gemini', error: err.message });
  }
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/ollama-status', (req, res) => _handler(req, res)));
};
