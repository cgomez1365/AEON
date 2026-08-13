/**
 * The converter is executed. Therefore it is pinned and hash-verified.
 *
 * Audit 2026-08-11 P0-05. converterUrl() defaulted to `master` — a MUTABLE
 * branch ref — and ensureConverter() fetched it, checked it against a loose
 * content regex (`/convert_hf_to_gguf|Model|gguf/`), wrote it to disk and
 * convert() then ran it through Python with operator privileges. An
 * independent harness replaced global fetch() with an arbitrary >1KB Python
 * payload; ensureConverter() accepted it and convert() returned convertOk:true.
 *
 * Any payload containing the word "gguf" satisfied that regex. This is
 * unverified-download-then-execute, which is the definition of the class.
 *
 * The pin lives in runtime-assets.json beside the runtime binaries, which were
 * already pinned and hash-verified — one place, one mechanism, rather than a
 * second scheme invented for this file.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { converterUrl, ensureConverter } from '../services/local-runtime/model-converter.cjs';
import assets from '../services/local-runtime/runtime-assets.json';

const PIN = assets.converter;
let workDir;
const realFetch = globalThis.fetch;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-conv-'));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

/** Serve `body` for any fetch, exactly as the audit harness did. */
function stubFetch(body) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  });
}

describe('the pin', () => {
  it('exists, with a tag and a sha256', () => {
    expect(PIN, 'runtime-assets.json has no converter pin').toBeTruthy();
    expect(PIN.tag).toMatch(/^b\d+$/);
    expect(PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the runtime release, so the converter cannot drift from the binaries', () => {
    expect(PIN.tag).toBe(assets.releaseTag);
  });
});

describe('mutable refs are refused', () => {
  it('refuses master — the pre-fix default', () => {
    expect(() => converterUrl('master')).toThrow(/mutable ref/i);
  });

  it.each(['main', 'HEAD', 'refs/heads/master', '', null, undefined])('refuses %s', (ref) => {
    expect(() => converterUrl(ref)).toThrow(/mutable ref/i);
  });

  it('accepts a release tag and a full commit SHA', () => {
    expect(converterUrl('b10216')).toContain('/b10216/');
    const sha = 'a'.repeat(40);
    expect(converterUrl(sha)).toContain(`/${sha}/`);
  });
});

describe('unverified code is not written or executed', () => {
  // The audit's exact harness. This is the assertion that matters.
  it('refuses an attacker-controlled payload that satisfies the old regex', async () => {
    const payload = `# convert_hf_to_gguf gguf Model\nimport os\nos.system("whoami")\n${'#'.repeat(1200)}`;
    stubFetch(payload);

    const r = await ensureConverter({ workDir, runtimeTag: PIN.tag });

    expect(r.ok, 'an unverified payload was accepted').toBe(false);
    expect(r.error).toMatch(/hash mismatch|Refusing to execute/i);
    // And nothing was left on disk for convert() to run.
    expect(fs.existsSync(path.join(workDir, 'convert_hf_to_gguf.py'))).toBe(false);
  });

  it('accepts a payload whose hash matches the pin', async () => {
    // Synthesise a body with the pinned hash by pinning the hash of this body.
    const body = 'print("pinned converter stand-in")\n';
    const sha = crypto.createHash('sha256').update(Buffer.from(body)).digest('hex');
    const patched = { ...PIN, sha256: sha };

    // Drive ensureConverter against a patched manifest via the module cache.
    const manifestPath = require.resolve('../services/local-runtime/runtime-assets.json');
    const original = require.cache[manifestPath];
    require.cache[manifestPath] = { id: manifestPath, filename: manifestPath, loaded: true, exports: { ...assets, converter: patched } };
    try {
      stubFetch(body);
      const r = await ensureConverter({ workDir, runtimeTag: patched.tag });
      expect(r.ok, r.error).toBe(true);
      expect(r.sha256).toBe(sha);
      expect(fs.existsSync(path.join(workDir, 'convert_hf_to_gguf.py'))).toBe(true);
    } finally {
      if (original) require.cache[manifestPath] = original; else delete require.cache[manifestPath];
    }
  });

  it('re-verifies a cached converter rather than trusting the file on disk', async () => {
    // A one-time check is a formality anything with write access can step past.
    const dest = path.join(workDir, 'convert_hf_to_gguf.py');
    fs.writeFileSync(dest, `# gguf Model convert_hf_to_gguf\n${'#'.repeat(2000)}`);

    stubFetch('anything');
    const r = await ensureConverter({ workDir, runtimeTag: PIN.tag });

    expect(r.ok, 'a tampered cached converter was reused').toBe(false);
    expect(fs.existsSync(dest), 'the failing cached file was left in place').toBe(false);
  });

  it('refuses a tag that disagrees with the pin', async () => {
    stubFetch('x');
    const r = await ensureConverter({ workDir, runtimeTag: 'b99999' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match the pinned tag/);
  });
});
