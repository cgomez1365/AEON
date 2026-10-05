-- Second Brain Chunks — vector index for chat history + documents
-- Run in Supabase SQL Editor ONCE

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Main chunks table
CREATE TABLE IF NOT EXISTS second_brain_chunks (
  chunk_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('chat', 'document')),
  source_id   TEXT NOT NULL,
  created_ms  BIGINT NOT NULL,
  text        TEXT NOT NULL,
  embedding   vector(768),
  metadata    JSONB DEFAULT '{}'
);

-- Vector similarity index (cosine)
CREATE INDEX IF NOT EXISTS idx_sb_chunks_embedding
  ON second_brain_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Fast source lookups
CREATE INDEX IF NOT EXISTS idx_sb_chunks_source
  ON second_brain_chunks (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_sb_chunks_ts
  ON second_brain_chunks (created_ms DESC);

-- RLS
ALTER TABLE second_brain_chunks ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS; no policy is needed. (A policy named "service_role_all" with no
-- TO clause used to be created here: it applied to PUBLIC, i.e. to anon. See audit 2026-10-04.)

-- Similarity search function (called from API)
CREATE OR REPLACE FUNCTION match_second_brain(
  query_embedding vector(768),
  match_count     INT DEFAULT 5,
  source_filter   TEXT DEFAULT NULL
)
RETURNS TABLE (
  chunk_id    UUID,
  source_type TEXT,
  source_id   TEXT,
  created_ms  BIGINT,
  text        TEXT,
  metadata    JSONB,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.chunk_id,
    c.source_type,
    c.source_id,
    c.created_ms,
    c.text,
    c.metadata,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM second_brain_chunks c
  WHERE (source_filter IS NULL OR c.source_type = source_filter)
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC (anon and authenticated
-- included). Nothing in AEON calls it today; only the service role may.
REVOKE ALL ON FUNCTION match_second_brain(vector, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_second_brain(vector, INT, TEXT) TO service_role;
