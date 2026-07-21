import { createClient } from '@supabase/supabase-js';

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Supabase is an optional cloud mirror — same soft-dependency contract as
// the server's services/cloud.js. createClient() throws synchronously on a
// missing URL, and this module is imported eagerly (App -> AeonContext), so
// an unguarded call here took the entire app down at boot with zero cloud
// keys configured. Consumers (AeonContext's mirrorToSupabase, the files
// block) already expect a possibly-null client.
export const supabase = (supabaseUrl && supabaseAnon)
  ? createClient(supabaseUrl, supabaseAnon)
  : null;

if (!supabase) console.log('[AEON] Supabase not configured — running local-only (this is fine).');
