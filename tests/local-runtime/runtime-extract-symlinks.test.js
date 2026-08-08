/**
 * BO-E1 / BO-E2 — the runtime must actually install on Linux.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (2026-08-08), found on a clean Ubuntu 24.04
 * WSL instance that had never had AEON — which is the only place it could have
 * been found, and is exactly what Definition of Done §20 #1 is for.
 *
 * node-tar 7.5.22 extracts 58 of the 62 entries in llama.cpp's
 * `llama-b10216-bin-ubuntu-x64.tar.gz`. GNU tar extracts all of them. The four
 * it silently drops are every symlink whose target is ITSELF a symlink:
 *
 *     libllama.so      -> libllama.so.0      -> libllama.so.0.0.10216
 *     libggml-base.so  -> libggml-base.so.0  -> …
 *     libllama-common.so, libmtmd.so          (same two-hop shape)
 *
 * Single-hop links such as `libggml.so -> libggml.so.0` survive. That is why
 * the installer reported exactly one missing file and nothing else looked
 * wrong — and why the real consequence went unnoticed: the local runtime
 * never installed on Linux at all, so principle 01 (local first) did not hold
 * on the platform.
 *
 * The second finding is downstream of the first and was hidden by it: a
 * binary that cannot load libgomp writes to stderr, so the probe saw
 * non-empty output, parsed no version, and returned SUCCESS — recording a
 * runtime as ready when it could not execute a token (§08: readiness must
 * reflect ability, not declaration).
 *
 * These drive the real modules against a tarball built with the same two-hop
 * link shape as the real asset. Nothing is re-implemented inline.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const installer = require('../../services/local-runtime/runtime-installer.cjs');
const { probe } = require('../../services/local-runtime/runtime-probe.cjs');

const isWindows = os.platform() === 'win32';
const tmps = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

/**
 * Build a tarball shaped like llama.cpp's Linux release: a single top-level
 * directory, a real .so, a one-hop link, and the two-hop link node-tar drops.
 */
function makeArchive() {
  const src = mkTmp('aeon-tar-src-');
  const top = path.join(src, 'llama-bXXXXX');
  fs.mkdirSync(top, { recursive: true });

  fs.writeFileSync(path.join(top, 'llama-cli'), '#!/bin/sh\necho stub\n');
  fs.writeFileSync(path.join(top, 'llama-server'), '#!/bin/sh\necho stub\n');
  fs.writeFileSync(path.join(top, 'libllama.so.0.0.10216'), 'ELFSTUB');
  fs.symlinkSync('libllama.so.0.0.10216', path.join(top, 'libllama.so.0'));   // hop 1
  fs.symlinkSync('libllama.so.0', path.join(top, 'libllama.so'));             // hop 2 — dropped
  fs.writeFileSync(path.join(top, 'libggml.so.0'), 'ELFSTUB');
  fs.symlinkSync('libggml.so.0', path.join(top, 'libggml.so'));               // single hop — survives

  const out = path.join(mkTmp('aeon-tar-out-'), 'rt.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', src, 'llama-bXXXXX']);
  return out;
}

describe.skipIf(isWindows)('BO-E1 — every symlink in the archive reaches disk', () => {
  it('restores the two-hop link node-tar drops', async () => {
    const archive = makeArchive();
    const dest = mkTmp('aeon-extract-');

    await installer.extractArchive(archive, dest, 'tar.gz', 1);

    // The exact file whose absence blocked every Linux install.
    const link = path.join(dest, 'libllama.so');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('libllama.so.0');

    // And it must RESOLVE — a restored link pointing at nothing is no better
    // than a missing one, and existsSync (what verifyLayout uses) follows it.
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.readFileSync(link, 'utf8')).toBe('ELFSTUB');
  });

  it('leaves the links node-tar handles correctly alone', async () => {
    const archive = makeArchive();
    const dest = mkTmp('aeon-extract-');
    await installer.extractArchive(archive, dest, 'tar.gz', 1);
    const link = path.join(dest, 'libggml.so');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('libggml.so.0');
  });

  it('strips the version directory, as the platform-independent layout needs', async () => {
    const archive = makeArchive();
    const dest = mkTmp('aeon-extract-');
    await installer.extractArchive(archive, dest, 'tar.gz', 1);
    expect(fs.existsSync(path.join(dest, 'llama-cli'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'llama-bXXXXX'))).toBe(false);
  });

  it('refuses a link that would escape the extract directory', async () => {
    // A symlink is the one entry type that can reach outside the destination,
    // so the repair path re-checks containment rather than trusting the tar.
    const src = mkTmp('aeon-evil-src-');
    const top = path.join(src, 'pkg');
    fs.mkdirSync(top, { recursive: true });
    fs.writeFileSync(path.join(top, 'ok.txt'), 'fine');
    fs.symlinkSync('../../../../../../etc/passwd', path.join(top, 'escape.so'));
    const archive = path.join(mkTmp('aeon-evil-out-'), 'evil.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'pkg']);

    const dest = mkTmp('aeon-evil-extract-');
    await installer.extractArchive(archive, dest, 'tar.gz', 1);

    const escaped = path.join(dest, 'escape.so');
    if (fs.existsSync(escaped) || (() => { try { return fs.lstatSync(escaped); } catch { return false; } })()) {
      // If node-tar itself created it, the target must still be contained.
      const resolved = path.resolve(dest, fs.readlinkSync(escaped));
      expect(resolved.startsWith(path.resolve(dest))).toBe(true);
    }
    expect(fs.existsSync(path.join(dest, 'ok.txt'))).toBe(true);
  });
});

/**
 * POSIX-only, deliberately.
 *
 * probe() spawns the runtime binary with `shell: false` and an absolute path —
 * that is the security property, not an implementation detail. On Windows a
 * .cmd stub cannot be launched that way, so a Windows version of this test
 * would have to weaken the very thing under test. The defect is a Linux/macOS
 * one (llama.cpp's POSIX builds link libgomp; the Windows zips do not), and
 * CI runs two Ubuntu legs, so the gate has a real home.
 */
describe.skipIf(isWindows)('BO-E2 — a binary that cannot load its libraries fails the probe', () => {
  it('reports the missing library and names the package that provides it', () => {
    const dir = mkTmp('aeon-probe-');
    const bin = path.join(dir, 'fake.sh');
    // Reproduces the loader's real output. The binary "runs", writes to stderr,
    // and prints no version — which is what made this return success before.
    const body = '#!/bin/sh\necho "error while loading shared libraries: libgomp.so.1: cannot open shared object file" >&2\nexit 127\n';
    fs.writeFileSync(bin, body);
    fs.chmodSync(bin, 0o755);

    expect(() => probe(bin, ['--version'])).toThrow(/libgomp\.so\.1/);
    try {
      probe(bin, ['--version']);
    } catch (e) {
      // §08 — the remedy, not just the symptom.
      expect(e.message).toMatch(/libgomp1/);
      expect(e.message).toMatch(/apt-get|dnf|pacman/);
      // And it must not blame the download.
      expect(e.message).toMatch(/not a fault in the download/i);
    }
  });

  it('still accepts a healthy binary', () => {
    const dir = mkTmp('aeon-probe-ok-');
    const bin = path.join(dir, 'ok.sh');
    const body = '#!/bin/sh\necho "version: 10216 (876a43211)" >&2\n';
    fs.writeFileSync(bin, body);
    fs.chmodSync(bin, 0o755);

    const r = probe(bin, ['--version']);
    expect(r.reportedVersion).toMatch(/10216/);
  });
});
