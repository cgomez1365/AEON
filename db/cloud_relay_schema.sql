-- Supabase Schema for AEON Cloud-to-Local Command Relay
-- ===========================================================================
-- Server-side only. AEON reaches this table from its SERVER with the Supabase
-- SERVICE ROLE key, which bypasses Row Level Security. RLS is ON and there are
-- NO policies and NO anon/authenticated grants (db/migrations/002_lock_down_anon.sql
-- revokes them), so the public anon key can neither read nor write anything here.
-- A policy with no TO clause applies to PUBLIC, which includes anon, whatever the
-- policy is NAMED. (Audit 2026-10-04: five of these files did exactly that.)
-- ===========================================================================
-- Run this in your Supabase SQL Editor.

-- 1. Table for enqueuing commands from the web frontend (Vercel)
CREATE TABLE IF NOT EXISTS desktop_commands (
    id BIGSERIAL PRIMARY KEY,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    output TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index for fast polling of pending commands by the desktop bridge daemon
CREATE INDEX IF NOT EXISTS idx_desktop_commands_pending 
ON desktop_commands (created_at ASC) 
WHERE status = 'pending';

-- 2. Table for mirroring the local bot status
CREATE TABLE IF NOT EXISTS bot_status (
    id INT PRIMARY KEY DEFAULT 1,
    is_running BOOLEAN NOT NULL DEFAULT false,
    usd_balance NUMERIC NOT NULL DEFAULT 0,
    mode TEXT,
    pid INT,
    log TEXT[] DEFAULT '{}'::text[],
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT check_single_row CHECK (id = 1)
);

-- Enable Row Level Security (RLS)
ALTER TABLE desktop_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_status ENABLE ROW LEVEL SECURITY;

-- 3. Access: server only.
-- This schema used to open both tables to anon ("Allow insert for all" on
-- desktop_commands, whose `command` column a desktop daemon polls) so a browser
-- terminal could enqueue commands with the public anon key. That let anyone
-- holding the anon key queue commands for your desktop and read their output.
-- The relay is now server-side only: enqueue and poll with the SERVICE ROLE key
-- from a server you control. No anon or authenticated policies exist.
