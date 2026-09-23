/**
 * Process guards — a console that goes away must not take the server with it.
 *
 * Measured 2026-09-22 on the CEO's Mac: AEON was launched twice, two seconds
 * apart. The copy that lost the port race kept logging; when its terminal went
 * away every write to stdout/stderr failed with EIO. Node emits a failed stdio
 * write as an 'error' event, and with no listener that is an uncaught
 * exception. The crash handler logged it with console.error — to the same dead
 * terminal — which failed, which was another uncaught exception. Node resets a
 * stdio stream after each error (it never stays closed), so the cycle had no
 * end: 1 h 42 min at 90% CPU, 20.6 GB of one identical stack trace in
 * data/logs/uncaught.log. Node's console has its own guard for this and it
 * does not cover this path — the error is emitted after that guard is removed.
 *
 *   installStreamGuards — a permanent 'error' listener on stdout and stderr.
 *     Any error there means only that console output has nowhere to go; it is
 *     absorbed and reported ONCE per stream and code (R-05), never raised.
 *
 *   appendCrashLog — the crash log rotates at a cap (one previous file kept),
 *     so no future loop, of any kind, can grow it without bound.
 */
const fs = require('fs');
const path = require('path');

const GUARDED = Symbol.for('aeon.processGuards.stream');
const DEFAULT_LIMIT_BYTES = 5 * 1024 * 1024;

function installStreamGuards(proc = process, { onLost } = {}) {
  for (const name of ['stdout', 'stderr']) {
    const stream = proc[name];
    if (!stream || stream[GUARDED]) continue;
    const reported = new Set();
    stream.on('error', (err) => {
      const code = err?.code || 'UNKNOWN';
      if (reported.has(code)) return;
      reported.add(code);
      try { onLost?.(name, code); } catch { /* the report must not re-open the loop */ }
    });
    stream[GUARDED] = true;
  }
}

/** Append one entry; rotate first when it would pass the cap. Never throws. */
function appendCrashLog(file, line, { limitBytes = DEFAULT_LIMIT_BYTES } = {}) {
  try {
    const text = `${line}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* no log yet */ }
    if (size > 0 && size + Buffer.byteLength(text) > limitBytes) {
      // Cannot rotate (file held open elsewhere)? Drop the entry — the cap is
      // the guarantee, a missing line is the lesser loss.
      try { fs.renameSync(file, `${file}.1`); } catch { return false; }
    }
    fs.appendFileSync(file, text);
    return true;
  } catch {
    return false;
  }
}

module.exports = { installStreamGuards, appendCrashLog, DEFAULT_LIMIT_BYTES };
