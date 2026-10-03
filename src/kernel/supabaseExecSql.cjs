/**
 * The exec_sql() function AEON asks an operator to create in their own
 * Supabase project, and the grants that keep it to the service role.
 *
 * exec_sql runs any SQL as its owner (SECURITY DEFINER). Settings → Cloud and
 * tools/migrate.cjs apply schemas through it. The bootstrap they printed
 * before 2026-10-03 revoked EXECUTE from `anon, authenticated` only; Postgres
 * grants EXECUTE on a new function to PUBLIC, which both roles belong to, so
 * anyone holding the project's public anon key could run any SQL (audit #1).
 *
 * A project that ran that text already has exec_sql, so it never sees the new
 * bootstrap. lockDown() runs the grants through exec_sql itself, as its owner,
 * before anything else is applied: the next setup or migrate run closes it.
 *
 * search_path: `extensions` too, where Supabase installs pgvector by default —
 * db/migrations/second_brain_chunks.sql needs `vector` to resolve. Postgres
 * skips a schema in the path that does not exist.
 *
 * Kernel module: no requires; the Supabase client is passed in.
 */
'use strict';

const SEARCH_PATH = 'public, extensions';

const LOCKDOWN_SQL = [
  'REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC, anon, authenticated;',
  'GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;',
  `ALTER FUNCTION public.exec_sql(text) SET search_path = ${SEARCH_PATH};`,
].join('\n');

const BOOTSTRAP_SQL = [
  'CREATE OR REPLACE FUNCTION public.exec_sql(sql text) RETURNS void',
  `  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${SEARCH_PATH} AS $$ BEGIN EXECUTE sql; END; $$;`,
  'REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC, anon, authenticated;',
  'GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;',
].join('\n');

// PostgREST answers PGRST202 for an RPC it cannot find; older versions said
// so only in the message.
function isMissing(error) {
  if (!error) return false;
  if (error.code === 'PGRST202') return true;
  const msg = String(error.message || '');
  return /exec_sql/i.test(msg) && /could not find|does not exist|schema cache/i.test(msg);
}

/**
 * Revoke exec_sql from PUBLIC, anon and authenticated, grant it to
 * service_role, pin its search_path — through exec_sql, as its owner.
 * @param {{ rpc: Function }} db  a Supabase client holding the service role key
 * @returns {Promise<{ ok: true } | { ok: false, missing: boolean, error: string }>}
 */
async function lockDown(db) {
  let error;
  try { ({ error } = await db.rpc('exec_sql', { sql: LOCKDOWN_SQL })); }
  catch (e) { error = e; }
  if (!error) return { ok: true };
  return { ok: false, missing: isMissing(error), error: String(error.message || error) };
}

const LOCKED_NOTE = 'exec_sql() can be called with the service role key only (revoked from PUBLIC, anon and authenticated).';

module.exports = { BOOTSTRAP_SQL, LOCKDOWN_SQL, SEARCH_PATH, LOCKED_NOTE, lockDown, isMissing };
