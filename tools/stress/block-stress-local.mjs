// Block Stress Harness — Local Models Only
// Tests every block's HTTP surface against a live server using local inference.
// Usage: node tools/stress/block-stress-local.mjs [baseUrl] [aeonRoot]

import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3001';
// Repo root derived from the harness's own location (was one operator's
// absolute Desktop path, baked into the file-write check below).
const AEON_ROOT = process.argv[3] || path.resolve(import.meta.dirname, '..', '..');
const MODEL = 'qwen3:1.7b';

const results = [];
let pass = 0, fail = 0, skip = 0;

function record(name, ok, detail, skipped = false) {
  results.push({ name, ok, detail, skipped });
  if (skipped) { skip++; console.log(`  ⊘ ${name} — SKIP: ${detail}`); }
  else if (ok)  { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else          { fail++; console.log(`  ✗ ${name} — ${detail}`); }
}

async function req(method, url, body, timeout = 30000) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeout) };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(BASE + url, opts);
    const t = await r.text();
    let data; try { data = t ? JSON.parse(t) : {}; } catch { data = { raw: t }; }
    return { status: r.status, ok: r.ok, data };
  } catch (e) { return { status: 0, ok: false, data: { error: e.message } }; }
}

async function ai(prompt, timeout = 120000) {
  return req('POST', '/api/ai', { provider: 'ollama', model: MODEL, prompt }, timeout);
}

async function waitForServer(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await req('GET', '/api/ping', undefined, 2000);
    if (r.ok) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

const section = (title) => console.log(`\n${title}`);

async function main() {
  console.log(`\nBlock stress — LOCAL MODELS — against ${BASE}`);
  console.log(`Primary: ${MODEL}\n`);

  // ── 0. Preflight ──────────────────────────────────────────────────────────
  section('0. Preflight');
  const ping = await req('GET', '/api/ping');
  record('0a server responds', ping.ok, `uptime=${ping.data.uptime}s`);
  if (!ping.ok) { console.log('\nServer not reachable — aborting.'); process.exit(1); }

  const state = await req('GET', '/api/system/state');
  const blocks = state.data.blocks || {};
  record('0b all blocks ready', blocks.ready === blocks.total, `${blocks.ready}/${blocks.total}`);

  const cmdsR = await req('GET', '/api/commands');
  const commands = cmdsR.data.commands || [];
  record('0c command registry populated', commands.length >= 30, `${commands.length} commands`);

  // ── 0d. Ollama smoke — qwen3:1.7b fits in GTX 1050 VRAM ─────────────────
  section('0. Ollama smoke');
  let ollamaOk = false;
  let ollamaModels = [];
  try {
    const tagsR = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    const tagsD = await tagsR.json();
    ollamaModels = (tagsD.models || []).map(m => m.name);
    ollamaOk = ollamaModels.length > 0;
  } catch (e) { /* Ollama not running */ }
  record('0d ollama running with models', ollamaOk, `models=${ollamaModels.join(',')}`);

  // Cold-load smoke: qwen3:1.7b ~1.4GB, fits in GPU VRAM, ~10-15s cold start
  const smoke = await ai('Reply with only the word READY.', 60000);
  const smokeText = String(smoke.data?.text || '').trim();
  record('0e ollama qwen3:1.7b responds', smoke.ok && smokeText.length > 0,
    smoke.ok ? `"${smokeText.slice(0, 40)}"` : JSON.stringify(smoke.data).slice(0, 80));

  // ── 16. AI ROUTES ─────────────────────────────────────────────────────────
  section('16. AI routes — direct + NL dispatch');
  const directAI = await ai('What is 2+2? Answer with only the number.', 60000);
  record('16a /api/ai ollama answers', directAI.ok && directAI.data.text,
    directAI.ok ? `"${String(directAI.data.text || '').trim().slice(0, 30)}"` : `err=${String(directAI.data?.error || '').slice(0, 60)}`);

  // writer/generate uses kernelLLM chain (ignores provider param); with cloud
  // keys revoked the chain falls through to ollama — allow full fallback time
  const gen = await req('POST', '/api/writer/generate',
    { prompt: 'One sentence about AEON OS.', provider: 'ollama', model: MODEL }, 180000);
  record('16b writer generate (kernel chain)', gen.status !== 0 && gen.status < 500,
    gen.ok ? `"${String(gen.data.content || '').slice(0, 50)}"` : `status=${gen.status}`);

  const nlDispatch = await req('POST', '/api/ai/dispatch',
    { input: 'show GPU stats', provider: 'ollama', model: MODEL }, 30000);
  record('16c /api/ai/dispatch responds', nlDispatch.status !== 0, `status=${nlDispatch.status}`);

  // ── 1. MASTER block ───────────────────────────────────────────────────────
  section('1. master — registry + catalog');
  const registry = await req('GET', '/api/master/registry');
  record('1a /blocks registry responds', registry.ok, `status=${registry.status}`);
  record('1b registry returns blocks array', Array.isArray(registry.data.blocks),
    `${(registry.data.blocks||[]).length} blocks`);

  const catalog = await req('GET', '/api/store/catalog');
  record('1c /catalog responds', catalog.ok, `status=${catalog.status}`);

  // ── 2. SETTINGS block ─────────────────────────────────────────────────────
  section('2. settings — config');
  const setupStatus = await req('GET', '/api/settings/setup-status');
  record('2a setup-status responds', setupStatus.ok, `complete=${setupStatus.data.complete}`);

  const ns = await req('GET', '/api/settings/nervous-system');
  record('2b /providers responds', ns.ok, `status=${ns.status}`);
  // Ollama was removed in favour of the native llama.cpp runtime; the provider
  // map should expose `local`, not the retired daemon.
  record('2c provider map has local', !!(ns.data.providers?.local), '');

  // NL set — expect 400 on bad format or 200 on success; 500 = bug
  const nlSet = await req('POST', '/api/settings/nl',
    { input: 'set primary_model to ollama qwen3:14b' }, 90000);
  record('2d NL set no server crash', nlSet.status !== 500 && nlSet.status !== 0,
    `status=${nlSet.status} action=${nlSet.data.action||nlSet.data.error||''}`);

  // NOTE: /restart is intentionally excluded — it kills the server process

  // ── 3. SECURITY block ─────────────────────────────────────────────────────
  section('3. security — policy + lock + flush');
  const policy = await req('GET', '/api/security/policy');
  record('3a /guard policy responds', policy.ok, `status=${policy.status}`);

  // 409 = vault already locked = correct state (not a bug)
  const lock = await req('POST', '/api/security/lock');
  record('3b /lock responds (200 or 409 ok)', [200, 202, 204, 409].includes(lock.status),
    `status=${lock.status}`);

  const flush = await req('POST', '/api/security/flush');
  record('3c /flush responds (200 or 409 ok)', [200, 202, 204, 409].includes(flush.status),
    `status=${flush.status}`);

  // ── 4. HOST_OS / COOKBOOK — system info ───────────────────────────────────
  section('4. host_os + cookbook — system info');
  const gpus = await req('GET', '/api/cookbook/gpus');
  record('4a /gpu responds', gpus.ok, `gpus=${(gpus.data.gpus||[]).length}`);
  record('4b GPU list non-empty', (gpus.data.gpus||[]).length > 0, '');

  const scan = await req('POST', '/api/system/scan', {}, 30000);
  record('4c /scan responds', scan.ok || scan.status === 200, `status=${scan.status}`);
  record('4d scan returns logs', Array.isArray(scan.data.logs), `logs=${(scan.data.logs||[]).length}`);

  // ── 5. MEMORY CORE ────────────────────────────────────────────────────────
  section('5. memory_core — store + retrieve');
  const memAdd = await req('POST', '/api/memory/add', {
    text: 'AEON block stress test 2026-07-28 local Ollama models.',
    tags: ['stress-test'],
  });
  record('5a /remember stores memory', [200, 201].includes(memAdd.status), `status=${memAdd.status}`);

  const memList = await req('GET', '/api/memory');
  const mems = memList.data.memories ?? memList.data ?? [];
  record('5b /memory returns list', memList.ok && Array.isArray(mems), `count=${mems.length}`);

  const memCtx = await req('GET', '/api/memory/context');
  record('5c /context responds', memCtx.ok, `status=${memCtx.status}`);

  // ── 6. AEON MATRIX — second-brain ─────────────────────────────────────────
  section('6. aeon_matrix — second-brain');
  const tree = await req('GET', '/api/crn/second-brain/tree');
  record('6a /tree responds', tree.status !== 0, `status=${tree.status}`);

  const recall = await req('POST', '/api/crn/second-brain/retrieve',
    { query: 'stress test', top_k: 3 }, 30000);
  record('6b /recall responds', recall.status !== 0, `status=${recall.status}`);
  // route returns { documents: [...] }
  const recallArr = recall.data.documents ?? recall.data.results ?? recall.data ?? [];
  record('6c recall returns array', Array.isArray(recallArr), `count=${recallArr.length}`);

  // ── 7. COOKBOOK — model cache ──────────────────────────────────────────────
  section('7. cookbook — model cache');
  const cached = await req('GET', '/api/model/cached');
  record('7a /models responds', cached.status !== 0, `status=${cached.status}`);
  const modelList = cached.data.models ?? cached.data ?? [];
  record('7b model list is array', Array.isArray(modelList), `count=${modelList.length}`);

  // ── 8. ORION SEARCH ───────────────────────────────────────────────────────
  section('8. orion_search — web search');
  const orion = await req('POST', '/api/orion/search',
    { query: 'AEON OS local LLM', provider: 'duckduckgo' }, 30000);
  record('8a /orion responds', orion.status !== 0, `status=${orion.status}`);
  record('8b orion no 5xx', orion.status < 500, `status=${orion.status}`);

  // ── 9. WRITER ─────────────────────────────────────────────────────────────
  section('9. writer — docs + generate');
  const docs = await req('GET', '/api/writer/docs');
  record('9a /docs responds', docs.status !== 0, `status=${docs.status}`);

  // ── 10. FILES ─────────────────────────────────────────────────────────────
  section('10. files — read + write');
  // Use timestamp so each run writes a new file (avoids 423 add-only lock on overwrite)
  const testFilePath = path.join(AEON_ROOT, 'data', `stress-test-${Date.now()}.txt`);
  const writeR = await req('POST', '/api/fs/write',
    { filePath: testFilePath, content: 'block-stress-local 2026-07-28' });
  // 423 = file manager locked (correct behavior), not a route bug
  record('10a /write route healthy', [200, 201, 423].includes(writeR.status), `status=${writeR.status}`);

  // Only try to read if write succeeded
  if ([200, 201].includes(writeR.status)) {
    const readR = await req('POST', '/api/fs/read', { filePath: testFilePath });
    record('10b /read retrieves file', readR.ok, `status=${readR.status}`);
    record('10c read content matches', String(readR.data.content||'').includes('block-stress'), '');
  } else {
    record('10b /read — skipped (write locked)', true, 'add-only mode active', true);
    record('10c read content — skipped', true, '', true);
  }

  // ── 11. DEEP RESEARCH ─────────────────────────────────────────────────────
  section('11. deep_research — ingest');
  const idx = await req('POST', '/api/crn/second-brain/ingest/scan-docs', {}, 30000);
  record('11a /index-brain responds', idx.status !== 0, `status=${idx.status}`);
  record('11b index no 5xx', idx.status < 500, `status=${idx.status}`);

  // ── 12. ACTIVITY ──────────────────────────────────────────────────────────
  section('12. activity');
  const activity = await req('GET', '/api/activity');
  record('12a /activity responds (200 or 404 ok)', activity.status !== 0, `status=${activity.status}`);

  // ── 13. DASHBOARD ─────────────────────────────────────────────────────────
  section('13. dashboard');
  const dash = await req('GET', '/api/dashboard');
  record('13a /dashboard responds', dash.status !== 0, `status=${dash.status}`);

  // ── 14. FLEET CONTROL — build queue ───────────────────────────────────────
  section('14. fleet_control — build queue');
  const queue = await req('GET', '/api/build/queue');
  record('14a /queue responds', queue.status !== 0, `status=${queue.status}`);
  record('14b queue no 5xx', queue.status < 500, `status=${queue.status}`);

  // ── 15. GOD ROUTES — vault + data ─────────────────────────────────────────
  section('15. god routes — data + keys');
  const godData = await req('GET', '/api/god/data');
  record('15a /data list responds', godData.ok, `status=${godData.status}`);
  record('15b namespaces returned', typeof godData.data === 'object',
    `keys=${Object.keys(godData.data||{}).length}`);

  const godBlock = await req('GET', '/api/god/data?block=settings');
  record('15c /data?block=settings responds', godBlock.status !== 0, `status=${godBlock.status}`);

  // (AI route tests moved to immediately after 0d pre-warm above)

  // ── 17. KERNEL HEALTH — final ─────────────────────────────────────────────
  section('17. kernel health — final');
  const health = await req('GET', '/api/system/health');
  record('17a kernel health responds', health.ok, `status=${health.status}`);
  record('17b no skipped routes', (health.data.skippedRoutes||[]).length === 0,
    `skipped=${(health.data.skippedRoutes||[]).join(',')}`);

  const finalPing = await req('GET', '/api/ping');
  record('17c server still alive after full suite', finalPing.ok, `uptime=${finalPing.data.uptime}s`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass + fail + skip} checks — ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) {
    console.log('\nFAILED:');
    results.filter(r => !r.ok && !r.skipped).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
