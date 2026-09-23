/**
 * `aeon install` must dispatch a command the kernel actually has.
 *
 * Measured 2026-09-23: `aeon install resume_grader` with a live session
 * answered "✗ Unknown command: master.install" and exited 1. The CLI routes an
 * install through the command bus by design (tools/aeon-cli.cjs: "master.install
 * → /api/store/install", so the kernel's confirmation gate and the airlock
 * apply) — but no block ever declared that command. The CLI was a client of
 * a command that did not exist.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listCommands() {
  const createRegistry = require('../src/kernel/commandRegistry.cjs');
  const reg = createRegistry({ blockReadiness: {} });
  const app = express();
  app.use('/api', reg.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/commands`)).json();
    return d.commands || d;
  } finally { server.close(); }
}

describe('aeon install', () => {
  it('dispatches the id the CLI names', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'utf8');
    expect(cli).toMatch(/dispatchAndRender\(client, render, 'master\.install'/);
  });

  it('that command exists, goes to the store\'s airlock, and is confirmation-gated', async () => {
    const cmds = await listCommands();
    const install = cmds.find((c) => c.id === 'master.install');
    expect(install, 'master.install is not a registered command').toBeTruthy();
    expect(install.route).toBe('/api/store/install');
    expect(String(install.method).toUpperCase()).toBe('POST');
    expect(install.dangerous).toBe(true);
  });
});
