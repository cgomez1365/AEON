'use strict';
// pdf-parse 2.x replaced the v1 default export `pdfParse(buffer)` with a
// `PDFParse` class. Every caller in AEON used the v1 shape, so this adapter keeps
// it: pdfParse(buffer) -> { text, numpages }. One place to change next time.
const { PDFParse } = require('pdf-parse');

async function pdfParse(buf) {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const out = await parser.getText({ pageJoiner: '' });
    return { text: out.text || '', numpages: out.total ?? (out.pages ? out.pages.length : 0) };
  } finally {
    try { await parser.destroy(); } catch { /* nothing to release */ }
  }
}

module.exports = pdfParse;
module.exports.pdfParse = pdfParse;
