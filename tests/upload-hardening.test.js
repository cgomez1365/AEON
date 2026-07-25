import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const multer = require('multer');
const storage = require('../services/storage.js');

describe('upload hardening (BO5 — multer)', () => {
  it('is on patched multer (>=2.2.0 — nested-field DoS + aborted-upload cleanup)', () => {
    const [maj, min] = require('multer/package.json').version.split('.').map(Number);
    expect(maj > 2 || (maj === 2 && min >= 2)).toBe(true);
  });

  it('reduces a traversal filename to a bare basename', () => {
    expect(storage.safeUploadName('../../etc/passwd')).toBe('passwd');
    expect(storage.safeUploadName('a\\b\\c.txt')).toBe('c.txt');
    expect(storage.safeUploadName('report.pdf')).toBe('report.pdf');
    expect(storage.safeUploadName('..')).toMatch(/^upload_/);
    expect(storage.safeUploadName('')).toMatch(/^upload_/);
  });

  it('declares sane multipart bounds', () => {
    const L = storage.UPLOAD_LIMITS;
    expect(L.fileSize).toBe(50 * 1024 * 1024);
    expect(L.files).toBe(20);
    expect(L.fields).toBeLessThanOrEqual(50);
    expect(L.parts).toBeLessThanOrEqual(100);
    expect(L.fieldNameSize).toBeGreaterThan(0);
  });

  describe('multipart enforcement (live server)', () => {
    let tmp, server, origin;
    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-upload-'));
      const app = express();
      // The app's real config: exported limits + basename sanitizer, temp dest.
      // fileSize is shrunk to 1 KB so the size test stays fast.
      const up = multer({
        storage: multer.diskStorage({
          destination: (req, f, cb) => cb(null, tmp),
          filename: (req, f, cb) => cb(null, storage.safeUploadName(f.originalname)),
        }),
        limits: { ...storage.UPLOAD_LIMITS, fileSize: 1024 },
      });
      app.post('/up', up.array('files', 20), (req, res) => {
        res.json({ ok: true, saved: (req.files || []).map(f => path.basename(f.path)) });
      });
      app.use((err, req, res, next) => res.status(413).json({ error: err.code || err.message }));
      server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      origin = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(() => { if (server) server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

    async function post(fd) {
      const res = await fetch(`${origin}/up`, { method: 'POST', body: fd });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    it('stores an upload under a sanitized basename, never escaping the dest', async () => {
      const fd = new FormData();
      fd.append('files', new Blob([new Uint8Array([104, 105])]), '../../escape.txt');
      const r = await post(fd);
      expect(r.status).toBe(200);
      expect(r.body.saved).toContain('escape.txt');
      expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(true);
      expect(fs.existsSync(path.resolve(tmp, '..', '..', 'escape.txt'))).toBe(false);
    });

    it('rejects a file that exceeds the size limit', async () => {
      const fd = new FormData();
      fd.append('files', new Blob([new Uint8Array(4096).fill(0x41)]), 'big.bin');
      const r = await post(fd);
      expect(r.status).toBe(413);
      expect(String(r.body.error)).toMatch(/LIMIT_FILE_SIZE/);
    });

    it('bounds the number of multipart fields', async () => {
      const fd = new FormData();
      for (let i = 0; i < 60; i++) fd.append(`f${i}`, 'x'); // > fields:50
      fd.append('files', new Blob([new Uint8Array([111, 107])]), 'ok.txt');
      const r = await post(fd);
      expect(r.status).toBe(413);
      expect(String(r.body.error)).toMatch(/LIMIT_FIELD_COUNT|LIMIT_PART_COUNT/);
    });
  });
});
