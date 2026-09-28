/**
 * "If settings declares it, that is what is going to be used" (CEO,
 * 2026-09-28). The audit that day found four blocks declaring settings
 * nothing read — Settings showed switches wired to nothing, including a
 * security lock toggle that did not lock — while the memory values chat
 * actually used had no control. This gate keeps both from returning.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');
const blockSettings = require('../src/kernel/blockSettings.cjs');

function codeFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) codeFiles(p, out);
    else if (/\.(c?js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('every declared block setting has a reader', () => {
  const sources = [...codeFiles(path.join(ROOT, 'src')), ...codeFiles(path.join(ROOT, 'server')), ...codeFiles(path.join(ROOT, 'services'))]
    .filter((f) => !f.includes(`${path.sep}settings${path.sep}index.jsx`)) // the panel that renders them is not a reader
    .map((f) => fs.readFileSync(f, 'utf8'));
  const declared = [];
  for (const id of fs.readdirSync(BLOCKS)) {
    const mp = path.join(BLOCKS, id, 'block.manifest.json');
    if (!fs.existsSync(mp)) continue;
    for (const def of (JSON.parse(fs.readFileSync(mp, 'utf8')).contract?.settings || [])) declared.push([id, def.key]);
  }

  it.each(declared)('%s.%s is read by code', (id, key) => {
    // master is the reference block: its example setting documents the contract.
    if (id === 'master') return;
    expect(sources.some((src) => src.includes(key)), `${id}.${key} is declared but nothing reads it`).toBe(true);
  });
});

describe('blockSettings.get resolves one value per setting', () => {
  it('manifest default when nothing is saved', () => {
    expect(blockSettings.get('memory_core', {})).toMatchObject({ memory_in_context: true, auto_memory: false, memory_max_context: 200 });
  });

  it('an install that set the value in its old home keeps it', () => {
    const s = { prefs: { brain_settings: { auto_memory: true, memory_max_context: 40 } } };
    expect(blockSettings.get('memory_core', s)).toMatchObject({ auto_memory: true, memory_max_context: 40 });
  });

  it('a value saved in Settings → Blocks wins over both', () => {
    const s = { prefs: { brain_settings: { auto_memory: true } }, blockSettings: { memory_core: { auto_memory: false } } };
    expect(blockSettings.get('memory_core', s).auto_memory).toBe(false);
  });
});
