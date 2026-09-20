/**
 * The Cloudflare tunnel asks for the binary this machine can actually run.
 *
 * Found live, 2026-09-20 (CEO: "check... cloudflare tunnel"). CLOUDFLARED and
 * CLOUDFLARED_URL were hardcoded to cloudflared-windows-amd64.exe with no
 * os.platform() check. On the CEO's actual Mac, "Start tunnel" downloaded a
 * Windows PE binary that cannot execute — spawn() failed with a generic
 * "Could not start cloudflared: ..." instead of a clear "not supported here."
 * macOS additionally ships the binary inside a .tgz (verified against the
 * real release, cloudflare/cloudflared tag 2026.9.1) — a step the
 * Windows-only code never had to do at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

// Isolation before the require — createCloudCredentialStore() reaches the
// encrypted Vault. See tests/suite-touches-nothing.test.js.
const require = createRequire(import.meta.url);
process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tunnel-secrets-'));
const connectivity = require('../src/blocks/settings/api/connectivity.js');
const { cloudflaredTarget } = connectivity;

describe('cloudflaredTarget resolves a real, runnable release asset per platform', () => {
  it('windows: the .exe, amd64 by default, 386 on 32-bit — never linux/macOS assets', () => {
    expect(cloudflaredTarget('win32', 'x64')).toEqual({
      url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
      filename: 'cloudflared-windows-amd64.exe', archive: null,
    });
    expect(cloudflaredTarget('win32', 'ia32').filename).toBe('cloudflared-windows-386.exe');
  });

  it('macOS: the .tgz for the real chip, Intel and Apple Silicon both — the platform the CEO actually runs', () => {
    expect(cloudflaredTarget('darwin', 'x64')).toEqual({
      url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
      filename: 'cloudflared-darwin-amd64.tgz', archive: 'tgz',
    });
    expect(cloudflaredTarget('darwin', 'arm64')).toEqual({
      url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
      filename: 'cloudflared-darwin-arm64.tgz', archive: 'tgz',
    });
  });

  it('linux: a raw runnable binary, no archive step, per real arch', () => {
    expect(cloudflaredTarget('linux', 'x64').filename).toBe('cloudflared-linux-amd64');
    expect(cloudflaredTarget('linux', 'arm64').filename).toBe('cloudflared-linux-arm64');
    expect(cloudflaredTarget('linux', 'x64').archive).toBeNull();
  });

  it('an architecture cloudflare does not publish (e.g. linux/mips) is refused, not guessed', () => {
    expect(cloudflaredTarget('linux', 'mips')).toBeNull();
  });

  it('a platform with no published build at all is refused, not defaulted to Windows', () => {
    expect(cloudflaredTarget('freebsd', 'x64')).toBeNull();
    expect(cloudflaredTarget('sunos', 'x64')).toBeNull();
  });
});

describe('POST /tunnel/start requests the binary THIS machine can run', () => {
  // BIN_DIR is a fixed real repo path (tools/bin), not injectable — this
  // test relies on no binary already sitting there (true on a fresh clone;
  // the route's own existsSync check would otherwise skip straight to
  // spawn() and this test's fetch stub would see nothing). If it ever fails
  // with an empty `requested` array, tools/bin/ has a real cloudflared in
  // it — delete it and re-run.
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('fetches the URL cloudflaredTarget() computed for the real host, never the old hardcoded Windows one', async () => {
    const wanted = cloudflaredTarget(); // this test process's real platform/arch
    const requested = [];

    const app = express(); app.use(express.json());
    connectivity(app, {});
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

    // Stub AFTER the server is listening: the route's internal `fetch(...)`
    // call resolves globalThis.fetch at call time, so this intercepts only
    // the outbound download — the test's own request to its local server,
    // made below via origFetch, is unaffected either way.
    globalThis.fetch = (url) => {
      requested.push(String(url));
      // Refuse cleanly — this test proves WHAT was asked for, not that a
      // real download+extract+spawn succeeds in a sandboxed test run.
      return Promise.resolve({ ok: false, status: 599 });
    };

    try {
      const port = server.address().port;
      const res = await origFetch(`http://127.0.0.1:${port}/api/settings/connectivity/tunnel/start`, { method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/Could not download/);
      if (wanted) {
        expect(requested).toContain(wanted.url);
        expect(requested.some((u) => u.includes('cloudflared-windows'))).toBe(os.platform() === 'win32');
      }
    } finally { server.close(); }
  });
});
