import { SELF_REPORTED_HEADER } from './interceptorPolicy.js';

/**
 * Ask AEON to restart and say what it answered.
 *
 * The restart route says whether anything will bring AEON back (host_os,
 * 2026-09-23: 501 with a reason and remedy under launch.command). Both header
 * buttons ignored the answer and reloaded once /api/health answered — at once,
 * since the server never went down — so a refused restart looked like a
 * finished one. A request that dies without an answer is the real restart.
 */
export async function requestRestart(fetcher = fetch) {
  let res;
  try {
    res = await fetcher('/api/system/restart', { method: 'POST', headers: { [SELF_REPORTED_HEADER]: '1' } });
  } catch {
    return { restarting: true };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.restarting !== false) return { restarting: true };
  if (res.status === 404) {
    return { restarting: false, message: 'Restart is served by the Host OS block, which is not installed. Stop AEON and start it again with your launcher.' };
  }
  const reason = body.error || `AEON refused the restart (HTTP ${res.status}).`;
  return { restarting: false, message: body.remedy ? `${reason}\n\n${body.remedy}` : reason };
}
