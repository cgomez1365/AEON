/**
 * .docx support is removed, and stays removed.
 *
 * CEO, 2026-09-12: "can we remove that option? i prefer pdfs and image for
 * security". The occasion was the audit gate: eight high advisories against
 * @xmldom/xmldom, reached only through mammoth's .docx reader, with no upstream
 * fix available. Every fixed xmldom is 0.9.x and mammoth@1.12.3 still requires
 * ^0.8.6; forcing 0.9 through an npm override was measured and breaks mammoth
 * outright ("DOMParser.parseFromString: the provided mimeType 'undefined' is
 * not valid" - 0.9 made the argument mandatory, mammoth passes one argument).
 *
 * So the choice was to sign a waiver for eight advisories or to delete the one
 * format that pulls them in. The CEO chose deletion. Removing mammoth removes
 * @xmldom/xmldom from the tree entirely, which is why this file asserts the
 * absence of the PACKAGE and not merely of the call site: the advisories are
 * what the removal is for.
 *
 * This is Bible §21: the gate is written before the deletion, and it fails if
 * the thing returns. It also covers §21's step 4 in spirit - not "the suite is
 * green" but "the paths that touched it behave honestly now". A .docx must be
 * REFUSED with a reason, never silently indexed as empty and never decoded as
 * garbage (§08, R-05).
 *
 * Note for whoever revisits this: .docx is a zip containing word/document.xml,
 * and this repo already reads .xlsx/.pptx that way with adm-zip and no
 * dependency at all. Restoring the format without mammoth is therefore
 * possible. It was not done because the CEO wanted the format gone, not the
 * library.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8');
/** Strip comments - prose describing the removal is not the removal coming back. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const walk = (p, out = []) => {
  if (!fs.existsSync(p)) return out;
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) if (n !== 'node_modules') walk(path.join(p, n), out); }
  else out.push(p);
  return out;
};

/** A real .docx: a zip carrying word/document.xml, which is what one is. */
function makeDocx(dir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body><w:p><w:r><w:t>canary sentence from a word file</w:t></w:r></w:p></w:body></w:document>',
  ));
  const file = path.join(dir, 'sample.docx');
  zip.writeZip(file);
  return file;
}

describe('the dependency the format pulled in is gone', () => {
  it('mammoth is not a dependency of this project', () => {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(pkg[field] || {}, `mammoth in ${field}`).not.toHaveProperty('mammoth');
    }
  });

  it('@xmldom/xmldom is not installed at all - the eight advisories have nothing to attach to', () => {
    // The whole point of the removal. If something else ever pulls xmldom back
    // in, the advisories return and this says so before the audit gate does.
    expect(fs.existsSync(path.join(ROOT, 'node_modules', '@xmldom', 'xmldom')),
      'xmldom is back in the tree - find out what pulled it in').toBe(false);
  });

  it('no shipped code requires mammoth', () => {
    const offenders = ['src', 'server', 'services', 'tools', 'scripts', 'api']
      .flatMap(d => walk(path.join(ROOT, d)))
      .filter(f => /\.(m?js|cjs|jsx)$/.test(f))
      .filter(f => /require\(['"]mammoth['"]\)|from ['"]mammoth['"]/.test(code(read(f))))
      .map(f => path.relative(ROOT, f));
    expect(offenders, 'files still requiring mammoth').toEqual([]);
  });
});

describe('a .docx is refused with a reason, not decoded as garbage', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-docx-gone-'));
  const docx = makeDocx(tmp);

  it('the kernel extractor calls it binary and returns null rather than text', async () => {
    const extract = require('../src/kernel/extract.cjs');
    expect(extract.kindOf(docx), '.docx must no longer be a "document"').toBe('binary');
    expect(await extract.extractText(docx), 'must not return text for a .docx').toBeNull();
  });

  it('the block extractor refuses it, and never returns the zip decoded as text', async () => {
    const { extractText } = require('../src/blocks/aeon_matrix/api/_extract.cjs');
    let out = null, threw = null;
    try { out = await extractText(docx); } catch (e) { threw = e; }
    if (threw) {
      expect(threw.message, 'a refusal must name the format').toMatch(/docx|not .*support|cannot/i);
    } else {
      // Refusing by returning no text is fine. Returning the zip's bytes as
      // "text" is not: that is the decoded-binary defect from 2026-09-07.
      expect((out?.text || '').trim(), 'must not hand back decoded zip bytes').toBe('');
      expect(out?.method, 'must not claim a docx method').not.toBe('docx');
    }
  });

  it('the vault indexer does not walk .docx files', () => {
    const src = code(read(path.join(ROOT, 'src/blocks/aeon_matrix/api/ingest.cjs')));
    const m = src.match(/INDEXABLE_EXT\s*=\s*\/([^/]+)\//);
    expect(m, 'INDEXABLE_EXT not found').toBeTruthy();
    expect(new RegExp(m[1], 'i').test('.docx'), '.docx must not be indexable').toBe(false);
    expect(new RegExp(m[1], 'i').test('.pdf'), '.pdf must still be indexable').toBe(true);
  });
});

describe('nothing tells the operator AEON reads Word files', () => {
  // A promise with no implementation behind it is the §08 defect; the 2026-09-07
  // terminal pass was a whole report of them.
  const claims = [
    ['src/blocks/host_os/block.manifest.json', 'the /read command description'],
    ['src/blocks/host_os/api/fs.cjs', 'the /read refusal remedy'],
    ['src/blocks/aeon_matrix/api/ingest.cjs', 'the indexer refusal remedies'],
    ['src/blocks/aeon_matrix/block.manifest.json', 'the Matrix filesystem reason'],
    ['src/components/Terminal2.jsx', 'the document picker and its prompt'],
    ['docs/MEMORY_ARCHITECTURE.md', 'the memory architecture doc'],
    ['src/blocks/aeon_matrix/README.md', 'the Matrix README'],
  ];

  it.each(claims)('%s no longer advertises docx (%s)', (file) => {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return;
    const src = /\.(json|md)$/.test(file) ? read(full) : code(read(full));
    const hits = src.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /docx/i.test(line))
      // The file-type icon map may keep .docx: a Word file can still SIT in the
      // vault and be listed, it just cannot be read. Listing is not a claim.
      .filter(([, line]) => !/📝|icon|emoji/i.test(line))
      // Naming the format in order to say it is NOT read is the opposite of
      // advertising it, and is exactly what §08 asks for.
      .filter(([, line]) => !/refus|remov|no longer|not read|unsupported|dropped/i.test(line));
    expect(hits.map(([n, l]) => `${file}:${n} ${l.trim().slice(0, 90)}`), 'docx still advertised').toEqual([]);
  });

  it('the document picker cannot offer a format the extractor refuses', () => {
    const src = read(path.join(ROOT, 'src/components/Terminal2.jsx'));
    // The DOCUMENT picker, not the image one a few lines above it: match the
    // input that carries docInputRef.
    const input = src.match(/<input[^>]*docInputRef[^>]*>/)?.[0] || '';
    expect(input, 'the document picker input was not found').toMatch(/accept=/);
    const accept = input.match(/accept="([^"]+)"/)?.[1] || '';
    expect(accept, 'the document picker still accepts .docx').not.toMatch(/docx/i);
    expect(accept, 'the document picker should still offer pdf').toMatch(/pdf/i);
  });
});
