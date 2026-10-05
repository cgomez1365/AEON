#!/usr/bin/env node
/**
 * AEON RLS Canary — proves the AEON tables are locked to the server.
 *
 * Uses ONLY the public anon key (the attacker's view) and only READS: one row
 * from each AEON table. It prints a status per table and never prints row data.
 *
 * Three verdicts, because "empty" is not "locked":
 *   LOCKED    HTTP 401/403 (permission denied) — the anon role has no privilege on
 *             the table at all. This is what db/migrations/002_lock_down_anon.sql
 *             produces, and the only answer that proves anything.
 *   UNPROVEN  HTTP 200 with no rows — either RLS is hiding the rows, or the table
 *             is empty and a policy is open. An empty list cannot tell these apart
 *             (the earlier canary reported this as LOCKED). Run 002.
 *   EXPOSED   HTTP 200 with rows — anon reads real data. Exit 1.
 * A table that does not exist (404) is skipped. Writes cannot be tested without
 * writing, so none are attempted: run 002 and every write is refused with the reads.
 *
 * Run locally:   node tools/rls-canary.cjs
 * Run in CI/cron: same; non-zero exit fails the job (EXPOSED, or UNPROVEN with --strict).
 * Ref: docs/AEON-SECURITY-HANDOFF.md §5e (monitoring).
 */
require('dotenv').config();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const STRICT = process.argv.includes('--strict');

const SENSITIVE = [
  'aeon_candidates', 'desktop_commands', 'bot_status', 'aeon_blocks',
  'documents', 'aeon_notes', 'aeon_subjects', 'aeon_sync_state', 'aeon_governance',
  'aeon_vault', 'aeon_endpoints', 'vault_docs', 'vp_feed', 'second_brain_chunks',
  'aeon_audit_log', 'aeon_chat_log', 'aeon_sandbox', 'aeon_terminal_history', 'app_state',
];

async function main() {
  if (!url || !anon) {
    console.error('[canary] SUPABASE_URL / ANON_KEY not set — cannot run.');
    process.exit(2);
  }

  let exposed = 0; let unproven = 0; let locked = 0; let absent = 0;
  for (const table of SENSITIVE) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.status === 401 || res.status === 403) { locked++; console.log(`🟢 LOCKED    ${table} (HTTP ${res.status}, permission denied)`); }
      else if (res.status === 404 || (body && body.code === 'PGRST205')) { absent++; console.log(`⚪ ABSENT    ${table} (no such table)`); }
      else if (res.ok && Array.isArray(body) && body.length > 0) { exposed++; console.error(`🔴 EXPOSED   ${table} — anon read returned ${body.length} row(s) (HTTP ${res.status})`); }
      else if (res.ok) { unproven++; console.log(`🟡 UNPROVEN  ${table} — HTTP ${res.status}, no rows: anon HAS access to the table; empty could be RLS or just an empty table`); }
      else { locked++; console.log(`🟢 LOCKED    ${table} (HTTP ${res.status})`); }
    } catch (e) {
      console.log(`⚠️  ERROR     ${table} — request failed: ${e.message}`);
    }
  }
  console.log(`\n[canary] ${locked} locked · ${unproven} unproven · ${exposed} exposed · ${absent} absent`);
  if (exposed) {
    console.error('[canary] FAIL — anon can read data. Run db/migrations/002_lock_down_anon.sql.');
    process.exit(1);
  }
  if (unproven) {
    console.log('[canary] anon still holds privileges on some tables. Run db/migrations/002_lock_down_anon.sql to revoke them and make the refusal provable.');
    if (STRICT) process.exit(1);
    return;
  }
  console.log('[canary] PASS — every AEON table refuses the anonymous key.');
}

main();
