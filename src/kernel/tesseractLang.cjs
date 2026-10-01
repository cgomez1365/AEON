'use strict';
/**
 * Where OCR's English language data comes from.
 *
 * tesseract.js, given no `langPath`, downloads eng.traineddata from
 * cdn.jsdelivr.net the first time it runs. The Vault scan OCRs any image or
 * scanned PDF it finds, and the scan runs at boot, so a fresh install reached
 * jsDelivr without the operator asking — against README's "only when you ask"
 * (audit A070).
 *
 * This chooses the worker's options so the data is read from disk:
 *   1. the copy tesseract.js caches after a first load (<cacheDir>/eng.traineddata),
 *   2. the @tesseract.js-data/eng package, when it is installed,
 * and downloads only when the operator allowed it (AEON_OCR_DOWNLOAD=1 in .env).
 * Otherwise OCR is refused with the reason and both remedies, so the scan
 * reports it instead of the network silently being used.
 */
const fs = require('fs');
const path = require('path');

const LANG = 'eng';
// tesseract.js's own default for its LSTM-only core (worker-script/index.js),
// named here so a download goes exactly where the refusal says it would.
const CDN_LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';

function packagedLangDir() {
  try {
    const dir = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    if (fs.existsSync(path.join(dir, `${LANG}.traineddata.gz`))) return dir;
  } catch { /* not installed */ }
  return null;
}

function downloadAllowed(env = process.env) {
  return env.AEON_OCR_DOWNLOAD === '1';
}

/**
 * Options for createWorker('eng', 1, options), or why OCR cannot run.
 * @returns {{ok: true, source: 'cache'|'package'|'download', options: object}
 *          | {ok: false, code: 'ocr_data_missing', error: string}}
 */
function ocrWorkerOptions({ cacheDir, allowDownload = downloadAllowed(), packagedDir = packagedLangDir() } = {}) {
  // langPath is always set: with it unset, a cache miss falls through to the CDN.
  if (cacheDir && fs.existsSync(path.join(cacheDir, `${LANG}.traineddata`))) {
    // tesseract.js caches the data already unzipped.
    return { ok: true, source: 'cache', options: { cachePath: cacheDir, langPath: cacheDir, gzip: false } };
  }
  if (packagedDir) {
    return { ok: true, source: 'package', options: { cachePath: cacheDir, langPath: packagedDir, gzip: true } };
  }
  if (allowDownload) {
    return { ok: true, source: 'download', options: { cachePath: cacheDir, langPath: CDN_LANG_PATH, gzip: true } };
  }
  return {
    ok: false,
    code: 'ocr_data_missing',
    error: 'Text in images and scanned PDFs was not read: OCR needs English language data that is not on this computer, '
      + 'and AEON does not download it on its own. To allow a one-time download from cdn.jsdelivr.net, set '
      + 'AEON_OCR_DOWNLOAD=1 in .env and restart AEON'
      + (cacheDir ? `, or put eng.traineddata in ${cacheDir}` : '')
      + '.',
  };
}

module.exports = { ocrWorkerOptions, downloadAllowed, packagedLangDir, CDN_LANG_PATH };
