/**
 * No shipped SQL may open an AEON table to anon, authenticated or PUBLIC
 * (audit 2026-10-04).
 *
 * The earlier schemas carried policies such as
 *     CREATE POLICY "Allow service role full access" ON aeon_notes FOR ALL USING (true);
 * A policy with no TO clause applies to PUBLIC — which includes the `anon` role
 * whose key ships in every browser app — so the NAME ("service role") changed
 * nothing: anyone holding the anon key could read and write notes, governance,
 * block data and the relay's command queue. Verified on real Postgres with
 * Supabase-style roles: 9 of 10 AEON tables anon-readable, 6 anon-writable.
 * 001_enable_rls.sql did not close it (permissive policies are OR-ed; it never
 * dropped them) and added `authed_all` for `authenticated`, a role anyone can
 * join by signing up on a project with sign-ups enabled.
 *
 * AEON's server uses the service role key, which bypasses RLS, so the only
 * access a policy may grant is to service_role. This reads every tracked
 * db/**.sql and fails on:
 *   - a CREATE POLICY with no TO clause, or a TO that names anything but service_role;
 *   - a GRANT to anon, authenticated or PUBLIC;
 *   - a CREATE TABLE with no ENABLE ROW LEVEL SECURITY anywhere in db/;
 *   - a created table missing from the lockdown migration's list, so existing
 *     projects would keep a table 002 never touches;
 *   - the wizard (Settings → Cloud) not applying 002 last.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlFiles = execFileSync('git', ['ls-files', 'db'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.sql'));

/** SQL with line and block comments removed (the header comments quote the bad pattern). */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

/** Problems in one chunk of SQL text; empty = clean. Exported shape is tested below. */
export function policyProblems(sql) {
  const out = [];
  const body = code(sql);
  for (const m of body.matchAll(/CREATE\s+POLICY\s+("[^"]+"|\w+)\s+ON\s+([\w."]+)([^;]*);/gi)) {
    const [, name, table, rest] = m;
    const to = /\bTO\s+([\w"]+(?:\s*,\s*[\w"]+)*)/i.exec(rest);
    if (!to) { out.push(`${name} on ${table}: no TO clause — applies to PUBLIC, which includes anon`); continue; }
    const roles = to[1].split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase());
    const bad = roles.filter((r) => r !== 'service_role');
    if (bad.length) out.push(`${name} on ${table}: TO ${bad.join(', ')} — only service_role may be granted access`);
  }
  for (const m of body.matchAll(/\bGRANT\b[^;]*?\bTO\s+([^;]+);/gi)) {
    const to = m[1].split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase());
    const bad = to.filter((r) => ['anon', 'authenticated', 'public'].includes(r));
    if (bad.length) out.push(`GRANT to ${bad.join(', ')}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  return out;
}

describe('the policy linter itself', () => {
  it('flags a policy with no TO clause (the audited pattern), whatever it is named', () => {
    expect(policyProblems('CREATE POLICY "Allow service role full access" ON public.aeon_notes FOR ALL USING (true);')).toHaveLength(1);
  });
  it('flags anon, authenticated and public', () => {
    for (const r of ['anon', 'authenticated', 'public', 'service_role, anon']) {
      expect(policyProblems(`CREATE POLICY p ON t FOR SELECT TO ${r} USING (true);`).length, r).toBeGreaterThan(0);
    }
  });
  it('flags a GRANT to anon / authenticated / PUBLIC', () => {
    expect(policyProblems('GRANT SELECT ON aeon_notes TO anon;')).toHaveLength(1);
    expect(policyProblems('GRANT ALL ON TABLE t TO authenticated, service_role;')).toHaveLength(1);
  });
  it('accepts service_role only, and ignores policies quoted inside comments', () => {
    expect(policyProblems('CREATE POLICY p ON t FOR ALL TO service_role USING (true) WITH CHECK (true);')).toEqual([]);
    expect(policyProblems('-- CREATE POLICY bad ON t FOR ALL USING (true);\n/* CREATE POLICY bad2 ON t FOR ALL USING (true); */')).toEqual([]);
    expect(policyProblems('GRANT EXECUTE ON FUNCTION f() TO service_role;')).toEqual([]);
  });
});

describe('the SQL AEON ships', () => {
  it('has SQL to check', () => { expect(sqlFiles.length).toBeGreaterThan(5); });

  it('grants no table access to anon, authenticated or PUBLIC', () => {
    const problems = sqlFiles.flatMap((f) => policyProblems(fs.readFileSync(path.join(ROOT, f), 'utf8')).map((p) => `${f}: ${p}`));
    expect(problems).toEqual([]);
  });

  it('enables Row Level Security on every table it creates', () => {
    const all = sqlFiles.map((f) => code(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n');
    const created = [...all.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)].map((m) => m[1].toLowerCase());
    expect(created.length).toBeGreaterThan(5);
    const unprotected = created.filter((t) => !new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?"?${t}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(all));
    expect(unprotected).toEqual([]);
  });

  it('lists every created table in the lockdown migration, so existing projects are covered too', () => {
    const lock = code(fs.readFileSync(path.join(ROOT, 'db/migrations/002_lock_down_anon.sql'), 'utf8'));
    const listed = new Set([...lock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const all = sqlFiles.filter((f) => !f.endsWith('002_lock_down_anon.sql')).map((f) => code(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n');
    const created = [...all.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi)].map((m) => m[1].toLowerCase());
    expect(created.filter((t) => !listed.has(t))).toEqual([]);
  });

  it('002 drops every non-service policy and revokes anon and authenticated', () => {
    const lock = code(fs.readFileSync(path.join(ROOT, 'db/migrations/002_lock_down_anon.sql'), 'utf8'));
    expect(lock).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(lock).toMatch(/DROP POLICY/);
    expect(lock).toMatch(/<> ARRAY\['service_role'\]/);
    for (const role of ['PUBLIC', 'anon', 'authenticated']) expect(lock).toMatch(new RegExp(`REVOKE ALL ON TABLE[^;]*FROM ${role}`));
  });

  it('the Settings → Cloud wizard applies only files that exist, and applies 002 last', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/settings/api/connectivity.js'), 'utf8');
    const list = /const schemas = \[([\s\S]*?)\];/.exec(src);
    expect(list).toBeTruthy();
    const files = [...list[1].matchAll(/'([^']+\.sql)'/g)].map((m) => m[1]);
    for (const f of files) expect(fs.existsSync(path.join(ROOT, 'db', f)), f).toBe(true);
    expect(files[files.length - 1]).toBe('migrations/002_lock_down_anon.sql');
  });
});
