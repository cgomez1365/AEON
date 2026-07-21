-- Supabase Schema for AEON Cloud-to-Local Command Relay
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

-- 3. Row Level Security Policies
-- Since we use the service role key or API key from Vercel, we can allow authenticated/anon roles
-- to read and write rows for both tables.
CREATE POLICY "Allow read for all" ON desktop_commands
    FOR SELECT USING (true);

CREATE POLICY "Allow insert for all" ON desktop_commands
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow update for all" ON desktop_commands
    FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for bot_status" ON bot_status
    FOR ALL USING (true) WITH CHECK (true);
