-- AEON Second Brain Sync Schema for Supabase
-- ===========================================================================
-- Server-side only. AEON reaches this table from its SERVER with the Supabase
-- SERVICE ROLE key, which bypasses Row Level Security. RLS is ON and there are
-- NO policies and NO anon/authenticated grants (db/migrations/002_lock_down_anon.sql
-- revokes them), so the public anon key can neither read nor write anything here.
-- A policy with no TO clause applies to PUBLIC, which includes anon, whatever the
-- policy is NAMED. (Audit 2026-10-04: five of these files did exactly that.)
-- ===========================================================================
-- This schema establishes the dual source of truth for the RAG terminal and cloud visualizer.

CREATE TABLE IF NOT EXISTS public.aeon_notes (
    filepath TEXT PRIMARY KEY,           -- The unique absolute or relative path to the file
    filename TEXT NOT NULL,              -- E.g. "Quantum_Physics.md"
    content TEXT NOT NULL,               -- The full body of the markdown file for RAG embedding
    category TEXT NOT NULL,              -- E.g. "Projects", "Reading_Library", "Master_Memory"
    last_modified_local TIMESTAMP WITH TIME ZONE, -- When it was last saved on the physical hard drive
    last_modified_cloud TIMESTAMP WITH TIME ZONE DEFAULT NOW() -- When it was synced to Supabase
);

-- RLS on, no policies: only the server's service role can touch this table.
ALTER TABLE public.aeon_notes ENABLE ROW LEVEL SECURITY;

-- Create a table specifically for Semantic Subjects (The Secretary Bot's taxonomy)
CREATE TABLE IF NOT EXISTS public.aeon_subjects (
    subject_name TEXT PRIMARY KEY,       -- E.g. "Philosophy", "HR"
    description TEXT,                    -- TinyLlama's summary of the subject
    total_links INTEGER DEFAULT 0        -- How many files are tagged with this subject
);

ALTER TABLE public.aeon_subjects ENABLE ROW LEVEL SECURITY;

-- Create a sync metadata table to track the last global sync event
CREATE TABLE IF NOT EXISTS public.aeon_sync_state (
    id TEXT PRIMARY KEY,
    last_sync_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    pending_cloud_notes INTEGER DEFAULT 0
);

INSERT INTO public.aeon_sync_state (id, last_sync_timestamp, pending_cloud_notes)
VALUES ('global_sync', NOW(), 0)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.aeon_sync_state ENABLE ROW LEVEL SECURITY;
