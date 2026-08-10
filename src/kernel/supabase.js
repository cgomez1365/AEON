import { createClient } from '@supabase/supabase-js';

/**
 * BO-K — Supabase config is read at RUNTIME, not baked in at build time.
 *
 * This module used to be:
 *
 *   const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
 *
 * Vite inlines `import.meta.env` when the bundle is compiled, so that value was
 * frozen at build time. Settings saves Supabase credentials to the encrypted
 * vault at runtime — somewhere an already-built bundle can never look. The
 * result: pressing Save in Settings could not enable the Cloud tab under any
 * circumstance, on any machine, and the badge said "configured" anyway.
 *
 * Now the client is built from GET /api/settings/connectivity/public-config,
 * which reads the same vault the badge trusts and falls back to the server's
 * env. Save works with no rebuild, and the two answers come from one source.
 *
 * The anon key is publishable by design — it is what ships in every Supabase
 * browser app; row-level security is what protects the data. The service-role
 * key is never served and is not read by that route.
 *
 * Async because it must be. `createClient` cannot be called before the config
 * arrives, and pretending otherwise is what the old build-time read was doing.
 */

let client = null;          // resolved client, or null when unconfigured
let inflight = null;        // de-dupes concurrent callers during the first fetch
let resolved = false;       // distinguishes "not configured" from "not asked yet"

async function build() {
  // Build-time values still win when present, so an install that configures
  // Supabase through .env keeps its current behaviour and pays no round trip.
  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (envUrl && envAnon) return createClient(envUrl, envAnon);

  try {
    const r = await fetch('/api/settings/connectivity/public-config');
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.configured || !d.supabaseUrl || !d.supabaseAnonKey) return null;
    return createClient(d.supabaseUrl, d.supabaseAnonKey);
  } catch {
    // Kernel unreachable. Local-only is a supported mode, not a failure —
    // callers already treat a null client as "cloud is off".
    return null;
  }
}

/**
 * @returns {Promise<import('@supabase/supabase-js').SupabaseClient|null>}
 *   null means Supabase is not configured. Every caller already handles that.
 */
export function getSupabase() {
  if (resolved) return Promise.resolve(client);
  if (!inflight) {
    inflight = build().then((c) => {
      client = c;
      resolved = true;
      inflight = null;
      if (!client) console.log('[AEON] Supabase not configured — running local-only (this is fine).');
      return client;
    });
  }
  return inflight;
}

/**
 * Drop the cached client so the next getSupabase() re-reads the config.
 * Called after Settings saves new credentials — without this the operator
 * would have to reload the page to use what they just entered, which is a
 * milder version of the defect this file exists to fix.
 */
export function resetSupabase() {
  client = null;
  resolved = false;
  inflight = null;
}
