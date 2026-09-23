/**
 * A second AEON must never kill the first one.
 *
 * 2026-09-22 (USB drive test): with the operator's own AEON already on :3001,
 * a second AEON booted from a drive hit EADDRINUSE and ran the handler in
 * server/server.js — a Windows-only `netstat | findstr | taskkill /F` against
 * WHATEVER held the port, in a retry loop with no limit.
 *
 *   - macOS / Linux: cmd.exe does not exist, the kill threw, the catch called
 *     it "port already free", and the server printed "Killing zombie and
 *     retrying..." once a second forever. It never started and never said why.
 *   - Windows: it force-kills the host's own AEON (or any program on that
 *     port), mid-write if unlucky, then takes its place.
 *
 * The fix: never signal another process. Retry briefly (a restart can race the
 * old process's shutdown), then stop with a message that names the port and
 * the remedy. Launchers that can run beside another AEON choose a free port
 * BEFORE boot (tools/free-port.cjs), because every module reads PORT at load.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Line-based on purpose. A regex that strips `/* ... */` spans also eats code
// whenever a string contains "/*" (server.js has '/api/*'), which is how the
// first draft of this test passed against the very taskkill it exists to catch.
const stripComments = (src) => src
  .split('\n')
  .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
  .join('\n');

describe('EADDRINUSE never kills another process', () => {
  it('server.js carries no process-killing command', () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8'));
    expect(code).not.toMatch(/taskkill/i);
    expect(code).not.toMatch(/\bkill\s+-9\b/);
    expect(code).not.toMatch(/\bfuser\b/);
    expect(code).not.toMatch(/lsof\s+-t/);
    expect(code).not.toMatch(/process\.kill\(/);
  });

  it('retries a bounded number of times, then stops with the port and the remedy', () => {
    const { onAddrInUse, MAX_ATTEMPTS } = require('../src/kernel/portConflict.cjs');
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const r = onAddrInUse({ port: 3001, attempt });
      expect(r.retry).toBe(true);
      expect(r.delayMs).toBeGreaterThan(0);
      expect(r.kill).toBeUndefined();
    }
    const last = onAddrInUse({ port: 3001, attempt: MAX_ATTEMPTS });
    expect(last.retry).toBe(false);
    expect(last.exitCode).toBe(1);
    expect(last.message).toMatch(/3001/);
    expect(last.message).toMatch(/PORT=/);
    expect(last.message).not.toMatch(/kill/i);
  });
});

describe('every module derives the kernel port from PORT', () => {
  // The tunnel pointed cloudflared at a literal 3001. On a machine where AEON
  // ran on another port, "Start tunnel" would have exposed whatever else was
  // on 3001 — for a drive plugged into a host that runs its own AEON, the
  // host's AEON.
  it('no shipped module assigns the kernel port from a bare literal', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(c?js|mjs)$/.test(e.name)) continue;
        const code = stripComments(fs.readFileSync(p, 'utf8'));
        code.split('\n').forEach((line, i) => {
          if (/\bPORT\s*=\s*3001\s*;/.test(line) && !/process\.env\.PORT/.test(line)) {
            offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
          }
        });
      }
    };
    for (const d of ['src', 'server', 'services']) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});

describe('tools/free-port.cjs', () => {
  const tool = path.join(ROOT, 'tools', 'free-port.cjs');
  const run = (...args) => execFileSync(process.execPath, [tool, ...args.map(String)], { encoding: 'utf8' }).trim();

  it('prints the first free port in the range and skips a busy one', async () => {
    const busy = net.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const port = busy.address().port;
    try {
      const got = Number(run(port, port + 20));
      expect(got).toBeGreaterThan(port);
      expect(got).toBeLessThanOrEqual(port + 20);
    } finally {
      await new Promise((r) => busy.close(r));
    }
  });

  it('exits non-zero, printing nothing on stdout, when the whole range is busy', async () => {
    // Exists first: a missing tool also "exits non-zero with empty stdout".
    expect(fs.existsSync(tool)).toBe(true);
    const busy = net.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const port = busy.address().port;
    try {
      let code = 0, out = '', err = '';
      try { out = run(port, port); } catch (e) { code = e.status; out = String(e.stdout || ''); err = String(e.stderr || ''); }
      expect(code).toBe(2);
      expect(out.trim()).toBe('');
      expect(err).toMatch(/no free port/i);
    } finally {
      await new Promise((r) => busy.close(r));
    }
  });
});
