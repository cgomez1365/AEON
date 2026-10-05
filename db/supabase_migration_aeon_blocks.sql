-- AEON 2-Way Sync: Generic Block Storage Table
-- Run this in Supabase SQL Editor to create the aeon_blocks table.
-- ===========================================================================
-- Server-side only. AEON reaches this table from its SERVER with the Supabase
-- SERVICE ROLE key, which bypasses Row Level Security. RLS is ON and there are
-- NO policies and NO anon/authenticated grants (db/migrations/002_lock_down_anon.sql
-- revokes them), so the public anon key can neither read nor write anything here.
-- A policy with no TO clause applies to PUBLIC, which includes anon, whatever the
-- policy is NAMED. (Audit 2026-10-04: five of these files did exactly that.)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS aeon_blocks (
  block_tag TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE aeon_blocks ENABLE ROW LEVEL SECURITY;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_aeon_blocks_tag ON aeon_blocks (block_tag);
