/**
 * Universal document text extraction for Second Brain AI features.
 *
 * Any file → plain text, so Ask/Summary/Search have full visibility:
 *   - text/code/markdown/json/csv/etc → read as UTF-8
 *   - html                            → tags stripped
 *   - pdf                             → pdf-parse text layer; if the PDF is
 *                                       scanned (no text layer), pages are
 *                                       rasterized via pdfjs + @napi-rs/canvas
 *                                       and OCR'd with tesseract.js
 *   - images (png/jpg/webp/bmp)       → OCR'd with tesseract.js
 *
 * OCR results are cached on disk (keyed by path + mtime) because OCR is slow.
 * Tesseract language data downloads once on first use, then lives in the cache dir.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', 'data', '.extract-cache');
const MAX_OCR_PAGES = 30;      // cap OCR effort on huge scanned PDFs
const OCR_SCALE = 2;           // render scale — higher = better OCR, slower
const MAX_TEXT_CHARS = 1_500_000; // ~a 500k-word novel; keeps huge files from blowing up browser memory

function capText(result) {
  if (result.text && result.text.length > MAX_TEXT_CHARS) {
    result.text = result.text.slice(0, MAX_TEXT_CHARS);
    result.truncated = true;
  }
  return result;
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'cjs', 'mjs',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'ps1',
  'css', 'scss', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env', 'csv', 'tsv',
  'log', 'sql', 'graphql', 'vue', 'svelte',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);

function ensureCacheDir() { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {} }

function cacheKey(filePath, mtime) {
  return crypto.createHash('sha1').update(filePath + '|' + mtime).digest('hex');
}

function readCache(filePath, mtime) {
  try {
    const p = path.join(CACHE_DIR, cacheKey(filePath, mtime) + '.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

function writeCache(filePath, mtime, result) {
  try {
    ensureCacheDir();
    fs.writeFileSync(path.join(CACHE_DIR, cacheKey(filePath, mtime) + '.json'), JSON.stringify(result));
    // Keep the cache from growing forever — drop oldest entries past 100
    const entries = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    if (entries.length > 100) {
      entries.map(f => ({ f, t: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .slice(0, entries.length - 100)
        .forEach(e => { try { fs.unlinkSync(path.join(CACHE_DIR, e.f)); } catch {} });
    }
  } catch {}
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lazily created tesseract worker — reused across requests, heavy to spin up.
let _worker = null;
let _workerPromise = null;
async function getOcrWorker() {
  if (_worker) return _worker;
  if (_workerPromise) return _workerPromise;
  const { createWorker } = require('tesseract.js');
  ensureCacheDir();
  _workerPromise = createWorker('eng', 1, { cachePath: CACHE_DIR, logger: () => {} })
    .then(w => { _worker = w; _workerPromise = null; return w; });
  return _workerPromise;
}

async function ocrImageBuffer(buf) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buf);
  return (data.text || '').trim();
}

// Rasterize PDF pages and OCR each one — for scanned PDFs with no text layer.
async function ocrPdf(buf, onProgress) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const loadingTask = getDocument({ data: new Uint8Array(buf), disableFontFace: true, verbosity: 0 });
  const doc = await loadingTask.promise;
  const pages = Math.min(doc.numPages, MAX_OCR_PAGES);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    if (onProgress) onProgress(i, pages);
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: OCR_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const png = canvas.toBuffer('image/png');
    const text = await ocrImageBuffer(png);
    out.push(`--- Page ${i} ---\n${text}`);
    page.cleanup();
  }
  const numPages = doc.numPages;
  try { await loadingTask.destroy(); } catch {}
  return { text: out.join('\n\n'), pages: numPages, ocrPages: pages, truncated: numPages > MAX_OCR_PAGES };
}

/**
 * Extract text from any supported file. Returns
 * { text, method: 'text'|'html'|'pdf'|'pdf-ocr'|'ocr', pages?, truncated?, cached? }
 */
async function extractText(resolved) {
  const mtime = fs.statSync(resolved).mtimeMs;
  const cached = readCache(resolved, mtime);
  if (cached) return { ...cached, cached: true };

  const ext = (resolved.split('.').pop() || '').toLowerCase();
  let result;

  if (ext === 'html' || ext === 'htm') {
    result = { text: stripHtml(fs.readFileSync(resolved, 'utf8')), method: 'html' };
  } else if (ext === 'docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ path: resolved });
    result = { text: (value || '').trim(), method: 'docx' };
  } else if (ext === 'xlsx' || ext === 'pptx') {
    // Office XML formats are zips — pull the text-bearing XML parts and strip tags
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(resolved);
    const parts = zip.getEntries()
      .filter(e => ext === 'xlsx'
        // sharedStrings holds the actual cell text; sheet XML only has numeric
        // indexes into it, which would pollute the output with garbage numbers
        ? e.entryName === 'xl/sharedStrings.xml'
        : /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(e.entryName))
      .map(e => e.getData().toString('utf8')
        .replace(/<\/(t|si|row|p)>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim())
      .filter(Boolean);
    result = { text: parts.join('\n\n'), method: ext };
  } else if (TEXT_EXTS.has(ext)) {
    result = { text: fs.readFileSync(resolved, 'utf8'), method: 'text' };
  } else if (IMAGE_EXTS.has(ext)) {
    const text = await ocrImageBuffer(fs.readFileSync(resolved));
    result = { text, method: 'ocr' };
  } else if (ext === 'pdf') {
    const buf = fs.readFileSync(resolved);
    const pdfParse = require('pdf-parse');
    let data = null;
    try { data = await pdfParse(buf); } catch {}
    const layerText = (data?.text || '').trim();
    // Heuristic: a real text layer averages way more than 20 chars/page.
    // Below that it's a scanned PDF — fall through to OCR.
    if (data && layerText.length > (data.numpages || 1) * 20) {
      result = { text: layerText, method: 'pdf', pages: data.numpages };
    } else {
      const ocr = await ocrPdf(buf);
      result = { text: ocr.text, method: 'pdf-ocr', pages: ocr.pages, ocrPages: ocr.ocrPages, truncated: ocr.truncated };
    }
  } else {
    // Unknown binary — try utf8, bail if it looks like garbage
    const buf = fs.readFileSync(resolved);
    const sample = buf.slice(0, 1000).toString('utf8');
    const printable = sample.replace(/[^\x20-\x7E\n\r\t]/g, '').length / (sample.length || 1);
    if (printable > 0.85) result = { text: buf.toString('utf8'), method: 'text' };
    else throw new Error(`Unsupported file type: .${ext}`);
  }

  capText(result);
  // Only cache expensive extractions (OCR) — plain reads are cheap
  if (result.method === 'ocr' || result.method === 'pdf-ocr') writeCache(resolved, mtime, result);
  return result;
}

module.exports = { extractText, TEXT_EXTS, IMAGE_EXTS };
