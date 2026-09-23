// _procControl.cjs — stop a process Cookbook itself started, on every platform.
//
// Stop used to be `taskkill /F /T /PID` everywhere. taskkill exists only on
// Windows, so on macOS and Linux the call failed, the failure was swallowed, the
// task was marked "stopped" and the route answered ok:true while llama-server
// kept serving on 0.0.0.0:8080 (measured 2026-09-23, tests/cookbook-task-stop).
//
// Serve and download children are spawned `detached: true`. On POSIX that makes
// each one the leader of a new process group whose id equals its pid, so the
// group — the serve process and anything it started — is signalled with a
// NEGATIVE pid. That is the POSIX equivalent of taskkill's /T (tree).
//
// Only ever called with a pid Cookbook recorded when it spawned the child; this
// module is not a general "kill any pid" surface.
'use strict';

const { execFileSync } = require('child_process');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const groupAlive = (pid) => {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!check()) return true;
    await sleep(50);
  }
  return !check();
}

/**
 * Stop a process and its children.
 * @param {number} pid         a pid Cookbook spawned with detached:true
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {number} [opts.graceMs=3000]  SIGTERM grace before SIGKILL (POSIX)
 * @param {boolean} [opts.tree=true]    false = this pid only, never its group
 *                                      (for a process Cookbook did not spawn)
 * @returns {Promise<{stopped: boolean, method?: string, error?: string}>}
 */
async function stopProcessTree(pid, opts = {}) {
  const platform = opts.platform || process.platform;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 3000;
  const tree = opts.tree !== false;
  pid = parseInt(pid, 10);
  if (!Number.isInteger(pid) || pid <= 1) return { stopped: false, error: `not a stoppable pid: ${pid}` };

  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      if (!alive(pid)) return { stopped: true, method: 'taskkill' };
      return { stopped: false, error: `taskkill failed: ${e.message}` };
    }
    const gone = await waitGone(() => alive(pid), 2000);
    return gone ? { stopped: true, method: 'taskkill' } : { stopped: false, error: `process ${pid} is still running after taskkill` };
  }

  // POSIX. Prefer the group; fall back to the single pid if the group signal is
  // refused (a child spawned without detached is not a group leader).
  let target = tree ? -pid : pid;
  try { process.kill(target, 'SIGTERM'); }
  catch (e) {
    if (e.code === 'ESRCH' && !alive(pid)) return { stopped: true, method: 'already-exited' };
    if (target === pid) return { stopped: false, error: `SIGTERM refused: ${e.message}` };
    target = pid;
    try { process.kill(pid, 'SIGTERM'); }
    catch (e2) {
      if (e2.code === 'ESRCH') return { stopped: true, method: 'already-exited' };
      return { stopped: false, error: `SIGTERM refused: ${e2.message}` };
    }
  }
  const check = target < 0 ? () => groupAlive(pid) : () => alive(pid);
  if (await waitGone(check, graceMs)) return { stopped: true, method: 'SIGTERM' };

  try { process.kill(target, 'SIGKILL'); } catch { /* raced to exit */ }
  if (await waitGone(check, 2000)) return { stopped: true, method: 'SIGKILL' };
  return { stopped: false, error: `process ${pid} survived SIGTERM and SIGKILL` };
}

module.exports = { stopProcessTree, alive };
