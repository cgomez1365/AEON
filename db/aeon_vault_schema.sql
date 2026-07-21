-- ============================================================
-- AEON Vault + Endpoint Registry — Supabase Schema
-- Run in Supabase SQL Editor. Enables the roaming (tablet/Vercel)
-- scenarios: the desktop mirrors the encrypted vault + endpoint
-- registry here so the cloud client can resolve models on the road.
-- ============================================================

-- 1. ENCRYPTED VAULT (singleton). Holds the AES-256-GCM blob ONLY.
--    The master key never lives here — it's a Vercel/desktop env var.
CREATE TABLE IF NOT EXISTS aeon_vault (
  id         INT          PRIMARY KEY DEFAULT 1,
  blob       JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- { v, iv, tag, data }
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);
INSERT INTO aeon_vault (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE aeon_vault ENABLE ROW LEVEL SECURITY;

-- Only the service role (desktop kernel + Vercel server functions with the
-- service key) may touch the vault. NEVER expose to the anon role — the blob
-- is encrypted, but defense in depth keeps even ciphertext off public reads.
CREATE POLICY "service_all_vault" ON aeon_vault
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. ENDPOINT REGISTRY (singleton). Connection metadata — safe, no raw keys.
CREATE TABLE IF NOT EXISTS aeon_endpoints (
  id         INT          PRIMARY KEY DEFAULT 1,
  registry   JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- { endpoints:[], roles:{} }
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);
INSERT INTO aeon_endpoints (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE aeon_endpoints ENABLE ROW LEVEL SECURITY;

-- Registry holds no secrets, so the roaming client may READ it with anon,
-- but only the service role may WRITE (desktop is the source of truth).
CREATE POLICY "anon_read_endpoints" ON aeon_endpoints
  FOR SELECT TO anon USING (true);
CREATE POLICY "service_write_endpoints" ON aeon_endpoints
  FOR ALL TO service_role USING (true) WITH CHECK (true);
