/**
 * Runtime shim — the ONE place AEON asks "am I running in the cloud?"
 *
 * BO-A3a stage 2. Measured at f94a6ae: 149 conditionals across 41 files, and
 * they are overwhelmingly SUBTRACTIVE —
 *
 *   if (isVercel) return res.json({ success: false, reason: 'cloud env — nothing to push' })
 *
 * Vercel mode largely turns AEON off. Two scheduled crons pointed at routes
 * that never existed and had been firing into a 404 on a schedule (removed
 * 08-03). Deletion is the right end state; this is not that.
 *
 * What this file does is make the surface COUNTABLE. Every runtime read routes
 * through isCloud(), a scanner counts the call sites, and a gate asserts the
 * count only ever falls. That converts stage 3 — deleting the branches block by
 * block — from a gamble across 41 files into an afternoon with a ratchet
 * behind it.
 *
 * NOTHING BEHAVIOURAL CHANGES HERE. isCloud() is exactly `!!process.env.VERCEL`,
 * the same expression the nine server-side `const isVercel = ...` declarations
 * used. If that ever stops being true, this comment is a lie and the tests
 * pinning it should fail.
 *
 * Deliberately NOT cached in a module-level constant: tests set and delete
 * process.env.VERCEL between cases, and a snapshot taken at require-time would
 * freeze whichever value happened to be present when the module first loaded.
 */

/** True when running on Vercel's serverless platform. */
function isCloud() {
  return !!process.env.VERCEL;
}

/** True when running on the operator's own machine. The common case. */
function isLocal() {
  return !isCloud();
}

/** 'cloud' | 'local' — the string form several call sites already build by hand. */
function runtimeName() {
  return isCloud() ? 'cloud' : 'local';
}

// ════════════════════════════════════════════════════════════════════════════
// What THIS process runs against: the home it holds, the interface it serves.
// Both are read once per boot (or per minute) by server/server.js; nothing
// here is a cloud conditional.
// ════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── One AEON per home ──────────────────────────────────────────────────────
//
// Nothing stopped two servers on one home. The drive's launchers take the
// first free port from 3001 (tools/free-port.cjs), so a second double-click on
// launch.command started a second AEON on 3002 over the same AEON-Data: both
// wrote the Matrix index, and the second one's Guardian boot-revoke signed the
// operator out of the first (found 2026-09-28). The vault and runstate have
// their own cross-process file locks; the home as a whole had none.
//
// <home>/aeon.lock names the AEON that holds the home — pid, port, install —
// so a refusal can say where the running one is, and a launcher or the CLI
// can read the port. It sits at the top of the home, beside home.json: the
// drive builder copies the home's roots (vault, data, db, secrets), never
// this file, so a copied home never arrives "held".

const HOME_LOCK_FILE = 'aeon.lock';

// A lock is believed only if it was written since this machine last started.
// After a power cut its pid can belong to anything, and on another machine
// (a drive moved while AEON ran) it means nothing at all. os.uptime() counts
// sleep on macOS, Linux and Windows, so a closed lid does not move the boot
// time; the slack absorbs clock adjustments. A macOS sandbox refuses
// uptime (EPERM): then only the pid decides.
const BOOT_SLACK_MS = 2 * 60 * 1000;

// open('wx') creates the file before its first byte is written. A lock with no
// readable content that young is another AEON between those two steps.
const TORN_LOCK_MS = 10 * 1000;

// A live pid is not yet a live AEON. A lock outlives its AEON whenever the
// process ends without 'exit' (killed; before server.js handled SIGHUP, also
// a closed launcher window), and Windows hands pids on within minutes — the
// relaunch chain itself can get the old one — while Fast Startup keeps the
// boot time across a shutdown. So the lock records when its process started,
// and a live pid is still that AEON only if the OS says it started then. ps
// reports whole seconds; Node starts a moment after its process does.
const START_MATCH_MS = 5 * 1000;

// When the OS will not say when a pid started, the port the lock names is
// asked instead. AEON loads every block before it listens — slow from a cold
// drive — so silence there counts only once the lock is older than this.
const LISTEN_GRACE_MS = 3 * 60 * 1000;

function homeLockPath(home) {
  return path.join(home, HOME_LOCK_FILE);
}

function machineBootAt(now = Date.now()) {
  try { return Math.round(now - os.uptime() * 1000); } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // alive, owned by someone else
}

/** This process's start, as processStartedAt would report it. */
function ownStartedAt() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * When the OS says `pid` started (ms since the epoch), or null when it will
 * not say: ps refused (a macOS sandbox) or missing, PowerShell missing or
 * denied. macOS and Linux read ps's elapsed time, which has no time zone to
 * misread; Windows asks PowerShell — about a second, and only ever asked when
 * a lock names a live pid.
 */
function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { execFileSync } = require('child_process');
  const opts = { encoding: 'utf8', timeout: 10 * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`], opts).trim();
      return /^\d+$/.test(out) ? Number(out) : null;
    }
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { ...opts, env: { ...process.env, LC_ALL: 'C' } });
    const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out);
    if (!m) return null;
    const secs = ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
    return Date.now() - secs * 1000;
  } catch { return null; }
}

// Run in a child: holdHome is synchronous (server.js takes the home before
// anything asynchronous exists), and an HTTP request is not. The answers that
// count as AEON are /api/ping itself and the 401s AEON's own gates give it
// (the session guard once an account exists; the tunnel gate off loopback).
const PING_PROBE = `
const [host, port, ms] = process.argv.slice(1);
const say = (s) => { process.stdout.write(s); process.exit(0); };
const req = require('http').get({ host, port: Number(port), path: '/api/ping', timeout: Number(ms) }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (d) => { body += d; });
  res.on('end', () => {
    let j = null;
    try { j = JSON.parse(body); } catch {}
    const aeon = !!j && ((res.statusCode === 200 && j.name === 'aeon')
      || (res.statusCode === 401 && (j.error === 'UNAUTHORIZED_SESSION' || /^AEON-/.test(String(j.correlation_id)))));
    say(aeon ? 'aeon' : 'other');
  });
});
req.on('timeout', () => say('busy'));
req.on('error', (e) => say(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e.code) ? 'none'
  : e.code === 'ECONNRESET' || /^HPE_/.test(String(e.code)) ? 'other' : 'unknown'));
`;

/**
 * Ask the port a lock names whether AEON answers there.
 * @returns {'aeon'|'busy'|'none'|'other'|'unknown'} busy: connected, no
 *   answer in time (an AEON whose event loop is occupied); none: nothing
 *   listens; other: something that is not AEON; unknown: could not ask.
 */
function probeHolder(lock, { timeoutMs = 3000 } = {}) {
  const port = Number(lock && lock.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 'unknown';
  const bound = String((lock && lock.bind) || '127.0.0.1');
  const host = bound === '0.0.0.0' ? '127.0.0.1' : bound === '::' ? '::1' : bound;
  try {
    const r = require('child_process').spawnSync(process.execPath, ['-e', PING_PROBE, host, String(port), String(timeoutMs)],
      { encoding: 'utf8', timeout: timeoutMs + 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return ['aeon', 'busy', 'none', 'other'].includes(r.stdout) ? r.stdout : 'unknown';
  } catch { return 'unknown'; }
}

// The lock's text and the live AEON it names, or holder null when it is stale.
function inspectLock(file, { pid, ppid, now, bootAt, isAlive, startedAt, probe }) {
  let text, mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; text = fs.readFileSync(file, 'utf8'); }
  catch { return { text: null, holder: null }; }
  let lock = null;
  try { lock = JSON.parse(text); } catch { /* torn or foreign */ }
  if (!lock || typeof lock !== 'object' || !Number.isInteger(lock.pid)) {
    return { text, holder: now - mtimeMs < TORN_LOCK_MS ? { starting: true } : null };
  }
  // Our own pid is a dead run that had it. Our parent's is the launcher that
  // started us — never an AEON, however alive.
  if (lock.pid === pid || lock.pid === ppid) return { text, holder: null };
  const lockBoot = lock.bootAt == null ? null : Number(lock.bootAt);
  if (bootAt != null && lockBoot != null && !(Math.abs(lockBoot - bootAt) <= BOOT_SLACK_MS)) return { text, holder: null };
  if (!isAlive(lock.pid)) return { text, holder: null };
  const recorded = Number(lock.procStart);
  const started = Number.isFinite(recorded) && recorded > 0 ? startedAt(lock.pid) : null;
  if (started != null) return { text, holder: Math.abs(started - recorded) <= START_MATCH_MS ? lock : null };
  // The OS would not say: ask the port. An AEON that answers, or holds the
  // connection without answering, is running; so is one we cannot ask.
  const answer = probe(lock);
  if (answer !== 'none' && answer !== 'other') return { text, holder: lock };
  // Nothing that is AEON answers where the lock says: still loading, or gone.
  return { text, holder: now - mtimeMs < LISTEN_GRACE_MS ? { ...lock, starting: true } : null };
}

function judgeWith(o) {
  const now = o.now == null ? Date.now() : o.now;
  return {
    pid: o.pid == null ? process.pid : o.pid,
    ppid: o.ppid === undefined ? process.ppid : o.ppid,
    now,
    bootAt: o.bootAt === undefined ? machineBootAt(now) : o.bootAt,
    isAlive: o.isAlive || processAlive,
    startedAt: o.startedAt || processStartedAt,
    probe: o.probe || probeHolder,
  };
}

/**
 * The live AEON holding this home, or null. For launchers and the CLI: the
 * holder's `port` is where the running AEON answers.
 */
function homeHolder(home, opts = {}) {
  return inspectLock(homeLockPath(home), judgeWith(opts)).holder;
}

function holderMessage(home, file, holder) {
  const where = Number.isInteger(holder.port) ? `http://localhost:${holder.port}` : null;
  if (holder.starting) {
    return [
      `[HOME] Another AEON is starting on this home right now (${home})${holder.pid ? `: pid ${holder.pid}` : ''}${where ? `, ${where}` : ''}. This one did not start.`,
      `[HOME] Wait a minute and open ${where || 'the one that is starting'}. If it never answers, start AEON again in a few minutes: a lock nothing answers for is then replaced.`,
    ].join('\n');
  }
  return [
    `[HOME] AEON is already running on this home (${home}): pid ${holder.pid}, ${where || 'its own port'}${holder.startedAt ? `, started ${holder.startedAt}` : ''}.`,
    '[HOME] Two AEONs on one home write the same index at once, and the second signs you out of the first.',
    `[HOME] This one did not start. Use the one at ${where || 'its own port'}. If no AEON is running, delete ${file} and start again.`,
  ].join('\n');
}

/**
 * Take the home for this process.
 *
 * @returns {{ ok: true, held: true, lockFile: string, release: () => void }
 *         | { ok: false, lockFile: string, holder: object, message: string }
 *         | { ok: true, held: false, lockFile: string, error: string }}
 *   The last form is a lock that could not be written (a read-only or full
 *   disk). The boot goes on without it: the lock only keeps a second AEON out,
 *   it must never keep the first one from starting — so this never throws.
 */
function holdHome(opts = {}) {
  try { return takeHome(opts); }
  catch (e) { return { ok: true, held: false, lockFile: opts.home ? homeLockPath(opts.home) : null, error: e.code || e.message }; }
}

function takeHome(opts) {
  const { home, port = null, app = null, bind = null } = opts;
  const judge = judgeWith(opts);
  const { pid, now, bootAt } = judge;
  let host = opts.host == null ? null : opts.host;
  if (host == null) { try { host = os.hostname(); } catch { host = null; } }
  const procStart = opts.procStart == null ? ownStartedAt() : opts.procStart;
  const file = homeLockPath(home);
  const body = JSON.stringify({
    pid, port, bind, app, host, startedAt: new Date(now).toISOString(), procStart, bootAt,
  }, null, 2) + '\n';
  const unheld = (e) => ({ ok: true, held: false, lockFile: file, error: e.code || e.message });

  try { fs.mkdirSync(home, { recursive: true }); } catch (e) { return unheld(e); }
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') return unheld(e);
      const seen = inspectLock(file, judge);
      if (seen.holder) return { ok: false, lockFile: file, holder: seen.holder, message: holderMessage(home, file, seen.holder) };
      // Stale. Remove it only if it is still the lock just judged — another
      // AEON may have replaced it in between — then race for it again.
      try {
        if (fs.readFileSync(file, 'utf8') === seen.text) fs.unlinkSync(file);
      } catch (u) { if (u.code !== 'ENOENT') return unheld(u); }
      continue;
    }
    try {
      fs.writeSync(fd, body);
    } catch (e) {
      try { fs.closeSync(fd); fs.unlinkSync(file); } catch { /* best effort */ }
      return unheld(e);
    }
    fs.closeSync(fd);
    return { ok: true, held: true, lockFile: file, release: () => releaseHome(file, pid) };
  }
  return unheld(new Error('the lock kept changing hands'));
}

/** Give the home back — only if the lock is still ours. */
function releaseHome(file, pid = process.pid) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.unlinkSync(file);
  } catch { /* already gone, or someone else's */ }
}

// ── Is the served interface as new as its source? ──────────────────────────
//
// The server serves whatever dist/ was last built. dist/ is gitignored, so a
// `git pull` changes the source and the routes but never the bundle, and the
// drive's launchers never build. On 2026-09-28 the live bundle predated
// 1cee797, which made /api/settings/export-credentials POST-only; the old
// "Export backup" link was a GET nothing served, and the operator's only
// credential backup failed without a word.
//
// This compares the build (dist/index.html's time) with the newest file the
// bundle is built from. Server code under src/ (.cjs, api/ folders), block
// data, dotfiles (AppleDouble ._ files on exFAT, .aeon.runtime.json) and
// block public/ assets never make the interface stale. Neither does a
// block.manifest.json, though the bundle reads it: syncAllBlocks
// (blockStandard.cjs) rewrites every manifest on every boot, so its time is the
// last boot's, not the last change's — counting it called every build stale
// from its first boot (seen on the drive, 2026-09-29). It is a heuristic — it
// says "rebuild", it never refuses to serve.

const UI_SOURCE_EXT = new Set(['.jsx', '.tsx', '.js', '.ts', '.mjs', '.css']);
const UI_SKIP_DIRS = new Set(['node_modules', 'api', 'data', 'db', 'dist', 'public']);
const UI_ROOT_FILES = ['index.html', 'vite.config.js'];

// Slack for copies that do not keep file times (build-usb.js without
// --carry-home copies dist/ first, then src/) and for FAT's 2 s clock.
const UI_BUILD_SLACK_MS = 2 * 60 * 1000;

function newestUiSource(appRoot) {
  let newest = null;
  const consider = (rel, full) => {
    try {
      const m = fs.statSync(full).mtimeMs;
      if (!newest || m > newest.mtimeMs) newest = { file: rel, mtimeMs: m };
    } catch { /* vanished mid-walk */ }
  };
  for (const f of UI_ROOT_FILES) consider(f, path.join(appRoot, f));
  (function walk(dir, rel, depth) {
    if (depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!UI_SKIP_DIRS.has(e.name)) walk(full, r, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (UI_SOURCE_EXT.has(path.extname(e.name))) consider(r, full);
    }
  })(path.join(appRoot, 'src'), 'src', 0);
  return newest;
}

/**
 * @returns {{ stale: boolean, builtAt: string|null, newest: { file: string, changedAt: string }|null }}
 *   builtAt null: there is no dist/ to be stale.
 */
function uiFreshness({ appRoot, slackMs = UI_BUILD_SLACK_MS } = {}) {
  let builtMs;
  try { builtMs = fs.statSync(path.join(appRoot, 'dist', 'index.html')).mtimeMs; }
  catch { return { stale: false, builtAt: null, newest: null }; }
  const n = newestUiSource(appRoot);
  return {
    stale: !!n && n.mtimeMs - builtMs > slackMs,
    builtAt: new Date(builtMs).toISOString(),
    newest: n && { file: n.file, changedAt: new Date(n.mtimeMs).toISOString() },
  };
}

/**
 * uiFreshness, re-read at most once per ttlMs — the header rides on every
 * response, and a rebuild while AEON runs should clear it without a restart.
 * The result carries `header`, the X-AEON-UI-Stale value (ASCII only: a
 * file name never goes into a header).
 */
function watchUiFreshness({ appRoot, ttlMs = 60 * 1000, clock = Date.now, slackMs } = {}) {
  let at = -Infinity;
  let last = null;
  return () => {
    const t = clock();
    if (!last || t - at >= ttlMs) {
      const f = uiFreshness({ appRoot, slackMs });
      last = { ...f, header: f.stale ? `built=${f.builtAt}; source=${f.newest.changedAt}` : null };
      at = t;
    }
    return last;
  };
}

module.exports = {
  isCloud, isLocal, runtimeName,
  HOME_LOCK_FILE, homeLockPath, holdHome, homeHolder, releaseHome, processStartedAt, probeHolder,
  uiFreshness, watchUiFreshness,
};
