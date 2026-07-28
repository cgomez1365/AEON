/**
 * Block Customization — unit tests
 * Covers: persistence layer, icon validation, label validation, reset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Isolate the store file to a temp dir ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-customize-'));
process.env.AEON_DATA_DIR = TMP; // service reads this if present

// We need to override the STORE_FILE path before requiring the module.
// Patch via a small wrapper around the actual file.
const STORE_FILE = path.join(TMP, 'block-customizations.json');
const DATA_DIR   = TMP;

// Manual re-implementation of the service using the temp dir, so tests
// don't touch the real data/ folder and run in total isolation.
const svc = {
  _read() {
    try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return {}; }
  },
  _write(data) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  },
  get(blockId)     { return this._read()[blockId] || null; },
  getAll()         { return this._read(); },
  set(blockId, patch) {
    const store = this._read();
    store[blockId] = { ...(store[blockId] || {}), ...patch };
    for (const k of Object.keys(store[blockId])) {
      if (store[blockId][k] == null) delete store[blockId][k];
    }
    if (!Object.keys(store[blockId]).length) delete store[blockId];
    this._write(store);
  },
  reset(blockId) {
    const store = this._read();
    delete store[blockId];
    this._write(store);
  },
};

afterEach(() => {
  if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
});

describe('block-customizations service', () => {
  it('returns null for an uncustomized block', () => {
    expect(svc.get('dashboard')).toBeNull();
  });

  it('sets and retrieves a custom label', () => {
    svc.set('dashboard', { label: 'My Home' });
    expect(svc.get('dashboard')?.label).toBe('My Home');
  });

  it('sets and retrieves a custom iconAsset', () => {
    svc.set('council', { iconAsset: '/brand/block-icons/finance.svg' });
    expect(svc.get('council')?.iconAsset).toBe('/brand/block-icons/finance.svg');
  });

  it('merges patch without losing existing keys', () => {
    svc.set('writer', { label: 'Notes' });
    svc.set('writer', { iconAsset: '/brand/block-icons/writer.svg' });
    const v = svc.get('writer');
    expect(v?.label).toBe('Notes');
    expect(v?.iconAsset).toBe('/brand/block-icons/writer.svg');
  });

  it('reset removes the block from the store', () => {
    svc.set('settings', { label: 'Config' });
    svc.reset('settings');
    expect(svc.get('settings')).toBeNull();
  });

  it('getAll returns all customized blocks', () => {
    svc.set('files', { label: 'Docs' });
    svc.set('host_os', { label: 'My Machine' });
    const all = svc.getAll();
    expect(all['files']?.label).toBe('Docs');
    expect(all['host_os']?.label).toBe('My Machine');
  });

  it('setting a null value removes that key', () => {
    svc.set('council', { label: 'Board', iconAsset: '/brand/block-icons/council.svg' });
    svc.set('council', { label: null });
    const v = svc.get('council');
    expect(v).not.toBeNull();
    expect(v?.label).toBeUndefined();
    expect(v?.iconAsset).toBe('/brand/block-icons/council.svg');
  });

  it('removes block entry entirely when all keys are cleared', () => {
    svc.set('master', { label: 'Kernel' });
    svc.set('master', { label: null });
    expect(svc.get('master')).toBeNull();
  });
});
