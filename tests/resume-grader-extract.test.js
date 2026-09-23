/**
 * Resume Grader — upload a résumé file instead of copy-pasting it.
 *
 * The grader took pasted text only; the real workflow started with "open the
 * PDF, select all, copy, paste". POST /api/resume-grader/extract turns a PDF
 * (or .txt) sent as base64 into text for the résumé box, without writing a
 * file (the block declares filesystem "none").
 *
 * The PDF below is built here, byte for byte, so the test carries its own
 * fixture and needs no binary file in the repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A one-page PDF whose content stream draws `lines` in Helvetica. */
function makePdf(lines) {
  const stream = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
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

let server;
afterEach(async () => { if (server) await new Promise((r) => server.close(r)); server = null; });

async function mount() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  require_(path.join(ROOT, 'src', 'blocks', 'resume_grader', 'api', 'extract-resume.js'))(app, {});
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  return (body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/resume-grader/extract', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

describe('résumé upload', () => {
  it('reads the text of a PDF résumé, line by line', async () => {
    const post = await mount();
    const pdf = makePdf(['Jane Doe', 'Senior Software Engineer', 'Node.js, React, PostgreSQL - 4 years at Acme Payments']);
    const r = await post({ filename: 'Jane_Doe_Resume.pdf', data: pdf.toString('base64') });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('pdf');
    expect(r.body.pages).toBe(1);
    expect(r.body.text).toContain('Jane Doe');
    expect(r.body.text).toContain('Senior Software Engineer');
    expect(r.body.text).toMatch(/Acme Payments/);
  }, 20000);

  it('a PDF with no text layer is refused with the remedy, not graded as empty', async () => {
    const post = await mount();
    const r = await post({ filename: 'scan.pdf', data: makePdf([]).toString('base64') });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/no readable text/);
  }, 20000);

  it('reads a plain-text résumé', async () => {
    const post = await mount();
    const r = await post({ filename: 'cv.txt', data: Buffer.from('Jane Doe\nEngineer').toString('base64') });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe('Jane Doe\nEngineer');
  });

  it('a Word file is refused with the PDF remedy', async () => {
    const post = await mount();
    const r = await post({ filename: 'cv.docx', data: Buffer.from('PK\u0003\u0004 not really').toString('base64') });
    expect(r.status).toBe(415);
    expect(r.body.error).toMatch(/Save the résumé as a PDF/);
  });

  it('refuses an oversized upload', async () => {
    const post = await mount();
    const r = await post({ filename: 'big.pdf', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') });
    expect(r.status).toBe(413);
  });
});
