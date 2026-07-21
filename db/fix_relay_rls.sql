-- ============================================================
-- FIX: Cloud relay RLS — anon inserts into desktop_commands are
-- being rejected (verified 401 code 42501 on 2026-07-11), which
-- breaks /vp and all relayed commands from the Vercel terminal.
-- Copy-paste into Supabase → SQL Editor → Run. Safe to re-run.
-- ============================================================

-- Re-apply relay policies explicitly for anon + authenticated
DROP POLICY IF EXISTS "Allow read for all"   ON desktop_commands;
DROP POLICY IF EXISTS "Allow insert for all" ON desktop_commands;
DROP POLICY IF EXISTS "Allow update for all" ON desktop_commands;

CREATE POLICY "relay_select" ON desktop_commands
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "relay_insert" ON desktop_commands
  FOR INSERT TO anon, authenticated, service_role WITH CHECK (true);
CREATE POLICY "relay_update" ON desktop_commands
  FOR UPDATE TO anon, authenticated, service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for bot_status" ON bot_status;
CREATE POLICY "bot_status_read" ON bot_status
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "bot_status_write" ON bot_status
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Bridge v2 pushes these columns; add if the table predates them
ALTER TABLE bot_status ADD COLUMN IF NOT EXISTS positions   JSONB   DEFAULT '[]'::jsonb;
ALTER TABLE bot_status ADD COLUMN IF NOT EXISTS session_pnl NUMERIC DEFAULT 0;
