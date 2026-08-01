// Round 2 God Mode terminal stress test — 10 scenarios, deliberately
// DIFFERENT from round 1 (settings-audit.mjs / terminal-stress.mjs).
// Round 1 focused on raw HTTP-level security/robustness (concurrency,
// injection, malformed input, the guard-bypass hypothesis). Round 2 focuses
// on: the NL router's own logic in isolation, session lifecycle edge cases
// (expiry/revocation/concurrency), block-readiness gating, and — the biggest
// difference — actually spawning the REAL `aeon` CLI binary as a subprocess
// instead of hand-rolled HTTP calls, which exercises client.cjs's dual-mode
// detection, session persistence, and output formatting for real.
//
// IMPORTANT: AEON is single-operator (one account file, ever) -- this script
// creates exactly ONE account and obtains MULTIPLE SESSIONS for it (multiple
// logins) wherever a scenario needs "two users"/"concurrent sessions". It
// does NOT attempt to create separate accounts per scenario.
//
// Usage: node terminal-stress-round2.mjs [baseUrl] [aeonRepoPath]
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const execFileP = promisify(execFile);

const BASE = process.argv[2] || 'http://127.0.0.1:3001';
// Repo root derived from the harness's own location (was one operator's
// absolute Desktop path). argv[3] still overrides.
const AEON_ROOT = process.argv[3] || path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(AEON_ROOT, 'tools', 'aeon-cli.cjs');
const router = require(path.join(AEON_ROOT, 'tools', 'terminal', 'router.cjs'));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function req(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: r.status, ok: r.ok, data };
}

const USERNAME = 'round2test';
const PASSWORD = 'CorrectHorse9!';
const RECOVERY = [{ questionId: 'q01', answer: 'Pine Street School' }, { questionId: 'q02', answer: 'Portland' }, { questionId: 'q03', answer: 'Comet' }];

async function login() {
  const r = await req('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  return r.data.token;
}

async function main() {
  console.log(`\nGod Mode terminal stress test ROUND 2 (different scenarios) against ${BASE}\n`);

  const status = await req('GET', '/api/auth/status');
  if (!status.data.configured) {
    const setup = await req('POST', '/api/auth/setup', { username: USERNAME, password: PASSWORD, recoveryQuestions: RECOVERY });
    if (setup.status !== 200) throw new Error(`could not create the one account this script needs: ${JSON.stringify(setup.data)}`);
  }
  const token = await login();
  if (!token) throw new Error('could not log in with the expected round2test account — was a DIFFERENT account already configured on this server? Delete Vault/blocks/security/local_auth.json (the established, tested factory-reset path) and re-run.');

  const commands = (await req('GET', '/api/commands', undefined, token)).data.commands || [];
  console.log(`(${commands.length} commands in the live registry)\n`);

  // ── 1. NL router fastMatch — exact, namespaced id, intent scoring, no-match ──
  console.log('1. NL router fastMatch() logic (in-process, no HTTP)');
  const exact = router.fastMatch('/guard', commands);
  record('1a exact command token resolves with confidence 1', exact?.confidence === 1 && exact?.via === 'exact', JSON.stringify(exact?.id));
  const nsId = router.fastMatch('security.guard', commands);
  record('1b namespaced id resolves', nsId?.via === 'id', JSON.stringify(nsId?.id));
  const gibberish = router.fastMatch('asdkjfhaslkdjfh qmweiorqwe', commands);
  record('1c pure gibberish returns null (not a false-positive match)', gibberish === null, JSON.stringify(gibberish));
  const intent = router.fastMatch('what gpu do I have', commands);
  record('1d intent-scored phrase resolves toward cookbook (gpu terms) or null', intent === null || intent?.blockId === 'cookbook', `resolved: ${JSON.stringify(intent?.id)} (null is acceptable if score threshold not met)`);

  // ── 2. extractJson robustness ──────────────────────────────────────
  console.log('2. router.extractJson() against realistic model output shapes');
  const clean = router.extractJson('{"id":"cookbook.gpu","confidence":0.9}');
  record('2a plain JSON parses', clean?.id === 'cookbook.gpu');
  const fenced = router.extractJson('```json\n{"id":"cookbook.gpu","confidence":0.9}\n```');
  record('2b fenced JSON parses', fenced?.id === 'cookbook.gpu');
  const prosed = router.extractJson('Sure, here you go: {"id":"cookbook.gpu","confidence":0.9} — hope that helps!');
  record('2c JSON embedded in prose parses', prosed?.id === 'cookbook.gpu');
  const garbage = router.extractJson('not json at all, sorry');
  record('2d non-JSON text returns null, not a throw', garbage === null);

  // ── 3. Bogus / never-issued token ───────────────────────────────────
  console.log('3. A bogus/never-issued token is rejected the same as an expired one');
  const bogus = await req('GET', '/api/commands', undefined, 'not-a-real-token-at-all');
  record('3a bogus token rejected (401), never silently accepted', bogus.status === 401, `status ${bogus.status}`);

  // ── 4. Session revocation mid-use ──────────────────────────────────
  console.log('4. Revoke this session, then immediately try to use it');
  const revokeToken = await login(); // a FRESH session, distinct from `token`, so logging it out doesn't affect the rest of the script
  const beforeRevoke = await req('GET', '/api/commands', undefined, revokeToken);
  await req('POST', '/api/auth/logout', undefined, revokeToken); // per-session logout, not the global /security/lock
  const afterRevoke = await req('GET', '/api/commands', undefined, revokeToken);
  record('4a session works before logout', beforeRevoke.status === 200, `status ${beforeRevoke.status}`);
  record('4b the SAME token is rejected immediately after logout', afterRevoke.status === 401, `status ${afterRevoke.status}`);
  const workingToken = token;

  // ── 5. Concurrent command rescan during live dispatch ───────────────
  console.log('5. /commands/rescan fired concurrently with live dispatches');
  const safeCmd = commands.find(c => !c.dangerous) || null;
  if (safeCmd) {
    const [rescanRes, ...dispatchResults] = await Promise.all([
      req('POST', '/api/commands/rescan', {}, workingToken),
      ...Array.from({ length: 5 }, () => req('POST', '/api/commands/dispatch', { id: safeCmd.id, arg: '' }, workingToken)),
    ]);
    record('5a rescan succeeds', rescanRes.status === 200, `status ${rescanRes.status}`);
    record('5b concurrent dispatches survive a rescan mid-flight, no 5xx', dispatchResults.every(r => r.status < 500), dispatchResults.map(r => r.status).join(','));
    const afterRescan = await req('POST', '/api/commands/dispatch', { id: safeCmd.id, arg: '' }, workingToken);
    record('5c dispatch still resolves correctly after the rescan settles', afterRescan.status < 500, `status ${afterRescan.status}`);
  } else {
    record('5 rescan-during-dispatch test', false, 'no safe command available to test with');
  }

  // ── 6. Block-not-ready `when` clause gating ─────────────────────────
  console.log('6. A command whose block reports not-ready is gated, never proxied');
  const blocksRes = await req('GET', '/api/god/blocks', undefined, workingToken);
  const notReadyBlock = (blocksRes.data?.blocks || []).find(b => b.ready === false);
  if (notReadyBlock) {
    const cmdForThatBlock = commands.find(c => c.blockId === notReadyBlock.id);
    if (cmdForThatBlock) {
      const gated = await req('POST', '/api/commands/dispatch', { id: cmdForThatBlock.id, arg: '' }, workingToken);
      record('6a dispatch to a not-ready block\'s command is gated (409), not proxied through', gated.status === 409, `status ${gated.status} ${JSON.stringify(gated.data)}`);
    } else {
      record('6 block-not-ready gating', true, `block "${notReadyBlock.id}" is not-ready but declares no commands — nothing to test, not a failure`);
    }
  } else {
    record('6 block-not-ready gating', true, 'every block on this install is currently ready — hypothesis untestable right now, not a failure');
  }

  // ── 7. REAL CLI subprocess — aeon status / commands / blocks ────────
  console.log('7. Spawning the ACTUAL aeon CLI binary (not hand-rolled HTTP)');
  try {
    const { stdout: statusOut } = await execFileP(process.execPath, [CLI, 'status', '--json'], { env: { ...process.env, AEON_URL: BASE }, timeout: 15000 });
    const statusJson = JSON.parse(statusOut);
    record('7a `aeon status --json` runs for real and returns valid JSON', typeof statusJson === 'object', JSON.stringify(statusJson).slice(0, 150));
  } catch (e) {
    record('7a `aeon status --json`', false, (e.stderr || e.message).slice(0, 300));
  }
  try {
    const { stdout: cmdsOut } = await execFileP(process.execPath, [CLI, 'commands', '--json'], { env: { ...process.env, AEON_URL: BASE }, timeout: 15000 });
    const cmdsJson = JSON.parse(cmdsOut);
    record('7b `aeon commands --json` returns the real registry as an array', Array.isArray(cmdsJson) && cmdsJson.length > 0, `${cmdsJson.length} commands`);
  } catch (e) {
    record('7b `aeon commands --json`', false, (e.stderr || e.message).slice(0, 300));
  }
  try {
    const { stdout: blocksOut } = await execFileP(process.execPath, [CLI, 'blocks', '--json'], { env: { ...process.env, AEON_URL: BASE }, timeout: 15000 });
    JSON.parse(blocksOut);
    record('7c `aeon blocks --json` runs without crashing and returns valid JSON', true);
  } catch (e) {
    record('7c `aeon blocks --json`', false, (e.stderr || e.message).slice(0, 300));
  }

  // ── 8. Standalone-mode consistency (server unreachable) ─────────────
  console.log('8. `aeon commands` Standalone-mode fallback (bad AEON_URL, no server there)');
  try {
    const { stdout } = await execFileP(process.execPath, [CLI, 'commands', '--json'], { env: { ...process.env, AEON_URL: 'http://127.0.0.1:1' }, timeout: 15000 });
    const parsed = JSON.parse(stdout);
    record('8a with no server reachable, falls back to manifest scan instead of crashing', Array.isArray(parsed) && parsed.length > 0, `${parsed.length} commands from manifest scan`);
  } catch (e) {
    record('8a Standalone fallback', false, (e.stderr || e.message).slice(0, 300));
  }

  // ── 9. Multiple concurrent sessions for the same account ────────────
  console.log('9. Two independent sessions for the ONE account — revoke one, confirm the other survives');
  const tokenA = await login();
  const tokenB = await login();
  const sessionsListA = await req('GET', '/api/auth/sessions', undefined, tokenA);
  record('9a two logins for the same account produce two-or-more distinct session entries', (sessionsListA.data.sessions || []).length >= 2, `${sessionsListA.data.sessions?.length} sessions listed`);
  const otherId = (sessionsListA.data.sessions || []).find(s => !s.current)?.id;
  if (otherId) {
    await req('POST', '/api/auth/sessions/revoke', { id: otherId }, tokenA);
    const bCheck = await req('GET', '/api/commands', undefined, tokenB);
    record('9b revoking session B by id from session A logs out B specifically', bCheck.status === 401, `status ${bCheck.status}`);
    const aCheck = await req('GET', '/api/commands', undefined, tokenA);
    record('9c session A remains valid after B was individually revoked', aCheck.status === 200, `status ${aCheck.status}`);
  } else {
    record('9b/9c targeted session revocation', false, 'could not identify the non-current session id to revoke');
  }

  // ── 10. Deployment shield header on command dispatch responses ──────
  console.log('10. Deployment shield (Cache-Control: no-store) covers /commands/dispatch too');
  if (safeCmd) {
    const finalToken = (await req('GET', '/api/commands', undefined, workingToken)).status === 200 ? workingToken : await login();
    const r = await fetch(BASE + '/api/commands/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${finalToken}` },
      body: JSON.stringify({ id: safeCmd.id, arg: '' }),
    });
    const cacheControl = r.headers.get('cache-control') || '';
    record('10a dispatch response carries a no-store Cache-Control header (shield covers this route too)', /no-store/.test(cacheControl), `Cache-Control: "${cacheControl}"`);
  } else {
    record('10 shield header check', false, 'no safe command available to test with');
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
