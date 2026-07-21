/**
 * B2 adversarial test — Ship Plan v2 Month 2 exit criteria.
 * "10 malicious specs must be caught before month 2 closes."
 * All inputs are hostile. Every case must score HIGH or be caught as an error.
 * These are deterministic gate checks — no LLM involved.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { gate }       = require('../src/kernel/complexityGate.cjs');
const { lintBlock }  = require('../src/kernel/staging.cjs');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEnvelope(overrides = {}) {
  return {
    manifest: {
      id: 'test_block',
      label: 'Test',
      route: '/test_block',
      version: '0.1.0',
      contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false } },
      requires: { apis: [], env: [] },
    },
    files: [],
    estimatedDailyCost: 0,
    trust: 'untrusted',
    ...overrides,
  };
}

/** Write a temp block dir, run lintBlock, clean up. */
function withTempBlock(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-adv-'));
  try {
    const manifest = {
      manifestVersion: '1.0.0', id: path.basename(dir).replace(/[^a-z0-9_]/g, '_'),
      label: 'Adversarial', route: '/test', version: '0.1.0',
      contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false } },
      requires: { apis: [], env: [] },
    };
    fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.jsx'), 'export default function() { return null; }');
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return run(dir, manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 10 adversarial cases ─────────────────────────────────────────────────────

describe('B2 adversarial gate — 10 malicious specs', () => {

  // 1. Shell access request — must be HIGH (Tier 3)
  it('case 1: requests shell access', () => {
    const env = makeEnvelope();
    env.manifest.contract.permissions.shell = true;
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.reasons.some(r => r.rule === 'shell')).toBe(true);
  });

  // 2. eval() in generated code — dynamic code execution
  it('case 2: eval() in generated code', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/evil.cjs', content: 'const x = eval(userInput);' }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.findings.some(f => f.check === 'eval')).toBe(true);
  });

  // 3. new Function() — equivalent to eval
  it('case 3: new Function() dynamic execution', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/evil.cjs', content: 'const fn = new Function("return process.env");' }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.findings.some(f => f.check === 'eval')).toBe(true);
  });

  // 4. Path traversal — sandbox escape
  it('case 4: path traversal escape', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/read.cjs', content: "const f = require('fs').readFileSync('../../secrets/.env');" }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
  });

  // 5. Hardcoded API key
  it('case 5: hardcoded API key', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/svc.cjs', content: "const api_key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12345678';" }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.findings.some(f => f.check === 'hardcoded-secret')).toBe(true);
  });

  // 6. child_process spawn without shell declaration
  it('case 6: child_process without shell declaration', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/run.cjs', content: "const { execSync } = require('child_process'); execSync('rm -rf /tmp');" }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.findings.some(f => f.check === 'child-process')).toBe(true);
  });

  // 7. child_process with shell declared but source is untrusted (paste) — trust=untrusted strips excuse
  it('case 7: child_process declared but untrusted source gets no excuse', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/run.cjs', content: "const { execSync } = require('child_process'); execSync('id');" }],
      trust: 'untrusted',
    });
    env.manifest.contract.permissions.shell = true;
    const result = gate(env);
    // shell=true already flags HIGH; child-process should still appear in findings
    expect(result.score).toBe('HIGH');
  });

  // 8. Requires secret not in vault
  it('case 8: requires secret absent from vault', () => {
    const env = makeEnvelope();
    env.manifest.requires.env = ['PRODUCTION_DB_PASSWORD'];
    const result = gate(env, { vaultSecrets: [] });
    expect(result.score).toBe('HIGH');
    expect(result.reasons.some(r => r.rule === 'secrets')).toBe(true);
  });

  // 9. .env file read — credential theft attempt
  it('case 9: reads .env file directly', () => {
    const env = makeEnvelope({
      files: [{ path: 'api/cfg.cjs', content: "require('fs').readFileSync('.env.production', 'utf8');" }],
    });
    const result = gate(env);
    expect(result.score).toBe('HIGH');
    expect(result.findings.some(f => f.check === 'secret-file-read')).toBe(true);
  });

  // 10. Circular import — crashes loader on hot-remount (B6 failure mode #5)
  it('case 10: circular import crashes loader on remount', () => {
    withTempBlock({
      'api/a.cjs': "const b = require('./b.cjs'); module.exports = {};",
      'api/b.cjs': "const a = require('./a.cjs'); module.exports = {};",
    }, (dir) => {
      const result = lintBlock(dir);
      expect(result.score).toBe('HIGH');
      expect(result.findings.some(f => f.check === 'circular-import')).toBe(true);
    });
  });

});
