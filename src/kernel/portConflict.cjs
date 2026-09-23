/**
 * What the kernel does when its port is already taken.
 *
 * It never signals another process. The handler this replaces ran a
 * Windows-only `taskkill /F` against whatever held the port, in an unbounded
 * retry loop: on macOS and Linux the command could not run, so the server
 * printed "Killing zombie and retrying..." every second forever; on Windows it
 * force-killed the host's own AEON — or any program on that port — and took
 * its place. Found 2026-09-22, booting a second AEON from a USB drive on a
 * machine whose own AEON was already running.
 *
 * A short retry covers the one legitimate case (a restart racing the previous
 * process's shutdown). After that the answer is a clear stop: which port, what
 * probably holds it, and how to run beside it. Launchers that expect to share
 * a machine with another AEON pick a free port before boot
 * (tools/free-port.cjs), because every module reads PORT once, at load.
 *
 * Pure: no I/O, no timers. server/server.js owns those.
 */
'use strict';

const MAX_ATTEMPTS = 5;
const RETRY_MS = 1000;

/**
 * @param {{ port: number, attempt: number }} ctx  attempt is 1-based
 * @returns {{ retry: true, delayMs: number, message: string }
 *         | { retry: false, exitCode: number, message: string }}
 */
function onAddrInUse({ port, attempt }) {
  if (attempt < MAX_ATTEMPTS) {
    return {
      retry: true,
      delayMs: RETRY_MS,
      message: `[KERNEL] Port ${port} is busy — waiting for it to free up (attempt ${attempt} of ${MAX_ATTEMPTS})...`,
    };
  }
  return {
    retry: false,
    exitCode: 1,
    message:
      `[KERNEL] Port ${port} is already in use by another program — most likely another AEON. ` +
      `This AEON did not start. Close the other one, or start this one on another port ` +
      `(for example PORT=${port + 1}).`,
  };
}

module.exports = { onAddrInUse, MAX_ATTEMPTS, RETRY_MS };
