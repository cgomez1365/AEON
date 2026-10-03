/**
 * Every SQL function AEON ships is revoked from PUBLIC (audit #1, 2026-10-03).
 *
 * The exec_sql bootstrap that Settings → Cloud and tools/migrate.cjs tell the
 * operator to paste into Supabase revoked EXECUTE from `anon, authenticated`
 * only. Postgres grants EXECUTE on every new function to PUBLIC, and both of
 * those roles are members of PUBLIC, so the revoke changed nothing: with the
 * public anon key, `exec_sql('drop table public.aeon_vault')` ran (reproduced
 * on Postgres 17.5 with Supabase-style roles).
 *
 * This reads every tracked file that can carry SQL for the operator to run —
 * db/ files and the bootstrap strings in code — and fails on a CREATE FUNCTION
 * with no REVOKE … FROM PUBLIC for it, and on a SECURITY DEFINER function with
 * no fixed search_path.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

// Where SQL can ship: .sql files, and SQL written inside code or docs. Tests
// (this one included) and vendored bundles are not shipped SQL.
const CANDIDATES = tracked.filter((f) => /\.(sql|c?js|mjs|md)$/i.test(f)
  && !f.startsWith('tests/') && !f.includes('/vendor/') && !f.startsWith('node_modules/'));

const CREATE_RE = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;

/** Every function a file creates: { file, name, head } — head runs to the body's opening quote. */
function functionsIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  for (const m of text.matchAll(CREATE_RE)) {
    const rest = text.slice(m.index);
    const bodyAt = rest.search(/\bas\s+\$/i);
    out.push({ file, name: m[1].toLowerCase(), head: bodyAt > 0 ? rest.slice(0, bodyAt) : rest.slice(0, 600), text });
  }
  return out;
}

function revokedFromPublic(text, name) {
  const re = new RegExp(`revoke\\s+(?:all|execute)(?:\\s+privileges)?\\s+on\\s+function\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\([^;]*?\\)\\s+from\\s+([^;]+);`, 'gi');
  for (const m of text.matchAll(re)) {
    if (/(^|[\s,])public($|[\s,])/i.test(m[1].replace(/['"]/g, ' '))) return true;
  }
  return false;
}

const FOUND = CANDIDATES.flatMap(functionsIn);

describe('shipped SQL functions', () => {
  it('the scan sees the functions AEON ships (it is not passing by reading nothing)', () => {
    const names = FOUND.map((f) => `${f.file}:${f.name}`);
    expect(names).toContain('src/blocks/settings/api/connectivity.js:exec_sql');
    expect(names).toContain('tools/migrate.cjs:exec_sql');
    expect(names).toContain('db/migrations/second_brain_chunks.sql:match_second_brain');
  });

  it.each(FOUND.map((f) => [`${f.file}: ${f.name}`, f]))('%s is revoked from PUBLIC', (_label, f) => {
    expect(revokedFromPublic(f.text, f.name),
      `${f.file} creates ${f.name}() without REVOKE … ON FUNCTION ${f.name}(…) FROM PUBLIC — Postgres grants EXECUTE to PUBLIC, which anon belongs to`).toBe(true);
  });

  it.each(FOUND.filter((f) => /security\s+definer/i.test(f.head)).map((f) => [`${f.file}: ${f.name}`, f]))(
    '%s (SECURITY DEFINER) fixes its search_path', (_label, f) => {
      expect(/set\s+search_path\s*(=|to)/i.test(f.head), `${f.file}: ${f.name}() runs as its owner with the caller's search_path`).toBe(true);
    },
  );

  it('the exec_sql bootstrap grants EXECUTE to service_role, the only role AEON calls it with', () => {
    for (const f of FOUND.filter((x) => x.name === 'exec_sql')) {
      expect(f.text, f.file).toMatch(/grant\s+execute\s+on\s+function\s+(?:public\.)?exec_sql\s*\(\s*text\s*\)\s+to\s+service_role/i);
    }
  });

  it('the revoke check itself: anon and authenticated alone are not PUBLIC', () => {
    expect(revokedFromPublic('REVOKE ALL ON FUNCTION exec_sql(text) FROM anon, authenticated;', 'exec_sql')).toBe(false);
    expect(revokedFromPublic('revoke all on function public.exec_sql(text) from public, anon, authenticated;', 'exec_sql')).toBe(true);
    expect(revokedFromPublic('REVOKE ALL ON FUNCTION other(text) FROM PUBLIC;', 'exec_sql')).toBe(false);
  });
});
