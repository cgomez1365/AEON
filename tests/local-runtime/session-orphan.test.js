/**
 * A llama-server must not outlive the AEON that started it.
 *
 * Found 2026-09-22: four idle llama-servers, parent PID 1, running for two
 * days after their AEONs died. The graceful path (SIGINT/SIGTERM → shutdown())
 * stops them, and closing the terminal hangs up the whole process group
 * (llama-server exits on SIGHUP — measured). But process.exit — what the
 * crash handler does on a fatal error — runs neither. An idle llama-server
 * never writes, so it never learns its reader is gone. On a carried drive it
 * holds the model file open and the drive cannot be ejected.
 *
 * The stand-in here is a real process serving /health on the port it is
 * given, like llama-server, and silent afterwards, like an idle one.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSION = path.join(ROOT, 'services', 'local-runtime', 'server-session.cjs');

let tmp;
let stubPid = null;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-orphan-')); });
afterEach(() => {
  if (stubPid) { try { process.kill(stubPid, 'SIGKILL'); } catch { /* gone */ } }
  stubPid = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it.skipIf(process.platform === 'win32')('process.exit — a fatal crash — takes its llama-server with it', async () => {
  const rt = path.join(tmp, 'runtime');
  fs.mkdirSync(rt);
  const pidFile = path.join(tmp, 'stub.pid');
  const stub = path.join(tmp, 'stub.cjs');
  fs.writeFileSync(stub, `
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    require('http').createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"status":"ok"}'); })
      .listen(port, '127.0.0.1');
  `);
  const bin = path.join(rt, 'llama-server');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const model = path.join(tmp, 'model.gguf');
  fs.writeFileSync(model, 'gguf');

  const parent = `
    const { ServerSession } = require(${JSON.stringify(SESSION)});
    new ServerSession({ entryAbsPath: ${JSON.stringify(path.join(rt, 'entry'))}, modelAbsPath: ${JSON.stringify(model)}, embeddings: true })
      .start().then(() => process.exit(1), (e) => { console.error(e.message); process.exit(2); });
  `;
  const r = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8', timeout: 30000 });
  expect(r.status, r.stderr).toBe(1); // started, then died the way a fatal crash does
  stubPid = Number(fs.readFileSync(pidFile, 'utf8'));

  const deadline = Date.now() + 3000;
  while (alive(stubPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  expect(alive(stubPid)).toBe(false);
}, 40000);
