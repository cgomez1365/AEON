/**
 * OCR's language data comes from disk unless the operator allowed a download
 * (audit A070).
 *
 * tesseract.js, given no langPath, fetches eng.traineddata from
 * cdn.jsdelivr.net on first use, and the Vault scan OCRs images and scanned
 * PDFs at boot — so a fresh install reached jsDelivr without being asked.
 * src/kernel/tesseractLang.cjs decides the worker's options: a cached or
 * packaged copy is read from disk, a download happens only with
 * AEON_OCR_DOWNLOAD=1, and otherwise OCR is refused with both remedies.
 * Pure: no worker is started and nothing is fetched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ocrWorkerOptions, downloadAllowed, CDN_LANG_PATH } = require('../src/kernel/tesseractLang.cjs');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ocr-data-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('where OCR language data comes from', () => {
  it('nothing on disk and no permission: refused, naming the host and both remedies', () => {
    const cacheDir = tmp();
    const r = ocrWorkerOptions({ cacheDir, allowDownload: false, packagedDir: null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ocr_data_missing');
    expect(r.error).toMatch(/cdn\.jsdelivr\.net/);
    expect(r.error).toMatch(/AEON_OCR_DOWNLOAD=1/);
    expect(r.error).toContain(cacheDir);
  });

  it('a copy tesseract already cached is read from disk — langPath is never left to the CDN default', () => {
    const cacheDir = tmp();
    fs.writeFileSync(path.join(cacheDir, 'eng.traineddata'), 'x');
    const r = ocrWorkerOptions({ cacheDir, allowDownload: false, packagedDir: null });
    expect(r).toMatchObject({ ok: true, source: 'cache', options: { cachePath: cacheDir, langPath: cacheDir, gzip: false } });
  });

  it('an installed @tesseract.js-data/eng package is read from disk', () => {
    const cacheDir = tmp();
    const packagedDir = tmp();
    const r = ocrWorkerOptions({ cacheDir, allowDownload: false, packagedDir });
    expect(r).toMatchObject({ ok: true, source: 'package', options: { langPath: packagedDir, gzip: true } });
  });

  it('a download happens only when allowed, and only from the address the refusal names', () => {
    const r = ocrWorkerOptions({ cacheDir: tmp(), allowDownload: true, packagedDir: null });
    expect(r).toMatchObject({ ok: true, source: 'download', options: { langPath: CDN_LANG_PATH } });
    expect(CDN_LANG_PATH).toMatch(/^https:\/\/cdn\.jsdelivr\.net\//);
  });

  it('every usable answer sets langPath explicitly', () => {
    for (const args of [
      { allowDownload: true, packagedDir: null },
      { allowDownload: false, packagedDir: tmp() },
    ]) {
      expect(ocrWorkerOptions({ cacheDir: tmp(), ...args }).options.langPath).toBeTruthy();
    }
  });

  it('permission is exactly AEON_OCR_DOWNLOAD=1', () => {
    expect(downloadAllowed({})).toBe(false);
    expect(downloadAllowed({ AEON_OCR_DOWNLOAD: 'true' })).toBe(false);
    expect(downloadAllowed({ AEON_OCR_DOWNLOAD: '1' })).toBe(true);
  });
});
