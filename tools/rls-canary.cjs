#!/usr/bin/env node
/**
 * AEON RLS Canary — proves the AEON tables are locked to the server.
 *
 * Uses ONLY the public anon key (the attacker's view) and only READS: one row
 * from each AEON table. It prints a status per table and never prints row data.
 *
 * Four verdicts, because "empty" is not "locked" and a refused KEY is not a locked table:
 *   LOCKED    Postgres says permission denied (code 42501) — the anon role has no
 *             privilege on the table at all. This is what db/migrations/002_lock_down_anon.sql
 *             produces, and the only answer that proves anything.
 *   REJECTED  The key itself was refused (401/403 without a permission-denied from
 *             Postgres: wrong, revoked or expired key). The table was NOT tested.
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
// Supabase's newer publishable keys (sb_publishable_…) are not JWTs and go in `apikey` only;
// older anon keys are JWTs and are also sent as the Bearer token.
const authHeaders = (k) => (String(k).startsWith('sb_') ? { apikey: k } : { apikey: k, Authorization: `Bearer ${k}` });

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

  let exposed = 0; let unproven = 0; let locked = 0; let absent = 0; let rejected = 0; let errored = 0;
  for (const table of SENSITIVE) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: authHeaders(anon) });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      const denied = body && !Array.isArray(body) && (body.code === '42501' || /permission denied/i.test(String(body.message || '')));
      if (denied) { locked++; console.log(`🟢 LOCKED    ${table} (HTTP ${res.status}, permission denied)`); }
      else if (res.status === 404 || (body && body.code === 'PGRST205')) { absent++; console.log(`⚪ ABSENT    ${table} (no such table)`); }
      else if (res.status === 401 || res.status === 403) { rejected++; console.log(`⚠️  REJECTED  ${table} — HTTP ${res.status}: the key itself was refused, so this table was NOT tested`); }
      else if (res.ok && Array.isArray(body) && body.length > 0) { exposed++; console.error(`🔴 EXPOSED   ${table} — anon read returned ${body.length} row(s) (HTTP ${res.status})`); }
      else if (res.ok) { unproven++; console.log(`🟡 UNPROVEN  ${table} — HTTP ${res.status}, no rows: anon HAS access to the table; empty could be RLS or just an empty table`); }
      else { rejected++; console.log(`⚠️  UNEXPECTED ${table} — HTTP ${res.status}: not a recognised answer, table not counted as locked`); }
    } catch (e) {
      errored++; console.log(`⚠️  ERROR     ${table} — request failed: ${e.message}`);
    }
  }
  console.log(`\n[canary] ${locked} locked · ${unproven} unproven · ${exposed} exposed · ${absent} absent · ${rejected} key-rejected · ${errored} failed`);
  if (exposed) {
    console.error('[canary] FAIL — anon can read data. Run db/migrations/002_lock_down_anon.sql.');
    process.exit(1);
  }
  // A PASS has to be earned: some table must have positively answered "permission denied", and
  // nothing may be left untested. Requests that failed outright (network, DNS, TLS) or whose key
  // was refused prove nothing, and must never read as a clean bill of health.
  if (rejected || errored) {
    console.error(`[canary] INCONCLUSIVE — ${rejected + errored} table(s) could not be tested (key refused or request failed). Fix the key, URL or network and run it again.`);
    process.exit(2);
  }
  if (unproven) {
    console.log('[canary] anon still holds privileges on some tables. Run db/migrations/002_lock_down_anon.sql to revoke them and make the refusal provable.');
    if (STRICT) process.exit(1);
    return;
  }
  if (!locked) {
    console.error('[canary] INCONCLUSIVE — no table positively answered "permission denied" (none exist, or none were reachable).');
    process.exit(2);
  }
  console.log('[canary] PASS — every AEON table that exists refuses the anonymous key.');
}

main();
