-- Run this in your Supabase SQL Editor to create the Governance state table
-- ===========================================================================
-- Server-side only. AEON reaches this table from its SERVER with the Supabase
-- SERVICE ROLE key, which bypasses Row Level Security. RLS is ON and there are
-- NO policies and NO anon/authenticated grants (db/migrations/002_lock_down_anon.sql
-- revokes them), so the public anon key can neither read nor write anything here.
-- A policy with no TO clause applies to PUBLIC, which includes anon, whatever the
-- policy is NAMED. (Audit 2026-10-04: five of these files did exactly that.)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.aeon_governance (
    id TEXT PRIMARY KEY,
    daily_tokens BIGINT DEFAULT 0,
    daily_cost_usd NUMERIC DEFAULT 0.0,
    last_reset_date DATE DEFAULT CURRENT_DATE,
    is_throttled BOOLEAN DEFAULT false
);

-- Insert the single configuration row used by the system
INSERT INTO public.aeon_governance (id, daily_tokens, daily_cost_usd, last_reset_date, is_throttled)
VALUES ('global_state', 0, 0.0, CURRENT_DATE, false)
ON CONFLICT (id) DO NOTHING;

-- RLS on, no policies: only the server's service role can touch this table.
ALTER TABLE public.aeon_governance ENABLE ROW LEVEL SECURITY;
