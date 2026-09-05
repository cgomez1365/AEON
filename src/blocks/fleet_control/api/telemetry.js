// Route: /api/telemetry
const _handler = async (req, res) => {
  // Try to fetch from GAS Hub as the primary data center / fallback
  const gasUrl = process.env.VITE_GAS_URL;
  
  let telemetry = {
    totalTokens: 0,
    totalRequests: 0,
    staffUsage: {
      qwen: { requests: 0, tokens: 0 },
      zenith: { requests: 0, tokens: 0 },
      groq: { requests: 0, tokens: 0 },
      gemini: { requests: 0, tokens: 0 },
    }
  };

  if (gasUrl) {
    try {
      const response = await fetch(`${gasUrl}?action=get_telemetry`);
      if (response.ok) {
        const data = await response.json();
        if (data.telemetry) {
          telemetry = data.telemetry;
        }
      }
    } catch(e) {
      console.error('[Vercel Telemetry] Failed to fetch from GAS data center:', e.message);
    }
  }

  // No fabricated fallback.
  //
  // This used to inject 4 requests / 1200 tokens attributed to "qwen" and
  // "zenith" whenever the real total was zero, so the charts "looked alive"
  // — on a fresh install with no providers configured, the dashboard would
  // report usage that had never happened. A meter that invents readings is
  // worse than one showing zero, because the operator cannot tell.
  //
  // activity/api/analytics.cjs already made exactly this correction ("the old
  // code injected 12 fake calls here so the charts 'looked alive'; a trusted
  // meter never fakes data") and this second copy of the same route never got
  // it. An empty install reports zero, which is the truth.

  res.status(200).json(telemetry);
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/telemetry', (req, res) => _handler(req, res)));
};
