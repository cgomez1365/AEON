-- Run this in your Supabase SQL Editor to create the Governance state table

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

-- Set up Row Level Security (RLS) - Safe defaults since this is server-side only
ALTER TABLE public.aeon_governance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access" ON public.aeon_governance FOR ALL USING (true);
