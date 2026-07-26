/**
 * AEON Jarvis — Cloud Service (optional by design)
 * Supabase is a soft dependency: no env keys (or AEON_LOCAL_ONLY=1) → null
 * client, and every consumer already fail-softs on a null client. Data
 * sovereignty default is LOCAL; the cloud mirror is opt-in.
 */
// Portable/USB media implies local-only: a drive that boots on an untrusted
// host must not reach for a cloud mirror, and a bundle built with no keys has
// nothing to reach with. Folding it in here means portable mode cannot drift
// out of sync with AEON_LOCAL_ONLY by someone setting only one of the two.
const localOnly = process.env.AEON_LOCAL_ONLY === '1'
  || process.env.AEON_PORTABLE === 'true';

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

if (!supabase) {
  // Always say WHY. The bare "local-only" message is ambiguous between a
  // deliberate opt-out and silently-missing credentials — they look identical
  // at boot but mean opposite things, and reading it as the wrong one sends
  // you hunting for a regression that isn't there.
  const why = process.env.AEON_PORTABLE === 'true' ? ' (AEON_PORTABLE=true)'
    : localOnly ? ' (AEON_LOCAL_ONLY=1)'
    : ' (no cloud keys in .env — local by default)';
  console.log(`[CLOUD] Local-only mode${why} — no cloud mirror attached.`);
}

module.exports = { supabase, localOnly };
