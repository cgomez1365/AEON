import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// AEON_SECRETS_DIR must be set BEFORE the require. endpoints.cjs resolves
// SECRETS_DIR at module scope and mkdirSync's it there, so requiring this
// module with the variable unset creates `secrets/` inside the repo.
//
// Harmless in itself — the directory is empty — but it is the same rule that
// was learned expensively on 2026-08-03: a test may OBSERVE a live instance,
// it may not PROVISION one. On a developer machine the directory already
// exists, so this was invisible; it only showed up when a bare clone was
// checked after a full run (BO-A stress test). A clean-room gate now asserts
// the property directly rather than relying on someone thinking to look.
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lmstudio-'));
process.env.AEON_SECRETS_DIR = tempSecrets;

const endpoints = require('../src/kernel/endpoints.cjs');

afterAll(() => { try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {} });

// BO7 — the LM Studio host default lives in exactly one place (endpoints.cjs)
// and is env-overridable; Settings resolves through it rather than hardcoding.
describe('LM Studio endpoint resolution (BO7)', () => {
  const original = process.env.LMSTUDIO_HOST;
  afterEach(() => {
    if (original === undefined) delete process.env.LMSTUDIO_HOST;
    else process.env.LMSTUDIO_HOST = original;
  });

  it('defaults to localhost:1234 when no override is configured', () => {
    delete process.env.LMSTUDIO_HOST;
    expect(endpoints.lmStudioHost()).toBe('http://localhost:1234');
  });

  it('honors a configured LMSTUDIO_HOST override (host and port)', () => {
    process.env.LMSTUDIO_HOST = 'http://192.168.1.50:4321';
    expect(endpoints.lmStudioHost()).toBe('http://192.168.1.50:4321');
  });
});
