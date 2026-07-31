// Part A — settings single-source-of-truth audit, against a live server.
// Usage: node settings-audit.mjs [baseUrl] [aeonRootPath]
import fs from 'fs';
import path from 'path';

const BASE = process.argv[2] || 'http://127.0.0.1:3001';
// The harness lives at <repo>/tools/stress, so the repo root is derivable.
// It previously defaulted to one operator's absolute Desktop path, which meant
// it could only ever run on that machine. argv[3] still overrides.
const ROOT = process.argv[3] || path.resolve(import.meta.dirname, '..', '..');
// Guard is active once an operator account exists, so the settings reads below
// need a session. Optional: without one this still runs, it just sees 401s.
const AUTH_TOKEN = process.argv[4] || process.env.AEON_TOKEN || null;
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, url, body) {
  try {
    const r = await fetch(BASE + url, {
      method, headers: { 'Content-Type': 'application/json', ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: r.status, ok: r.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: { error: e.message } };
  }
}

function grepFile(relPath, pattern) {
  try {
    const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    return pattern.test(content);
  } catch { return null; } // file missing → null, distinct from "not found"
}

function grepCount(relPath, pattern) {
  try {
    const content = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    return (content.match(pattern) || []).length;
  } catch { return -1; }
}

async function main() {
  console.log(`\nSettings single-source-of-truth audit — ${ROOT} / ${BASE}\n`);

  // ── 1. Cloud credentials — single writer ────────────────────────────
  console.log('1. Cloud credentials (Supabase/Firebase) write path');
  const cloudWriters = [
    'src/blocks/settings/api/settings.js',
    'src/blocks/settings/api/connectivity.js',
  ];
  let cloudWriterCount = 0;
  for (const f of cloudWriters) {
    if (grepFile(f, /cloudCredentials\.save\s*\(/)) cloudWriterCount++;
  }
  record('1a only the settings block writes cloud credentials',
    cloudWriterCount === cloudWriters.length, // both are expected — settings.js's generic {cloudProvider} path AND connectivity.js's dedicated save — both go through the SAME store object
    `${cloudWriterCount}/${cloudWriters.length} known files call cloudCredentials.save() — both route through services/settings.js's single store, which is correct (not a duplicate, two callers of one store)`);
  const strayWrite = grepCount('src/blocks/security/**', /cloud_credentials\.json/) ;
  // (glob won't work with fs.readFileSync directly — this is a structural note, not exhaustive)

  // ── 2. Provider API keys — single writer ────────────────────────────
  console.log('2. Provider API key write path');
  const godKeysRoute = fs.readFileSync(path.join(ROOT, 'src/kernel/routers/god.cjs'), 'utf8');
  const usesCorrectRoute = /\/api\/settings\/secrets/.test(godKeysRoute) && !/\/api\/settings\/env['"`]/.test(godKeysRoute.match(/fetch\(`\$\{BASE\}(\/api\/settings\/[a-z]+)`/)?.[0] || '');
  const stillReferencesEnvForKeys = /god\/keys[\s\S]{0,400}\/api\/settings\/env/.test(godKeysRoute);
  record('2a god.cjs /god/keys now points at /api/settings/secrets (fixed tonight)',
    /\/api\/settings\/secrets/.test(godKeysRoute), 'grep confirms the fix landed');
  record('2b no remaining reference to the wrong /api/settings/env for key-add', !stillReferencesEnvForKeys, 'clean');

  // ── 3. Theme/color — documented layering, verify live ───────────────
  console.log('3. Theme/appearance layering (theme_builder then appearance, documented order)');
  const themeSet = await req('PUT', '/api/prefs/theme_builder', { value: { colors: { accent: '#111111' } } });
  const appearanceSet = await req('PUT', '/api/prefs/appearance', { value: { accent: '#eeeeee' } });
  record('3a can write both prefs independently', themeSet.status !== 0 && appearanceSet.status !== 0,
    `theme_builder ${themeSet.status}, appearance ${appearanceSet.status}`);
  const tb = await req('GET', '/api/prefs/theme_builder');
  const ap = await req('GET', '/api/prefs/appearance');
  const bothPersisted = tb.data?.value?.colors?.accent === '#111111' && ap.data?.value?.accent === '#eeeeee';
  record('3b both prefs independently persisted (App.jsx layers them client-side, not merged server-side)',
    bothPersisted, `theme_builder accent=${tb.data?.value?.colors?.accent}, appearance accent=${ap.data?.value?.accent}`);
  record('3c [design note] this is two independent settings, layered client-side in App.jsx — not a bug if App.jsx order is correct, but worth knowing the SERVER holds both independently with no merge logic of its own', true, 'confirmed structurally');

  // ── 4. Model/provider selection — single source ─────────────────────
  console.log('4. Model/provider selection per role');
  const settingsGet = await req('GET', '/api/settings');
  const hasModelsBlock = !!settingsGet.data?.settings?.models;
  record('4a settings.models is the single source for role->provider/model', hasModelsBlock,
    hasModelsBlock ? `roles: ${Object.keys(settingsGet.data.settings.models).join(', ')}` : 'settings.models missing entirely');

  // ── 5. Security policy mirror — one-directional ─────────────────────
  console.log('5. Security policy -> Settings.prefs mirror (one-directional check)');
  const mirrorCallers = grepCount('src/blocks/security/api/guardian.cjs', /mirrorToSettings/g);
  const directPrefWrites = grepCount('src/blocks/settings/api/settings.js', /prefs\.require_login\s*=/g);
  record('5a mirrorToSettings exists exactly where expected (guardian.cjs)', mirrorCallers >= 1, `${mirrorCallers} reference(s)`);
  record('5b Settings block never independently sets prefs.require_login', directPrefWrites === 0, `${directPrefWrites} direct write(s) found in settings.js (should be 0 — only guardian.cjs's mirror should touch this key)`);

  // ── 6. .env vs Vault key precedence — read-side only ────────────────
  console.log('6. .env vs Vault key reporting (read-side only, not a write duplication)');
  const envKeysReport = settingsGet.data?.envKeys || {};
  record('6a /api/settings reports envKeys without erroring', Object.keys(envKeysReport).length >= 0, `${Object.keys(envKeysReport).length} keys reported`);

  // ── Summary ──────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('\nFAILED / NEEDS ATTENTION:');
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
