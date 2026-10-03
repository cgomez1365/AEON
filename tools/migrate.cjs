#!/usr/bin/env node
/**
 * AEON Migration Runner — applies db/migrations/*.sql in order, tracks state.
 *
 * Supabase has no first-class migration CLI wired into AEON, so this gives us
 * versioned, idempotent schema changes with a recorded ledger. It records every
 * applied file in a `schema_migrations` table so re-runs skip completed ones.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY and an `exec_sql(sql text)`
 * RPC in the database (one-time bootstrap below). Without the RPC, it prints the
 * SQL for manual application in the Supabase SQL Editor (safe default — no
 * silent failures, per R-05).
 *
 * Usage:
 *   node tools/migrate.cjs            # apply pending
 *   node tools/migrate.cjs --status   # list applied vs pending
 *   node tools/migrate.cjs --print    # print pending SQL (manual mode)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// One text for the bootstrap and the grants, shared with Settings → Cloud:
// src/kernel/supabaseExecSql.cjs (audit #1, 2026-10-03).
const execSql = require('../src/kernel/supabaseExecSql.cjs');
const BOOTSTRAP_RPC = `-- Run ONCE in Supabase SQL Editor to enable automated migrations:\n${execSql.BOOTSTRAP_SQL}`;

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

async function main() {
  const arg = process.argv[2];
  const files = listMigrations();

  if (arg === '--print' || !url || !key) {
    if (!url || !key) console.error('[migrate] SUPABASE_URL / SERVICE_ROLE_KEY not set — manual mode.\n');
    console.log('-- Apply these in Supabase → SQL Editor, in order:\n');
    for (const f of files) {
      console.log(`-- ===== ${f} =====`);
      console.log(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
    console.log(`\n-- (Optional) enable automated runs:\n${BOOTSTRAP_RPC}`);
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(url, key);

  // Ensure ledger table.
  const ensure = `create table if not exists public.schema_migrations (
    filename text primary key, applied_at timestamptz default now());`;
  const run = async (sql) => {
    const { error } = await db.rpc('exec_sql', { sql });
    if (error) throw new Error(error.message);
  };

  // exec_sql is locked to the service role before anything runs through it:
  // a project bootstrapped with the text printed here before 2026-10-03 has
  // an exec_sql anyone with the anon key can call, and this closes it.
  const lock = await execSql.lockDown(db);
  if (!lock.ok && lock.missing) {
    console.error(`[migrate] exec_sql RPC missing. Bootstrap it once:\n\n${BOOTSTRAP_RPC}\n`);
    console.error('Then re-run, or use: node tools/migrate.cjs --print');
    process.exit(1);
  }
  if (!lock.ok) {
    console.error(`[migrate] exec_sql could not be locked to the service role (${lock.error}). Nothing was applied.`);
    console.error(`Run this in Supabase SQL Editor, then re-run:\n\n${execSql.LOCKDOWN_SQL}\n`);
    process.exit(1);
  }
  console.log(`[migrate] ${execSql.LOCKED_NOTE}`);

  try {
    await run(ensure);
  } catch (e) {
    console.error(`[migrate] could not create schema_migrations: ${e.message}`);
    process.exit(1);
  }

  const { data: applied } = await db.from('schema_migrations').select('filename');
  const done = new Set((applied || []).map((r) => r.filename));

  if (arg === '--status') {
    for (const f of files) console.log(`${done.has(f) ? '✓ applied ' : '· pending '} ${f}`);
    return;
  }

  let count = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    console.log(`[migrate] applying ${f} ...`);
    await run(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.from('schema_migrations').insert({ filename: f });
    count++;
  }
  console.log(count ? `[migrate] applied ${count} migration(s).` : '[migrate] up to date.');
}

main().catch((e) => { console.error('[migrate] failed:', e.message); process.exit(1); });
