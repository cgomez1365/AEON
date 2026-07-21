/**
 * AEON Jarvis — Cloud Service (optional by design)
 * Supabase is a soft dependency: no env keys (or AEON_LOCAL_ONLY=1) → null
 * client, and every consumer already fail-softs on a null client. Data
 * sovereignty default is LOCAL; the cloud mirror is opt-in.
 */
const localOnly = process.env.AEON_LOCAL_ONLY === '1';

let supabase = null;
if (!localOnly) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
      console.warn('[CLOUD] Supabase client unavailable — running local-only:', e.message);
    }
  }
}

if (!supabase) console.log(`[CLOUD] Local-only mode${localOnly ? ' (AEON_LOCAL_ONLY=1)' : ''} — no cloud mirror attached.`);

module.exports = { supabase, localOnly };
