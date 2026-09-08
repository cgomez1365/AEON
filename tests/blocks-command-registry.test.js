/**
 * /blocks lists the blocks that are actually mounted.
 *
 * The loader creates the registry and readiness maps AFTER the block deps
 * object is assembled, so kernel routers received them and blocks never did —
 * master's /blocks read deps._blockRegistry, got undefined, and reported
 * "no blocks registered" on a running install with 17 blocks mounted
 * (CEO, Windows clone, 2026-09-07). Proven live after the fix: 17 listed.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const masterRouter = require('../src/blocks/master/api/master.cjs');

describe('/blocks', () => {
  it('the loader hands its registry and readiness to blocks before mounting them', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/block-loader.js'), 'utf8');
    const assign = src.indexOf('baseDeps._blockRegistry = _blockRegistry');
    const host = src.indexOf('_blockHost = createBlockHost({');
    expect(assign).toBeGreaterThan(-1);
    expect(assign).toBeLessThan(host);   // assigned BEFORE any block is mounted
    expect(src).toMatch(/baseDeps\._blockReadiness = _blockReadiness/);
  });

  it('master renders one line per registered block with its readiness', async () => {
    const registry = [{ id: 'aeon_matrix', label: 'Aeon Matrix' }, { id: 'master', label: 'Master' }];
    const readiness = { aeon_matrix: { ready: false }, master: { ready: true } };
    const app = express(); app.use('/api', masterRouter({ _blockRegistry: registry, _blockReadiness: readiness }));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/master/registry`)).json();
      expect(d.count).toBe(2);
      expect(d.text).toBe('○ aeon_matrix\n● master');
    } finally { server.close(); }
  });

  it('still says so honestly when the registry really is empty', async () => {
    const app = express(); app.use('/api', masterRouter({ _blockRegistry: [], _blockReadiness: {} }));
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/master/registry`)).json();
      expect(d.text).toBe('no blocks registered');
    } finally { server.close(); }
  });
});
