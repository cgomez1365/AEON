// pdf-parse 2 dropped the v1 default export; src/kernel/pdfText.cjs keeps the v1
// call shape for AEON's three callers. This pins that shape on a real PDF.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('../src/kernel/pdfText.cjs');

function tinyPdf(text) {
  const st = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${st.length} >>\nstream\n${st}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

describe('pdfText adapter (pdf-parse 2, v1 call shape)', () => {
  it('returns { text, numpages } with no page-separator noise', async () => {
    const r = await pdfParse(tinyPdf('Hello AEON'));
    expect(r.numpages).toBe(1);
    expect(r.text.trim()).toBe('Hello AEON');
    expect(r.text).not.toMatch(/-- 1 of 1 --/);
  });
  it('rejects bytes that are not a PDF instead of returning empty text', async () => {
    await expect(pdfParse(Buffer.from('not a pdf at all'))).rejects.toBeTruthy();
  });
});
