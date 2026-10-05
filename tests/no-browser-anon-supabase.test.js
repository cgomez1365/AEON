/**
 * The browser never talks to Supabase's table API with the anon key (audit 2026-10-04).
 *
 * Several screens (Deep Research, Activity, Dashboard, the Second Brain
 * visualizer, and the legacy clients/inventory/scheduler context) used to read
 * and WRITE the cloud tables straight from the browser:
 *     fetch(`${VITE_SUPABASE_URL}/rest/v1/aeon_blocks…`, { apikey: anon })
 * That only works if the tables answer the public key, which is what made the
 * old policies necessary — and put research history, document text and client
 * records one key away from anyone. Cloud sync is the SERVER's job (service role,
 * /api/sync); the tables now answer the anon key with a refusal, so any browser
 * code still calling them would fail silently.
 *
 * What stays: src/kernel/supabase.js builds the client the Files block uses for
 * Supabase STORAGE (a bucket with its own policies, not these tables), and the
 * Settings server code probes a key's validity. Both are listed below.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(js|jsx)$/.test(f));

const ALLOWED = new Set([
  'src/kernel/supabase.js',                    // the Files block's Supabase Storage client
  'src/blocks/settings/api/connectivity.js',   // server: tests whether a key is valid
  'src/blocks/settings/api/settings.js',       // server: same
]);

describe('no browser path reads or writes Supabase tables with the anon key', () => {
  it('has source to scan', () => { expect(files.length).toBeGreaterThan(50); });

  it('no REST call to /rest/v1/ and no VITE_SUPABASE_ANON_KEY outside the allowlist', () => {
    const hits = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      if (/\/rest\/v1\//.test(s)) hits.push(`${f}: calls /rest/v1/`);
      if (/VITE_SUPABASE_ANON_KEY/.test(s)) hits.push(`${f}: reads VITE_SUPABASE_ANON_KEY`);
    }
    expect(hits).toEqual([]);
  });

  it('the legacy table mirror and the shared anon key export are gone', () => {
    const ctx = fs.readFileSync(path.join(ROOT, 'src/kernel/contexts/AeonContext.jsx'), 'utf8');
    expect(ctx).not.toMatch(/mirrorToSupabase/);
    const cfg = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
    expect(cfg).not.toMatch(/SB_KEY|SB_URL/);
  });
});
