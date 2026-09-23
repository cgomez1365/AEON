/**
 * Settings → Blocks lists the blocks that are installed — not the scaffolds.
 *
 * Measured 2026-09-23 on a live server: GET /api/settings/blocks answered 19
 * entries, two of them `__BLANK__` (folder `_blank`) and `_template`. Those are
 * scaffolds: the kernel never mounts a folder starting with `_` (blockHost
 * rescan, gen-block-routes isScaffold), and the lifecycle routes refuse them
 * as "no installed block". The tab said "Installed blocks — 19" on an install
 * with 17, and the new Stop/Remove controls would have offered buttons that
 * can only 404.
 *
 * Reads the real src/blocks tree; writes nothing there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOCKS = path.join(__dirname, '..', 'src', 'blocks');

// SECRETS_DIR is resolved at module scope (see model-catalogue.test.js).
const SECRETS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-blocks-'));
process.env.AEON_SECRETS_DIR = SECRETS_TMP;

const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

let server;
let list;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountSettingsApi(app, { supabase: null });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/settings/blocks`);
  list = await res.json();
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(SECRETS_TMP, { recursive: true, force: true });
});

describe('/api/settings/blocks', () => {
  it('leaves out every `_` scaffold folder', () => {
    const ids = list.map((b) => b.id);
    expect(ids).not.toContain('__BLANK__');
    expect(ids).not.toContain('_template');
    expect(ids.filter((id) => String(id).startsWith('_'))).toEqual([]);
  });

  it('lists exactly the folders the kernel mounts', () => {
    const mounted = fs.readdirSync(BLOCKS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .filter((d) => fs.existsSync(path.join(BLOCKS, d.name, 'block.manifest.json')))
      .map((d) => d.name)
      .sort();
    expect(list.map((b) => b.id).sort()).toEqual(mounted);
  });
});
