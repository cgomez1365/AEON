/**
 * AEON — document text extraction, as a kernel service.
 *
 * One extractor for the whole system. It lived inside the Aeon Matrix, which
 * meant /read in host_os could not use it — one block may not reach into
 * another — so /read handed a PDF to readFileSync('utf8') and reported
 * success with decoded binary. The operator saw a green chip and garbage.
 *
 * Text extraction is not a block's knowledge; it is the kernel's.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pdfParse = null;
function loadExtractors() {
  if (pdfParse) return;
  try { pdfParse = require('pdf-parse'); } catch { /* PDF support unavailable */ }
}

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.log', '.yml', '.yaml', '.xml', '.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx', '.py', '.sh', '.css', '.sql', '.toml', '.ini', '.env', '.markdown', '.rst']);
// .docx is deliberately absent (2026-09-12, CEO). Reading it needed mammoth,
// which reaches @xmldom/xmldom and its eight high advisories - no upstream fix,
// since every fixed xmldom is 0.9.x and mammoth still requires ^0.8.6, and
// forcing 0.9 through an npm override breaks mammoth outright (measured). The
// format was dropped rather than the advisories waived. A .docx now reads as
// binary and is refused with a remedy; tests/docx-support-removed holds it.
const DOC_EXT  = new Set(['.pdf', '.html', '.htm']);

/**
 * PDF text via a CURRENT pdf.js (pdfjs-dist, Node legacy build), falling back
 * to pdf-parse's bundled 2018 pdf.js only if the modern one is absent.
 *
 * pdf-parse 1.1.4 ships pdf.js 1.9–2.0 (2017–2018), which rejects what modern
 * generators write — jspdf's 19-byte xref entries, for one — with "bad XRef
 * entry". It threw exactly that on a real PDF from the operator's Desktop
 * during the 2026-09-07 stress run. Reading PDFs is not optional for a second
 * brain, so the parser is not allowed to be eight years old.
 */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  }
  return pdfjsPromise;
}
async function extractPdf(fullPath) {
  const bytes = fs.readFileSync(fullPath);
  const pdfjs = await loadPdfjs();
  if (pdfjs) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Items carry `hasEOL`; a line break in the source stays a line break.
      let line = '';
      const lines = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; } else if (it.str && !it.str.endsWith(' ')) line += ' ';
      }
      if (line.trim()) lines.push(line);
      pages.push(lines.join('\n').replace(/[ \t]+$/gm, ''));
    }
    try { await doc.cleanup(); await doc.destroy(); } catch { /* nothing to release */ }
    return pages.join('\n\n');
  }
  if (!pdfParse) return null;
  return (await pdfParse(bytes)).text;
}

/** What kind of thing this path is, by extension: 'text' | 'document' | 'binary'. */
function kindOf(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  if (DOC_EXT.has(ext)) return 'document';
  if (TEXT_EXT.has(ext) || ext === '') return 'text';
  return 'binary';
}

/**
 * Extract readable text. Returns null when the format is not one this
 * extractor can read — the caller must refuse, not return bytes.
 */
async function extractText(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  loadExtractors();
  if (ext === '.pdf') return extractPdf(fullPath);
  if (ext === '.html' || ext === '.htm') return htmlToText(fs.readFileSync(fullPath, 'utf8'));
  if (kindOf(fullPath) === 'binary') return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|figcaption|header|footer|table|ul|ol|dd|dt)>/gi, '\n\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
       .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
       .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

module.exports = { loadExtractors, extractText, htmlToText, kindOf, TEXT_EXT, DOC_EXT };
