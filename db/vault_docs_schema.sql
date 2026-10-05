-- ============================================================
-- AEON Cloud Vault — Supabase Schema
-- Copy-paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run (IF NOT EXISTS everywhere).
-- ============================================================

-- VAULT DOCS — Second Brain documents mirrored to your Supabase by the AEON
-- server (src/blocks/aeon_matrix/api/cloudvault.cjs, service role).
-- This table holds the TEXT of your documents. It used to be anon-readable
-- ("anon_read_vault_docs", for a browser terminal that no longer exists), which
-- put every mirrored document one public key away from anyone. Server only now.
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

-- Remove the old anon policy if an earlier version of this file created it.
DROP POLICY IF EXISTS "anon_read_vault_docs" ON vault_docs;

DROP POLICY IF EXISTS "service_write_vault_docs" ON vault_docs;
CREATE POLICY "service_write_vault_docs" ON vault_docs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
