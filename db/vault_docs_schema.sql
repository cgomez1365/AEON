-- ============================================================
-- AEON Cloud Vault + VP Feed — Supabase Schema
-- Copy-paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run (IF NOT EXISTS everywhere).
-- ============================================================

-- 1. VAULT DOCS — Second Brain documents mirrored to the cloud so the
--    Vercel Command Center has full visibility on the go.
CREATE TABLE IF NOT EXISTS vault_docs (
  path       TEXT PRIMARY KEY,          -- Vault-relative path (citation key)
  title      TEXT,
  summary    TEXT,
  content    TEXT,                      -- extracted text, capped at 20k chars
  tags       TEXT[] DEFAULT '{}',
  hash       TEXT,                      -- change detection for incremental push
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE vault_docs ENABLE ROW LEVEL SECURITY;

-- Anon may READ (the Vercel frontend uses the anon key); only the desktop
-- (service role) may write — desktop is the source of truth.
DROP POLICY IF EXISTS "anon_read_vault_docs" ON vault_docs;
CREATE POLICY "anon_read_vault_docs" ON vault_docs
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "service_write_vault_docs" ON vault_docs;
CREATE POLICY "service_write_vault_docs" ON vault_docs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. VP FEED — VP mission progress stream, readable from anywhere.
--    Every notify() the agent emits lands here; the Vercel terminal
--    polls it so you get updates on the go.
CREATE TABLE IF NOT EXISTS vp_feed (
  id         BIGSERIAL PRIMARY KEY,
  mission_id TEXT,
  status     TEXT,
  message    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE vp_feed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_vp_feed" ON vp_feed;
CREATE POLICY "anon_read_vp_feed" ON vp_feed
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS "service_write_vp_feed" ON vp_feed;
CREATE POLICY "service_write_vp_feed" ON vp_feed
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS vp_feed_created_idx ON vp_feed (created_at DESC);
