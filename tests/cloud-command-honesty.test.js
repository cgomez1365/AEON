/**
 * A command that needs Supabase says so when there is none.
 *
 * On the Windows clone (CEO, 2026-09-07) /push and /vault-push reported success
 * on an install with no cloud keys — a false positive; nothing was synced. The
 * three cloud commands now declare `when: "supabase"`, the registry asks the
 * server for the live client, and an unlinked install gets a 409 that names the
 * dependency and the remedy (§08). /tree and /upload were removed in the same
 * pass; /upload came back the same day as a file picker with a destination.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const createRegistry = require('../src/kernel/commandRegistry.cjs');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocks/aeon_matrix/block.manifest.json'), 'utf8'));
const cmds = manifest.contract.commands;

async function mount(isCloudLinked) {
  const reg = createRegistry({ blockReadiness: { aeon_matrix: { ready: true } }, isVercel: false, isCloudLinked });
  const app = express(); app.use(express.json()); app.use('/api', reg.router);
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}/api`;
  return {
    close: () => s.close(),
    list: async () => (await fetch(`${base}/commands`)).json(),
    run: async (cmd) => { const r = await fetch(`${base}/commands/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) }); return { status: r.status, body: await r.json() }; },
  };
}

describe('cloud commands on a local install', () => {
  it('/push /pull /vault-push declare the dependency; /tree is gone, /upload takes no argument', () => {
    for (const c of ['/push', '/pull', '/vault-push']) expect(cmds.find(x => x.cmd === c)?.when).toBe('supabase');
    expect(cmds.find(x => x.cmd === '/tree')).toBeUndefined();
    expect(cmds.find(x => x.cmd === '/upload')?.argRequired).toBe(false); // picker form
  });

  it('unlinked: listed as unavailable, and running one says what is missing and how to fix it', async () => {
    const h = await mount(() => false);
    try {
      const list = await h.list();
      const push = (list.commands || list).find(x => x.cmd === '/push');
      expect(push.available).toBe(false);
      const r = await h.run('/push');
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/Supabase/);
      expect(r.body.error).toMatch(/SUPABASE_URL/);
      expect(r.body.error).toMatch(/nothing is lost/);
      expect(r.body.error).not.toMatch(/requires: supabase/); // not the generic line
    } finally { h.close(); }
  });

  it('linked: the gate opens', async () => {
    const h = await mount(() => true);
    try {
      const list = await h.list();
      expect((list.commands || list).find(x => x.cmd === '/push').available).toBe(true);
      const r = await h.run('/push');
      expect(r.status).not.toBe(409);
    } finally { h.close(); }
  });

  it('the server hands the registry the live client, not a copy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
    expect(src).toMatch(/isCloudLinked: \(\) => !!supabase/);
  });
});
