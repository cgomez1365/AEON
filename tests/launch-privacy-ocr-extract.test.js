/**
 * The Vault extractor never fetches OCR language data on its own (audit A070).
 *
 * tests/launch-privacy-ocr-data.test.js covers the decision in
 * src/kernel/tesseractLang.cjs. This drives the REAL caller,
 * src/blocks/aeon_matrix/api/_extract.cjs, the module the boot Vault scan
 * uses: with no language data on disk and no AEON_OCR_DOWNLOAD=1, an image is
 * refused with the remedy, no tesseract worker is started (a worker given no
 * langPath fetches from cdn.jsdelivr.net) and fetch is never called.
 *
 * tesseract.js is replaced in require.cache by a stub that records its
 * createWorker calls, so no worker thread, WASM or network is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRACT_PATH = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'api', '_extract.cjs');
const TESS_PATH = createRequire(EXTRACT_PATH).resolve('tesseract.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ocr-extract-'));
const cacheDir = path.join(tmp, 'extract-cache');
const image = path.join(tmp, 'scan.png');
fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex')); // never decoded

const workerCalls = [];
const tessStub = {
  createWorker: async (...args) => {
    workerCalls.push(args);
    return { recognize: async () => ({ data: { text: 'stub text' } }) };
  },
};

const saved = { extract: require.cache[EXTRACT_PATH], tess: require.cache[TESS_PATH], dl: process.env.AEON_OCR_DOWNLOAD };
const realFetch = globalThis.fetch;
const fetched = [];
let extract;

beforeAll(() => {
  delete process.env.AEON_OCR_DOWNLOAD;
  globalThis.fetch = (url) => { fetched.push(String(url?.url || url)); return Promise.reject(new Error('no network in tests')); };
  require.cache[TESS_PATH] = { id: TESS_PATH, filename: TESS_PATH, loaded: true, exports: tessStub };
  delete require.cache[EXTRACT_PATH];
  extract = require(EXTRACT_PATH);
  extract.setCacheDir(cacheDir);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (saved.extract) require.cache[EXTRACT_PATH] = saved.extract; else delete require.cache[EXTRACT_PATH];
  if (saved.tess) require.cache[TESS_PATH] = saved.tess; else delete require.cache[TESS_PATH];
  if (saved.dl === undefined) delete process.env.AEON_OCR_DOWNLOAD; else process.env.AEON_OCR_DOWNLOAD = saved.dl;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('OCR in the Vault extractor', () => {
  it('no language data and no permission: the image is refused with the remedy, and nothing is fetched', async () => {
    const { packagedLangDir } = require('../src/kernel/tesseractLang.cjs');
    if (packagedLangDir()) {
      // @tesseract.js-data/eng installed: the data is read from that folder.
      await extract.extractText(image);
      expect(workerCalls).toHaveLength(1);
      expect(String(workerCalls[0][2].langPath)).not.toMatch(/^https?:/);
    } else {
      const err = await extract.extractText(image).then(() => null, (e) => e);
      expect(err, 'OCR ran with nothing on disk').toBeInstanceOf(Error);
      expect(err.code).toBe('ocr_data_missing');
      expect(err.message).toMatch(/AEON_OCR_DOWNLOAD=1/);
      expect(err.message).toContain(cacheDir);
      expect(workerCalls).toEqual([]);
    }
    expect(fetched).toEqual([]);
  });

  it('a copy already on disk is read from there: the worker is given a local langPath', async () => {
    workerCalls.length = 0;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'eng.traineddata'), 'x');
    const r = await extract.extractText(image);
    expect(r).toMatchObject({ method: 'ocr', text: 'stub text' });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0][2]).toMatchObject({ langPath: cacheDir, cachePath: cacheDir });
    expect(fetched).toEqual([]);
  });
});
