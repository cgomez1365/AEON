/**
 * One authority for "where do blocks live" (BO-J1, src/kernel/blocksDir.cjs).
 *
 * The block host (server/block-loader.js) and the terminal's offline command
 * list still built `path.join(ROOT, 'src', 'blocks')`, so with AEON_BLOCKS_DIR
 * set the registry, readiness and the lifecycle routes read one tree while
 * the host mounted another (agent L, 2026-09-23).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// storage.js tests for an app root (it looks for src/blocks to recognise
// one); the fs-surface scan carries its own override. Neither mounts blocks.
const ALLOWED = new Set(['src/kernel/blocksDir.cjs', 'services/storage.js', 'tools/scan/block-fs-surface.cjs']);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(c?js|mjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

describe('the blocks root is read from blocksDir.cjs', () => {
  it('no server, kernel or tool module rebuilds it from the app root', () => {
    const offenders = [];
    for (const top of ['server', 'src/kernel', 'tools', 'services']) {
      for (const f of walk(path.join(ROOT, top))) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        if (ALLOWED.has(rel)) continue;
        if (/path\.join\(\s*ROOT\s*,\s*'src'\s*,\s*'blocks'/.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
