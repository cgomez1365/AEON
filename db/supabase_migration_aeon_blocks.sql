-- AEON 2-Way Sync: Generic Block Storage Table
-- Run this in Supabase SQL Editor to create the aeon_blocks table

CREATE TABLE IF NOT EXISTS aeon_blocks (
  block_tag TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE aeon_blocks ENABLE ROW LEVEL SECURITY;

-- Allow authenticated and anon users full access (matches existing AEON pattern)
CREATE POLICY "aeon_blocks_all" ON aeon_blocks
  FOR ALL USING (true) WITH CHECK (true);

-- Seed rows for all blocks so upserts work immediately
INSERT INTO aeon_blocks (block_tag, payload) VALUES
  ('inventory', '[]'::jsonb),
  ('clients', '[]'::jsonb),
  ('scheduler', '{"events":[],"workouts":[],"deadlines":[]}'::jsonb),
  ('staff', '[]'::jsonb),
  ('hr_arsenal', '[]'::jsonb),
  ('logistics', '[]'::jsonb)
ON CONFLICT (block_tag) DO NOTHING;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_aeon_blocks_tag ON aeon_blocks (block_tag);
