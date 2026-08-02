// Round 3 stress test — the NEW agentic-terminal surface only.
// Round 1: HTTP security/robustness. Round 2: router logic, session lifecycle,
// real CLI subprocess. Round 3: the 12 newly-registered commands, structured
// body dispatch, the agent loop's safety properties, and `aeon install`.
//
// The agent loop is driven with an INJECTED model here, not the live one --
// a 14B model on this machine's CPU-only inference answers in ~90s+ per step,
// which would make a stress run take an hour and prove nothing extra about
// the loop's control flow. The live end-to-end path is exercised separately.
//
// Usage: node terminal-stress-round3.mjs [baseUrl] [aeonRepoPath]
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);

const BASE = process.argv[2] || 'http://127.0.0.1:3001';
// Repo root derived from the harness's own location (was one operator's
// absolute Desktop path). argv[3] still overrides.
const AEON_ROOT = process.argv[3] || path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(AEON_ROOT, 'tools', 'aeon-cli.cjs');
const agent = require(path.join(AEON_ROOT, 'tools', 'terminal', 'agent.cjs'));

const USERNAME = 'round2test';
const PASSWORD = 'CorrectHorse9!';
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

let TOKEN = null;
async function req(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: r.status, ok: r.ok, data, headers: r.headers };
}
const dispatch = (payload) => req('POST', '/api/commands/dispatch', payload);

async function main() {
  console.log(`\nAgentic terminal stress test ROUND 3 (new surface) against ${BASE}\n`);

  const login = await req('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  TOKEN = login.data.token;
  if (!TOKEN) throw new Error(`could not log in as ${USERNAME}: ${JSON.stringify(login.data)}`);
  const commands = (await req('GET', '/api/commands')).data.commands || [];
  const byId = Object.fromEntries(commands.map(c => [c.id, c]));
  console.log(`(${commands.length} commands registered)\n`);

  // ── 1. All 12 new commands registered with the right shape ──────────
  console.log('1. Newly-registered commands');
  const expected = {
    'settings.set': { method: 'POST', param: 'phrase' },
    'settings.settings': { method: 'GET' },
    'settings.providers': { method: 'GET' },
    'settings.restart': { method: 'POST', dangerous: true },
    'files.read': { method: 'POST', param: 'filePath' },
    'files.write': { method: 'POST', dangerous: true, params: ['filePath', 'content'] },
    'memory_core.memory': { method: 'GET', param: 'q' },
    'memory_core.remember': { method: 'POST', param: 'text' },
    'memory_core.context': { method: 'GET', param: 'q' },
    'master.install': { method: 'POST', dangerous: true, params: ['url', 'name'] },
    'master.catalog': { method: 'GET' },
    'master.queue': { method: 'GET' },
  };
  let shapeOk = 0;
  for (const [id, want] of Object.entries(expected)) {
    const got = byId[id];
    const ok = got && got.method === want.method
      && (want.param === undefined || got.param === want.param)
      && (want.dangerous === undefined || !!got.dangerous === want.dangerous)
      && (want.params === undefined || JSON.stringify(got.params) === JSON.stringify(want.params));
    if (ok) shapeOk++; else console.log(`      mismatch ${id}: ${JSON.stringify(got && { method: got.method, param: got.param, params: got.params, dangerous: got.dangerous })}`);
  }
  record('1a all 12 new commands registered with correct method/param/dangerous', shapeOk === 12, `${shapeOk}/12`);
  record('1b registry has expected command count', commands.length >= 33, `${commands.length} commands`);

  // ── 2. /set actually changes a setting, and it persists ─────────────
  console.log('2. settings.set — the "fix this setting" case');
  const before = (await req('GET', '/api/settings')).data?.settings?.models?.research;
  const setRes = await dispatch({ id: 'settings.set', arg: 'set research to local qwen3-1.7b-q4' });
  const after = (await req('GET', '/api/settings')).data?.settings?.models?.research;
  record('2a /set dispatch succeeds', setRes.ok && setRes.data?.ok, JSON.stringify(setRes.data?.text || setRes.data?.error));
  record('2b the change is actually persisted in settings', after?.model === 'qwen3:14b', `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  // restore
  if (before?.provider) await dispatch({ id: 'settings.set', arg: `set research to ${before.provider} ${before.model}` });
  const restored = (await req('GET', '/api/settings')).data?.settings?.models?.research;
  record('2c restored to the original value', JSON.stringify(restored) === JSON.stringify(before), JSON.stringify(restored));

  // ── 3. Structured body: write -> read round trip ────────────────────
  console.log('3. Structured body dispatch (files.write needs two fields)');
  const stamp = `round3-${Date.now()}`;
  const gate = await dispatch({ id: 'files.write', body: { filePath: `${stamp}.txt`, content: stamp } });
  record('3a dangerous structured command gates with 428 and names its target', gate.status === 428 && /filePath=/.test(gate.data?.prompt || ''), gate.data?.prompt?.slice(0, 90));
  const wrote = await dispatch({ id: 'files.write', confirmed: true, body: { filePath: `${stamp}.txt`, content: stamp } });
  record('3b confirmed write succeeds', wrote.ok && wrote.data?.data?.success, JSON.stringify(wrote.data?.data));
  const readBack = await dispatch({ id: 'files.read', arg: `${stamp}.txt` });
  const content = readBack.data?.data?.content ?? readBack.data?.data?.text ?? '';
  record('3c the file reads back with the exact content written (round trip)', String(content).includes(stamp), `got ${String(content).slice(0, 60)}`);

  // ── 4. Backward compatibility: plain `arg` still works ──────────────
  console.log('4. Backward compatibility — single-string arg unchanged');
  const argOnly = await dispatch({ id: 'memory_core.remember', arg: `round3 marker ${stamp}` });
  record('4a arg-only dispatch still works (no body sent)', argOnly.ok && argOnly.data?.ok, JSON.stringify(argOnly.data?.data?.memory?.id || argOnly.data?.error));
  const found = await dispatch({ id: 'memory_core.memory', arg: stamp });
  const hay = JSON.stringify(found.data?.data || {});
  record('4b GET with a param finds what was just saved (memory round trip)', hay.includes(stamp), `${hay.length} chars returned`);

  // ── 5. Every new dangerous command gates — including /restart ───────
  console.log('5. Danger gates on the new commands (nothing is executed here)');
  for (const id of ['files.write', 'master.install', 'settings.restart']) {
    const r = await dispatch({ id, arg: '' });
    record(`5-${id} returns 428 without confirmation`, r.status === 428 && r.data?.requiresConfirmation === true, `status ${r.status}`);
  }

  // ── 6. master.install rejects bad sources cleanly ───────────────────
  console.log('6. master.install error paths (no real install performed)');
  const httpUrl = await dispatch({ id: 'master.install', confirmed: true, body: { url: 'http://insecure.example.com/x.aeon' } });
  record('6a http:// (non-https) cartridge URL is refused server-side', !httpUrl.ok && /https/i.test(JSON.stringify(httpUrl.data)), JSON.stringify(httpUrl.data).slice(0, 120));
  const missing = await dispatch({ id: 'master.install', confirmed: true, body: { name: 'definitely-not-a-real-cartridge' } });
  record('6b unknown cartridge name fails cleanly, no crash', !missing.ok && missing.status < 500, `status ${missing.status} ${JSON.stringify(missing.data).slice(0, 90)}`);
  const catalog = await dispatch({ id: 'master.catalog', arg: '' });
  record('6c master.catalog responds', catalog.ok, `status ${catalog.status}`);

  // ── 7. GET commands with a structured body become query params ──────
  console.log('7. Structured body on a GET becomes query params');
  const getBody = await dispatch({ id: 'memory_core.memory', body: { q: stamp } });
  record('7a GET dispatch with body works and filters', getBody.ok && JSON.stringify(getBody.data?.data || {}).includes(stamp), `status ${getBody.status}`);

  // ── 8. Agent loop: hallucinated command never reaches the kernel ────
  console.log('8. Agent loop safety (injected model — deterministic)');
  const dispatched = [];
  const fakeDispatch = async (id, arg, opts = {}) => { dispatched.push(id); return { ok: true, status: 200, data: { ok: true, data: {} } }; };
  const getCommands = async () => ({ commands, source: 'test' });
  let n = 0;
  const hallucinating = async () => [
    { action: 'run', id: 'evil.rm_rf', arg: '/', why: 'invented' },
    { action: 'run', id: 'memory_core.memory', arg: '', why: 'corrected' },
    { action: 'done', summary: 'ok' },
  ][Math.min(n++, 2)];
  const halluc = await agent.run('do something', { ask: hallucinating, dispatch: fakeDispatch, getCommands, log: () => {} });
  record('8a an invented command id never reaches the dispatcher', !dispatched.includes('evil.rm_rf'), `dispatched: ${dispatched.join(', ') || '(none)'}`);
  record('8b the loop recovers and completes after the refusal', halluc.ok === true, JSON.stringify(halluc.summary));

  // ── 9. Agent loop: declining a dangerous step aborts the run ────────
  console.log('9. Agent loop honours the kernel 428 gate');
  let asked = 0;
  const gated = await agent.run('write a file', {
    ask: async () => ({ action: 'run', id: 'files.write', body: { filePath: 'nope.txt', content: 'x' }, why: 'write' }),
    dispatch: async () => ({ ok: false, status: 428, data: { requiresConfirmation: true, prompt: 'confirm?' } }),
    getCommands,
    confirm: async () => { asked++; return false; },
    log: () => {},
  });
  record('9a the human is asked before a dangerous agent step', asked === 1, `asked ${asked}x`);
  record('9b declining aborts the whole run', gated.ok === false && gated.reason === 'declined', JSON.stringify(gated.reason));

  // ── 10. Agent loop: step cap ────────────────────────────────────────
  console.log('10. Agent loop cannot run away');
  let steps = 0;
  const capped = await agent.run('loop', {
    ask: async () => { steps++; return { action: 'run', id: 'memory_core.memory', arg: '', why: 'again' }; },
    dispatch: async () => ({ ok: true, status: 200, data: { ok: true, data: {} } }),
    getCommands, log: () => {}, maxSteps: 4,
  });
  record('10a stops at the step cap', capped.reason === 'step-limit' && steps === 4, `${steps} steps, reason ${capped.reason}`);

  // ── 11. aeon install CLI guards ─────────────────────────────────────
  console.log('11. `aeon install` CLI');
  try {
    await execFileP(process.execPath, [CLI, 'install', 'http://insecure.example.com/x.aeon'], { env: { ...process.env, AEON_URL: BASE }, timeout: 20000 });
    record('11a http:// rejected client-side before any network call', false, 'expected a non-zero exit');
  } catch (e) {
    record('11a http:// rejected client-side before any network call', /must be https/i.test(e.stdout + e.stderr), (e.stdout + e.stderr).trim().slice(0, 80));
  }
  try {
    await execFileP(process.execPath, [CLI, 'install'], { env: { ...process.env, AEON_URL: BASE }, timeout: 20000 });
    record('11b bare `aeon install` prints usage and exits non-zero', false, 'expected a non-zero exit');
  } catch (e) {
    record('11b bare `aeon install` prints usage and exits non-zero', /usage: aeon install/.test(e.stdout + e.stderr), 'usage shown');
  }

  // ── 12. `aeon agent` is wired into the CLI and shell ────────────────
  console.log('12. `aeon agent` surface');
  try {
    await execFileP(process.execPath, [CLI, 'agent'], { env: { ...process.env, AEON_URL: BASE }, timeout: 20000 });
    record('12a bare `aeon agent` prints usage', false, 'expected non-zero exit');
  } catch (e) {
    record('12a bare `aeon agent` prints usage', /usage: aeon agent/.test(e.stdout + e.stderr), 'usage shown');
  }
  const { stdout: help } = await execFileP(process.execPath, [CLI, '--help'], { env: { ...process.env, AEON_URL: BASE }, timeout: 20000 }).catch(e => ({ stdout: e.stdout || '' }));
  record('12b `aeon --help` documents agent and install', /aeon agent/.test(help) && /aeon install/.test(help), 'both listed');

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
