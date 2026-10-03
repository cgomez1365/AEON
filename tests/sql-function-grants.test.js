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
 * or PROCEDURE, in any schema, with no REVOKE … FROM PUBLIC for it, and on a
 * SECURITY DEFINER one with no fixed search_path (written before or after its
 * body).
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

// Any schema (public, extensions, private, a quoted one, none), functions and
// procedures alike.
const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;
const CREATE_RE = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(function|procedure)\s+(?:${IDENT}\s*\.\s*)?"?([a-z_][a-z0-9_$]*)"?\s*\(`, 'gi');

/**
 * The statement that starts at `start`, through the ';' that ends it — a ';'
 * inside a dollar-quoted body ($$ … $$, $fn$ … $fn$) or a single-quoted body
 * (AS '…') does not end it. Returns the whole statement and the statement with
 * its body cut out, so SECURITY DEFINER or SET search_path written after the
 * body (`AS $$ … $$ LANGUAGE plpgsql SECURITY DEFINER;`) is still seen.
 */
function statementAt(text, start) {
  let i = start;
  let outside = '';
  let from = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$') {
      const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(text.slice(i));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        outside += text.slice(from, i);
        if (end < 0) return { stmt: text.slice(start), head: outside };
        i = end + tag[0].length; from = i;
        continue;
      }
    }
    if (ch === "'" && /\bas\s*$/i.test(text.slice(Math.max(start, i - 8), i))) {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      outside += text.slice(from, i);
      i = j + 1; from = i;
      continue;
    }
    if (ch === ';') return { stmt: text.slice(start, i + 1), head: outside + text.slice(from, i + 1) };
    i++;
  }
  return { stmt: text.slice(start), head: outside + text.slice(from) };
}

/** Every function or procedure a text creates: { file, kind, name, head, text } — head is the statement without its body. */
function routinesIn(text, file = '(inline)') {
  const out = [];
  for (const m of text.matchAll(CREATE_RE)) {
    const { head } = statementAt(text, m.index);
    out.push({ file, kind: m[1].toLowerCase(), name: m[2].toLowerCase(), head, text });
  }
  return out;
}

const functionsIn = (file) => routinesIn(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);

function revokedFromPublic(text, name, kind = 'function') {
  const re = new RegExp(String.raw`revoke\s+(?:all|execute)(?:\s+privileges)?\s+on\s+(?:function|procedure|routine)\s+(?:${IDENT}\s*\.\s*)?"?${name}"?\s*\([^;]*?\)\s+from\s+([^;]+);`, 'gi');
  for (const m of text.matchAll(re)) {
    if (/(^|[\s,])public($|[\s,])/i.test(m[1].replace(/['"]/g, ' '))) return true;
  }
  return false;
}

const definer = (f) => /security\s+definer/i.test(f.head);
const pinsSearchPath = (f) => /set\s+search_path\s*(=|to)/i.test(f.head);

const FOUND = CANDIDATES.flatMap(functionsIn);

describe('shipped SQL functions', () => {
  it('the scan sees the functions AEON ships (it is not passing by reading nothing)', () => {
    const names = FOUND.map((f) => `${f.file}:${f.name}`);
    expect(names).toContain('src/kernel/supabaseExecSql.cjs:exec_sql');
    expect(names).toContain('db/migrations/second_brain_chunks.sql:match_second_brain');
  });

  it.each(FOUND.map((f) => [`${f.file}: ${f.name}`, f]))('%s is revoked from PUBLIC', (_label, f) => {
    expect(revokedFromPublic(f.text, f.name),
      `${f.file} creates ${f.name}() without REVOKE … ON FUNCTION ${f.name}(…) FROM PUBLIC — Postgres grants EXECUTE to PUBLIC, which anon belongs to`).toBe(true);
  });

  it.each(FOUND.filter(definer).map((f) => [`${f.file}: ${f.name}`, f]))(
    '%s (SECURITY DEFINER) fixes its search_path', (_label, f) => {
      expect(pinsSearchPath(f), `${f.file}: ${f.name}() runs as its owner with the caller's search_path`).toBe(true);
    },
  );

  it('the exec_sql bootstrap grants EXECUTE to service_role, the only role AEON calls it with', () => {
    for (const f of FOUND.filter((x) => x.name === 'exec_sql')) {
      expect(f.text, f.file).toMatch(/grant\s+execute\s+on\s+function\s+(?:public\.)?exec_sql\s*\(\s*text\s*\)\s+to\s+service_role/i);
    }
  });

  it('the scan itself: any schema, procedures, and clauses written after the body', () => {
    const one = (sql) => routinesIn(sql)[0];
    expect(one('CREATE FUNCTION extensions.f(x int) RETURNS int AS $$ select 1; $$ LANGUAGE sql;').name).toBe('f');
    expect(one('create or replace function private."g"(x int) returns int as $$ select 1; $$ language sql;').name).toBe('g');
    expect(one('CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN NULL; END; $$;')).toMatchObject({ kind: 'procedure', name: 'p' });

    const after = one('CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1; END; $body$ LANGUAGE plpgsql SECURITY DEFINER;');
    expect(definer(after)).toBe(true);
    expect(pinsSearchPath(after)).toBe(false);
    expect(pinsSearchPath(one('CREATE FUNCTION f() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;'))).toBe(true);
    // A single-quoted body's ';' does not end the statement either.
    expect(definer(one("CREATE FUNCTION f() RETURNS int AS 'select 1; select 2' LANGUAGE sql SECURITY DEFINER;"))).toBe(true);
    // The body's own words are not the header's.
    expect(pinsSearchPath(one("CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE 'SET search_path = x'; END; $$ LANGUAGE plpgsql SECURITY DEFINER;"))).toBe(false);

    expect(revokedFromPublic('REVOKE ALL ON FUNCTION extensions.f(int) FROM PUBLIC;', 'f')).toBe(true);
    expect(revokedFromPublic('REVOKE ALL ON PROCEDURE p() FROM PUBLIC;', 'p')).toBe(true);
  });

  it('the revoke check itself: anon and authenticated alone are not PUBLIC', () => {
    expect(revokedFromPublic('REVOKE ALL ON FUNCTION exec_sql(text) FROM anon, authenticated;', 'exec_sql')).toBe(false);
    expect(revokedFromPublic('revoke all on function public.exec_sql(text) from public, anon, authenticated;', 'exec_sql')).toBe(true);
    expect(revokedFromPublic('REVOKE ALL ON FUNCTION other(text) FROM PUBLIC;', 'exec_sql')).toBe(false);
  });
});
