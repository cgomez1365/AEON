// POST /api/resume-grader/extract — turn an uploaded résumé file into text.
//
// A résumé usually exists as a PDF, and the grader only took pasted text, so
// the real workflow started with "open the PDF, select all, copy, paste" — and
// lost the layout's line breaks on the way. The browser sends the file as
// base64 JSON (no multipart, nothing written to disk: this block declares
// filesystem "none"), and the text comes back into the résumé box where the
// operator can read and fix it BEFORE grading.
//
// PDF text uses the same current pdf.js (Node legacy build) the kernel's
// extractor uses (src/kernel/extract.cjs). That extractor takes a file path;
// this block may not write one, so the page walk is repeated here over bytes.
// Proposed for the kernel: an extractPdfBytes(buffer) export both can share.
const MAX_BYTES = 5 * 1024 * 1024;

let pdfjsPromise = null;
const loadPdfjs = () => {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  return pdfjsPromise;
};

async function pdfText(bytes) {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) {
    const e = new Error('PDF reading is not available on this install (pdf.js is missing). Paste the résumé text instead.');
    e.status = 501;
    throw e;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
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
  } finally {
    try { await doc.destroy(); } catch { /* nothing to release */ }
  }
  return { text: pages.join('\n\n').trim(), pages: pages.length };
}

async function handler(req, res) {
  const { filename = '', data } = req.body || {};
  if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'No file was sent.' });
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) return res.status(400).json({ error: 'The file is empty.' });
  if (bytes.length > MAX_BYTES) return res.status(413).json({ error: 'That file is over 5 MB — a résumé never needs to be. Export a smaller PDF, or paste the text.' });

  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const isPdf = ext === 'pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  try {
    if (isPdf) {
      const { text, pages } = await pdfText(bytes);
      if (text.replace(/\s+/g, '').length < 20) {
        return res.status(422).json({ error: 'This PDF has no readable text — it is probably a scan or an image. Paste the résumé text instead.' });
      }
      return res.json({ ok: true, text, pages, kind: 'pdf' });
    }
    if (['txt', 'md', 'markdown', 'text'].includes(ext)) {
      return res.json({ ok: true, text: bytes.toString('utf8').trim(), kind: 'text' });
    }
    if (ext === 'docx' || ext === 'doc') {
      return res.status(415).json({ error: 'AEON does not read Word files. Save the résumé as a PDF (File → Save As → PDF) and upload that, or paste the text.' });
    }
    return res.status(415).json({ error: `A .${ext || 'unknown'} file can't be read here. Upload a PDF or a .txt file, or paste the text.` });
  } catch (e) {
    return res.status(e.status || 422).json({ error: e.status ? e.message : `That PDF could not be read (${e.message}). Paste the résumé text instead.` });
  }
}

// Arity 2 on purpose: the block host mounts an arity-1 export as a factory
// that must RETURN a router, and would skip this plugin (blockHost.cjs).
module.exports = (app, _deps) => {
  app.post('/api/resume-grader/extract', (req, res) => handler(req, res));
};
