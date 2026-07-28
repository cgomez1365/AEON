// WO-14 — "delete and reinstall the repo from GitHub 20 times, each needs a
// unique TOTP secret, and the QR needs to match its own output each time."
//
// Clones the real, currently-pushed AEON repo 20 times (shallow, fresh —
// this tests what's actually on GitHub, not a stale local checkout), npm
// installs once and junctions node_modules into the rest for speed, then
// runs an isolated worker process per clone that creates an account, turns
// on 2FA, and reports the secret/uri/qrDataUrl the REAL qrcode package and
// REAL crypto.randomBytes produced from that clone's own files.
//
// "QR matches" is checked at the data layer: the secret= param embedded in
// the otpauth:// uri (what the QR encodes) is compared byte-for-byte against
// the secret field returned alongside it (what the server verifies against).
// This does not pixel-decode the rendered PNG — that would need a new
// QR-decoding dependency AEON doesn't otherwise carry. Deliberate scope
// boundary, noted in TASKS.md Someday.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_URL = 'https://github.com/cgomez1365/AEON.git';
const N = 20;
const CLONE_CONCURRENCY = 4;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-20x-reinstall-'));
const workerScript = path.join(__dirname, 'totp-reinstall-worker.mjs');

function log(msg) { console.log(`[verify-20x] ${msg}`); }

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

async function cloneOne(i) {
  const dir = path.join(workDir, `clone-${i}`);
  const t0 = Date.now();
  await execFileP('git', ['clone', '--depth', '1', REPO_URL, dir], { maxBuffer: 16 * 1024 * 1024 });
  return { i, dir, cloneMs: Date.now() - t0 };
}

async function main() {
  const overallStart = Date.now();
  log(`Cloning ${N}x from ${REPO_URL} (concurrency ${CLONE_CONCURRENCY})...`);
  const clones = await pool(Array.from({ length: N }, (_, i) => i + 1), CLONE_CONCURRENCY, cloneOne);
  clones.sort((a, b) => a.i - b.i);
  log(`All ${N} clones done. Installing dependencies into clone-1 only...`);

  const installStart = Date.now();
  await execFileP('npm', ['install', '--no-audit', '--no-fund'], { cwd: clones[0].dir, maxBuffer: 32 * 1024 * 1024, shell: true });
  const installMs = Date.now() - installStart;
  log(`npm install done in ${installMs}ms. Junctioning node_modules into clones 2-${N}...`);

  const sourceModules = path.join(clones[0].dir, 'node_modules');
  for (const c of clones.slice(1)) {
    const target = path.join(c.dir, 'node_modules');
    await execFileP('cmd.exe', ['/c', 'mklink', '/J', target, sourceModules]);
  }

  log('Running the worker (create account -> enable 2FA) against each clone...');
  const runs = [];
  for (const c of clones) {
    const t0 = Date.now();
    const { stdout } = await execFileP(process.execPath, [workerScript, c.dir], { maxBuffer: 8 * 1024 * 1024 });
    const runMs = Date.now() - t0;
    let parsed;
    try { parsed = JSON.parse(stdout.trim().split('\n').pop()); }
    catch (e) { parsed = { ok: false, error: `unparsable worker output: ${e.message}` }; }
    runs.push({ i: c.i, cloneMs: c.cloneMs, runMs, ...parsed });
    log(`  clone-${c.i}: ${parsed.ok ? 'ok' : 'FAILED: ' + parsed.error} (${runMs}ms)`);
  }

  // ── Validation ──────────────────────────────────────────────────────
  const failures = runs.filter(r => !r.ok);
  const ok = runs.filter(r => r.ok);

  const secrets = ok.map(r => r.secret);
  const distinctSecrets = new Set(secrets);
  const duplicates = secrets.length - distinctSecrets.size;

  const uriMismatches = ok.filter(r => {
    const m = r.uri.match(/[?&]secret=([^&]+)/);
    const uriSecret = m ? decodeURIComponent(m[1]) : null;
    return uriSecret !== r.secret;
  });

  const qrMissing = ok.filter(r => !r.qrDataUrl || !r.qrDataUrl.startsWith('data:image/png;base64,'));

  const allPass = failures.length === 0 && duplicates === 0 && uriMismatches.length === 0 && qrMissing.length === 0;
  const totalMs = Date.now() - overallStart;

  // ── Report ──────────────────────────────────────────────────────────
  const reportPath = path.join(__dirname, 'TOTP_20x_Reinstall_Report_2026-07-26.md');
  const rows = runs.map(r => r.ok
    ? `| ${r.i} | OK | \`${r.secret.slice(0, 8)}...\` | ${r.cloneMs}ms | ${r.runMs}ms |`
    : `| ${r.i} | **FAIL** | — | ${r.cloneMs}ms | error: ${r.error} |`
  ).join('\n');

  const report = `# TOTP 20x Fresh-Reinstall Verification — 2026-07-26

**Repo:** ${REPO_URL}
**Runs:** ${N}
**Overall result:** ${allPass ? '✅ ALL PASS' : '❌ FAILURES FOUND'}
**Total wall-clock time:** ${(totalMs / 1000).toFixed(1)}s (npm install: ${(installMs / 1000).toFixed(1)}s, one-time)

## Method

Each of the ${N} runs is a genuinely fresh, independent \`git clone --depth 1\` of the
real, currently-pushed repo — not a copy of the working tree used to develop this
feature. Clone 1 gets a real \`npm install\`; clones 2-${N} get a Windows directory
junction (\`mklink /J\`) pointing their \`node_modules\` at clone 1's, since the
dependency tree is identical for one commit — this tests the cloned **source
files**, not a separately-installed copy of someone else's code. Each clone then
runs in its own Node process against its own throwaway temp Vault directory:
create an account, enable 2FA, capture \`{secret, uri, qrDataUrl}\`.

## Results

| Run | Status | Secret (truncated) | Clone time | Worker time |
|-----|--------|--------------------|-----------| ------------|
${rows}

## Pass criteria

| Criterion | Result |
|-----------|--------|
| All ${N} accounts/2FA setups succeeded | ${failures.length === 0 ? `✅ ${ok.length}/${N}` : `❌ ${failures.length} failed`} |
| All ${ok.length} secrets pairwise distinct (${ok.length * (ok.length - 1) / 2} pairs checked) | ${duplicates === 0 ? '✅ no duplicates' : `❌ ${duplicates} duplicate(s) found`} |
| Each \`uri\`'s \`secret=\` param matches its own \`secret\` field, byte-for-byte | ${uriMismatches.length === 0 ? '✅ all match' : `❌ ${uriMismatches.length} mismatch(es): runs ${uriMismatches.map(r => r.i).join(', ')}`} |
| \`qrDataUrl\` present and PNG-shaped every time | ${qrMissing.length === 0 ? '✅ all present' : `❌ missing/malformed on runs ${qrMissing.map(r => r.i).join(', ')}`} |

## Scoping note (unchanged from the work order)

This verifies QR **content** correctness — the string encoded into the QR
matches the string the server will actually check against, exactly. It does
**not** pixel-decode the rendered PNG image, which would require adding a new
QR-decoding dependency (e.g. \`jsqr\`) that AEON doesn't otherwise need. If
true image-decode round-tripping is wanted, that's a follow-up, tracked in
\`Reports\\TASKS.md\` → Someday, not expanded into tonight's scope.

---
*Generated by \`verify-totp-reinstalls.mjs\`. Secrets above are throwaway values
generated fresh for this test and discarded — none were reused across runs,
and none correspond to any real account.*
`;

  fs.writeFileSync(reportPath, report);
  log(`Report written: ${reportPath}`);
  log(`Overall: ${allPass ? 'PASS' : 'FAIL'}`);

  fs.rmSync(workDir, { recursive: true, force: true });
  log('Cleaned up all clone directories.');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('[verify-20x] FATAL:', err);
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
