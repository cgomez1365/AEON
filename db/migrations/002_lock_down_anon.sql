-- =====================================================================
-- AEON MIGRATION 002 — LOCK EVERY AEON TABLE TO THE SERVER
-- Ref: audit 2026-10-04
-- Run in: Supabase → SQL Editor → New query   (Settings → Cloud applies it for you)
-- Idempotent: safe to run more than once. Tables that do not exist are skipped.
--
-- Why this exists. The earlier schemas created policies such as
--     CREATE POLICY "Allow service role full access" ON aeon_notes FOR ALL USING (true);
-- A policy with no TO clause applies to PUBLIC — which includes the `anon` role
-- whose key ships in every browser app — so the name changed nothing: anyone
-- holding the anon key could read and write notes, governance, block data and
-- the relay's command queue (desktop_commands), and read mirrored document text
-- (vault_docs). 001_enable_rls.sql did not help: it switched RLS on but never
-- dropped those policies (permissive policies are OR-ed together), and it added
-- an `authed_all` policy for `authenticated` — which anyone can become by signing
-- up on a project that allows sign-ups.
--
-- What this does, for every AEON table that exists:
--   1. makes sure Row Level Security is ON;
--   2. drops EVERY policy that is not scoped to service_role alone — the old
--      "for all" policies, anon read policies, authed_all, whatever they are named;
--   3. revokes the table privileges from PUBLIC, anon and authenticated, so a
--      request with the public key is refused outright (HTTP 401, 42501) rather
--      than answered with an empty list that could hide an open policy.
-- AEON's server uses the service role key, which bypasses RLS, so nothing it does
-- changes. It does mean the server needs SUPABASE_SERVICE_ROLE_KEY: with only the
-- anon key it can no longer reach these tables.
-- =====================================================================

DO $$
DECLARE
  t        text;
  pol      record;
  has_anon boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_auth boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  dropped  integer := 0;
  locked   integer := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'aeon_blocks', 'aeon_notes', 'aeon_subjects', 'aeon_sync_state', 'aeon_governance',
    'aeon_vault', 'aeon_endpoints', 'desktop_commands', 'bot_status', 'vault_docs', 'vp_feed',
    'aeon_candidates', 'documents', 'aeon_audit_log', 'aeon_chat_log', 'aeon_sandbox',
    'aeon_terminal_history', 'app_state', 'second_brain_chunks', 'schema_migrations'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND roles::text[] <> ARRAY['service_role']::text[]
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      dropped := dropped + 1;
    END LOOP;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    IF has_anon THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t); END IF;
    IF has_auth THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t); END IF;
    locked := locked + 1;
  END LOOP;

  RAISE NOTICE 'AEON lockdown: % table(s) locked, % policy(ies) dropped', locked, dropped;
END $$;

-- ── VERIFY (run after) ──
-- The public key must now be REFUSED on every AEON table (permission denied, not []):
--   curl -s 'https://<PROJECT>.supabase.co/rest/v1/aeon_notes?select=*&limit=1' \
--        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
-- Expected: {"code":"42501", ... "permission denied for table aeon_notes"}
-- or run:  node tools/rls-canary.cjs
--
-- And no AEON table should still carry a non-service policy:
--   SELECT tablename, policyname, roles FROM pg_policies
--   WHERE schemaname = 'public' AND roles::text[] <> ARRAY['service_role']::text[];
