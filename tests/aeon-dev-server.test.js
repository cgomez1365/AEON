/**
 * `aeon dev <id>` runs a block the way AEON would, on loopback, and a save
 * really remounts it.
 *
 * Found 2026-10-02 (block-builder readiness audit) scaffolding a throwaway
 * block with `aeon new` and running `aeon dev` on it:
 *
 *   1. It listened on 0.0.0.0:3002 — every interface, with no auth in front
 *      of the block's routes.
 *   2. Its deps were { isVercel, fs, path, getLocalFile }: a block written
 *      against the sanctioned deps.blockStorage (what every guide teaches)
 *      threw on its first request.
 *   3. Remount filtered layers on an `_aeonDev` tag nothing set, so each save
 *      stacked a router behind the first and the first code kept answering.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPRESS_PATH = require.resolve('express');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-dev-'));
const DIR = path.join(TMP, 'dev_probe');

fs.mkdirSync(path.join(DIR, 'api'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'block.manifest.json'), JSON.stringify({
  manifestVersion: '1.1.0', id: 'dev_probe', label: 'Dev Probe', route: '/dev_probe', version: '0.0.1', api_routes: true,
  contract: {
    permissions: { filesystem: 'write', network: 'none', secrets: false, shell: false, ai: false },
    storage: { type: 'json', scope: 'block', local: { indexed: false, retention: 'operational' }, access: 'scoped' },
    memory: { mode: 'none', indexed: false, userConfigurable: false },
    settings: [{ key: 'poll_minutes', type: 'number', default: 15 }],
  },
}));
const api = (version) => `
const express = require(${JSON.stringify(EXPRESS_PATH)});
module.exports = (deps) => {
  const router = express.Router();
  router.post('/dev_probe/hit', (_q, s) => {
    const n = deps.blockStorage.readJSON('count.json', 0) + 1;
    deps.blockStorage.writeJSON('count.json', n);
    s.json({ n, version: ${JSON.stringify(version)}, poll: deps.blockSettings().poll_minutes, timers: typeof deps.lifecycle.setInterval });
  });
  return router;
};`;
fs.writeFileSync(path.join(DIR, 'api', 'dev_probe.cjs'), api('v1'));

let child;
afterAll(() => {
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function startDev() {
  child = spawn(process.execPath, [path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'dev', DIR, '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`aeon dev did not start:\n${out}`)), 15000);
    const onData = (d) => {
      out += d;
      const m = out.match(/on http:\/\/([0-9.]+):(\d+)/);
      if (m) { clearTimeout(t); resolve({ host: m[1], port: Number(m[2]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

const hit = (port) => fetch(`http://127.0.0.1:${port}/api/dev_probe/hit`, { method: 'POST' }).then((r) => r.json());

describe('aeon dev', () => {
  it('binds loopback, hands the block its real deps, and remounts on save', async () => {
    const { host, port } = await startDev();
    expect(host).toBe('127.0.0.1');

    expect(await hit(port)).toEqual({ n: 1, version: 'v1', poll: 15, timers: 'function' });
    expect((await hit(port)).n).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'count.json'), 'utf8'))).toBe(2);

    fs.writeFileSync(path.join(DIR, 'api', 'dev_probe.cjs'), api('v2'));
    let got = null;
    for (let i = 0; i < 40 && got?.version !== 'v2'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      got = await hit(port);
    }
    expect(got.version).toBe('v2');
  }, 20000);
});
