-- =====================================================================
-- AEON MIGRATION 001 — ENABLE ROW LEVEL SECURITY (CONTAINMENT + RESTORE)
-- Ref: docs/AEON-SECURITY-HANDOFF.md
-- Run in: Supabase → SQL Editor → New query
-- Idempotent: safe to run more than once.
--
-- Model: server-boundary (Path B). The browser must NOT read these tables
-- directly with the anon key. All privileged access goes through the server
-- using the service_role key (which bypasses RLS). The `TO authenticated`
-- policies are a forward path for when/if Supabase Auth sessions exist.
-- NEVER add `USING (true)` for the anon/public role on a sensitive table.
-- =====================================================================

-- ── STAGE 1: CONTAIN — enable RLS on every table (default = deny-all) ──
ALTER TABLE public.aeon_candidates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.desktop_commands      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_status            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_blocks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_notes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_governance       ENABLE ROW LEVEL SECURITY;
-- Belt-and-suspenders on the tables that tested green (empty != protected):
ALTER TABLE public.aeon_audit_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_chat_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_sandbox          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aeon_terminal_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state             ENABLE ROW LEVEL SECURITY;

-- ── STAGE 2: RESTORE — authenticated-only access (anon stays denied) ──
-- service_role bypasses RLS entirely, so the server keeps full access with
-- no policy needed. These policies only matter if you adopt Supabase Auth.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'aeon_candidates','desktop_commands','bot_status','aeon_blocks',
    'documents','aeon_notes','aeon_governance','aeon_audit_log',
    'aeon_chat_log','aeon_sandbox','aeon_terminal_history','app_state'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS authed_all ON public.%I;', t);
    EXECUTE format(
      'CREATE POLICY authed_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t
    );
  END LOOP;
END $$;

-- ── VERIFY (run after) ──
-- Anonymous read must return NOTHING on every sensitive table.
-- Use docs/AEON-SECURITY-HANDOFF.md §3a (aeon-rls-test.html) or:
--   curl -s 'https://<PROJECT>.supabase.co/rest/v1/aeon_candidates?select=*' \
--        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
-- Expected: []  (empty array) or a permission error — never rows.
