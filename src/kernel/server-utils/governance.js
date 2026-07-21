// AEON Autonomous Resource Governance Controller
const DAILY_TOKEN_SOFT_CAP = 500000;

// Approximate 2026 pricing in USD per 1 Million Tokens (Input + Output blended average)
const MODEL_COSTS = {
  'gemini-3.5-flash': 5.25,
  'gemini-2.5-flash': 0.60,
  'gemini-3.1-flash-lite': 0.15,
  'gemini-2.5-pro': 14.00,
};

async function checkGovernanceStatus(supabase) {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('aeon_governance')
      .select('daily_tokens, is_throttled, last_reset_date')
      .eq('id', 'global_state')
      .single();
    if (error) {
      console.warn('[GOVERNANCE] Failed to fetch state, failing open:', error.message);
      return false;
    }
    const today = new Date().toISOString().split('T')[0];
    if (data.last_reset_date !== today) return false;
    return data.is_throttled || data.daily_tokens >= DAILY_TOKEN_SOFT_CAP;
  } catch (err) {
    console.warn('[GOVERNANCE] Exception in checkGovernanceStatus, failing open:', err.message);
    return false;
  }
}

function logTokenUsage(supabase, totalTokens, modelId) {
  if (!supabase || !totalTokens) return;
  const costPerMillion = MODEL_COSTS[modelId] || 0.60;
  const estimatedCost = (totalTokens / 1000000) * costPerMillion;
  (async () => {
    try {
      const { data, error } = await supabase
        .from('aeon_governance')
        .select('daily_tokens, daily_cost_usd, last_reset_date')
        .eq('id', 'global_state')
        .single();
      if (error) return;
      const today = new Date().toISOString().split('T')[0];
      let newTokens = totalTokens;
      let newCost = estimatedCost;
      if (data.last_reset_date === today) {
        newTokens = Number(data.daily_tokens) + totalTokens;
        newCost = Number(data.daily_cost_usd) + estimatedCost;
      }
      const isThrottled = newTokens >= DAILY_TOKEN_SOFT_CAP;
      await supabase
        .from('aeon_governance')
        .update({ daily_tokens: newTokens, daily_cost_usd: newCost, last_reset_date: today, is_throttled: isThrottled })
        .eq('id', 'global_state');
    } catch (err) {
      console.warn('[GOVERNANCE] Background logging failed:', err.message);
    }
  })();
}

module.exports = { DAILY_TOKEN_SOFT_CAP, MODEL_COSTS, checkGovernanceStatus, logTokenUsage };
