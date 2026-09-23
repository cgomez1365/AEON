/**
 * The Matrix's scanned-PDF path renders pages with pdf.js's own canvas.
 *
 * Store builder B2 (2026-09-23): ocrPdf drew pdf.js pages on a canvas from
 * AEON's @napi-rs/canvas (1.0.9) while pdf.js ships and uses its own nested
 * copy — text drawing on such a page throws "Value is none of these types
 * String, Path". A scanned PDF with any text operator failed to OCR.
 * The rendering is split out (renderPdfPages) so it is testable without OCR.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const extract = require('../src/blocks/aeon_matrix/api/_extract.cjs');

function textPdf(line) {
  const content = `BT /F1 24 Tf 72 700 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('renderPdfPages', () => {
  it('renders a page that draws text to a PNG', async () => {
    const r = await extract.renderPdfPages(textPdf('Scanned page with a text layer'), { scale: 1 });
    expect(r.numPages).toBe(1);
    expect(r.pngs).toHaveLength(1);
    expect(r.pngs[0].subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(r.pngs[0].length).toBeGreaterThan(1000);
  });
});
