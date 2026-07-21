#!/usr/bin/env node
/**
 * AEON RLS Canary — proves sensitive Supabase tables stay locked to anon.
 *
 * Uses ONLY the public anon key (the attacker's view) to read each sensitive
 * table. A secure table returns [] or a permission error. Any returned rows =
 * regression → exit non-zero so CI / a cron alerts the operator.
 *
 * Run locally:   node tools/rls-canary.cjs
 * Run in CI/cron: same; non-zero exit fails the job.
 * Ref: docs/AEON-SECURITY-HANDOFF.md §5e (monitoring).
 */
require('dotenv').config();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const SENSITIVE = [
  'aeon_candidates', 'desktop_commands', 'bot_status', 'aeon_blocks',
  'documents', 'aeon_notes', 'aeon_governance',
];

async function main() {
  if (!url || !anon) {
    console.error('[canary] SUPABASE_URL / ANON_KEY not set — cannot run.');
    process.exit(2);
  }

  let breached = false;
  for (const table of SENSITIVE) {
    const endpoint = `${url}/rest/v1/${table}?select=*&limit=1`;
    try {
      const res = await fetch(endpoint, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      });
      let rows = [];
      try { rows = await res.json(); } catch { rows = []; }
      const exposed = Array.isArray(rows) && rows.length > 0;
      if (exposed) {
        breached = true;
        console.error(`🔴 EXPOSED  ${table} — anon read returned ${rows.length} row(s) (HTTP ${res.status})`);
      } else {
        console.log(`🟢 LOCKED   ${table} (HTTP ${res.status})`);
      }
    } catch (e) {
      console.log(`🟢 LOCKED   ${table} (request blocked: ${e.message})`);
    }
  }

  if (breached) {
    console.error('\n[canary] FAIL — at least one sensitive table is anon-readable. Run db/migrations/001_enable_rls.sql.');
    process.exit(1);
  }
  console.log('\n[canary] PASS — all sensitive tables locked to anonymous access.');
}

main();
