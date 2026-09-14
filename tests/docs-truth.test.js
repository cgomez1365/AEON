/**
 * The docs cite only files that exist.
 *
 * docs/ sat outside every scanner. scripts/gen-block-docs.cjs says so in its own
 * header: the hand-maintained block list named deleted blocks for weeks because
 * "nothing ever caught it". The 2026-09-14 GitHub overhaul found the same rot in
 * five more places — KERNEL.md documented a routes/*.js layer that does not
 * exist, BLOCK_MATRIX.md listed fifteen blocks that do not exist (Trading, CRM,
 * HR Arsenal, Render Studio...), MEMORY_ARCHITECTURE.md described
 * Data/Second_Brain and brain-data.json, and the agent briefing mapped a
 * routers/god.cjs that had become console.cjs.
 *
 * A reader cannot tell a stale doc from a true one, so one stale doc teaches
 * them to distrust all of it (claim discipline). This gate is the cheapest check
 * that would have caught every one of those: a path a doc cites in backticks,
 * as a Markdown link target or as an <img src> must exist in the repo, and a
 * link's #anchor must be a heading in the target.
 *
 * Bare filenames (`index.cjs`, `block.manifest.json`) are skipped: they name a
 * file every block has, not one path. Paths a doc cites as HISTORY are listed in
 * HISTORICAL with the sentence that makes them history.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

// Git-ignored runtime files a doc may legitimately name: they exist on every
// running install, never in a clone.
const RUNTIME = new Set([
  'src/aeon-settings.json',
  'data/vault_index.json',
  'data/vault_chunks.json',
  'data/local-runtime/local-runtime.json',
  'data/desktop-shortcut.json',
  'secrets/aeon-keyslots.json',
  'secrets/aeon-endpoints.json',
  // Build output: exists after `npm run build`, never in a clone.
  'dist/sw.js',
]);

// Cited on purpose as something that USED to exist.
const HISTORICAL = new Map([
  ['data/local-runtime.json', 'docs/architecture/native-local-runtime.md: "That path held a *different* file"'],
  ['db/block.schema.json', 'docs/BLOCK_STANDARD.md: "A second, stale copy lived at `db/block.schema.json` until 2026-08-09"'],
  // Named in RETRIEVAL_SCOPES.md precisely to say they never existed here.
  ['tools/test-retrieval.cjs', 'docs/RETRIEVAL_SCOPES.md: "neither file has ever existed in this repository"'],
  ['tools/test-citation.cjs', 'docs/RETRIEVAL_SCOPES.md: "neither file has ever existed in this repository"'],
  ['tools/reseed-retrieval.cjs', 'docs/RETRIEVAL_SCOPES.md: "is not part of this repository"'],
]);

const DOCS = [
  'README.md',
  '.github/AGENTS.md',
  '.github/CONTRIBUTING.md',
  '.github/SECURITY.md',
  '.claude/CLAUDE.md',
  ...tracked.filter(f => /^docs\/.+\.md$/.test(f) && f !== 'docs/BLOCKS.md'),
].filter(f => fs.existsSync(path.join(ROOT, f)));

const PATHISH = /(?:^|[\s(`'"])((?:\.{1,2}\/)*[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~*-]+)+\.(?:js|cjs|mjs|jsx|json|md|bat|sh|command|sql|yml|yaml|html))(?=$|[\s)`'",:;#])/g;

// Markdown link targets and <img src> as well as backtick spans: README's
// [Architecture](docs/ARCHITECTURE.md) and its banner are claims too. A broken
// anchor (#lessons-paid-for on a heading GitHub slugs as #4-lessons-paid-for)
// went unnoticed because only backticks were read (2026-09-14).
const LINK = /\]\(([^)\s]+)\)|<img[^>]*\ssrc="([^"]+)"/g;
const EXTERNAL = /^(?:[a-z]+:|\/\/)/i;

function citedPaths(src) {
  const out = new Set();
  for (const span of src.match(/`[^`\n]+`/g) || []) {
    let m;
    PATHISH.lastIndex = 0;
    while ((m = PATHISH.exec(span.slice(1, -1)))) out.add(m[1]);
  }
  for (const [, link, img] of src.matchAll(LINK)) {
    const target = link || img;
    if (!target || EXTERNAL.test(target) || target.startsWith('#')) continue;
    out.add(target.split('#')[0]);
  }
  return out;
}

// Anchors: `path#slug` must name a heading in that file, slugged the way GitHub
// does it - lowercase, punctuation dropped, spaces to hyphens.
function citedAnchors(src) {
  const out = [];
  for (const [, link] of src.matchAll(LINK)) {
    if (!link || EXTERNAL.test(link) || !link.includes('#')) continue;
    const [file, anchor] = link.split('#');
    if (file && anchor) out.push({ file, anchor });
  }
  return out;
}
const slug = (heading) => heading.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/ /g, '-');
function headingSlugs(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(m => slug(m[1])));
}
function resolveDoc(doc, p) {
  const clean = norm(p);
  if (TRACKED.has(clean)) return clean;
  const rel = norm(path.posix.join(path.posix.dirname(doc), p));
  return TRACKED.has(rel) ? rel : null;
}

// Checked against TRACKED files, never the disk. A doc citing a git-ignored file
// that happens to exist on the author's machine would pass here and fail on a
// fresh CI clone — the gate must give one answer everywhere. Runtime files a
// doc may name on purpose are listed in RUNTIME above.
const TRACKED = new Set(tracked);
const norm = (p) => path.posix.normalize(p).replace(/^(\.\/)+/, '');

function exists(doc, p) {
  if (p.includes('*') || p.includes('<')) return true; // a pattern, not a file
  const clean = norm(p);
  if (RUNTIME.has(clean) || HISTORICAL.has(clean)) return true;
  if (TRACKED.has(clean)) return true;
  if (TRACKED.has(norm(path.posix.join(path.posix.dirname(doc), p)))) return true;
  // Import paths written for block authors ("use `../../config.js`") resolve
  // from a block folder, not from the doc. _template is the canonical block.
  if (p.startsWith('../') && TRACKED.has(norm(path.posix.join('src/blocks/_template', p)))) return true;
  return false;
}

describe('docs cite only files that exist', () => {
  for (const doc of DOCS) {
    it(`${doc}`, () => {
      const src = fs.readFileSync(path.join(ROOT, doc), 'utf8');
      const dead = [...citedPaths(src)].filter(p => !exists(doc, p));
      expect(dead, `${doc} cites files that do not exist`).toEqual([]);
      const badAnchors = citedAnchors(src)
        .filter(({ file, anchor }) => { const f = resolveDoc(doc, file); return f && !headingSlugs(f).has(anchor); })
        .map(({ file, anchor }) => `${file}#${anchor}`);
      expect(badAnchors, `${doc} links to anchors no heading produces`).toEqual([]);
    });
  }

  it('the gate can fail: it catches a path that does not exist', () => {
    // A scanner that cannot fail is not a gate (ENGINEERING_STANDARD, lessons).
    expect([...citedPaths('see `src/kernel/routers/god.cjs` and `index.cjs`')]).toEqual(['src/kernel/routers/god.cjs']);
    expect(exists('docs/X.md', 'src/kernel/routers/god.cjs')).toBe(false);
    expect(exists('docs/X.md', 'src/kernel/routers/console.cjs')).toBe(true);
    // Links and images are read too, and anchors are slugged like GitHub does.
    expect([...citedPaths('[k](docs/NOPE.md#x) <img src="public/nope.png"> [ext](https://x.y/z.md)')]).toEqual(['docs/NOPE.md', 'public/nope.png']);
    expect(slug('4. Lessons paid for')).toBe('4-lessons-paid-for');
    expect(headingSlugs('docs/ENGINEERING_STANDARD.md').has('4-lessons-paid-for')).toBe(true);
    expect(headingSlugs('docs/ENGINEERING_STANDARD.md').has('lessons-paid-for')).toBe(false);
  });
});

describe('superseded hand-written docs are retired', () => {
  it('docs/BLOCK_MATRIX.md is gone — docs/BLOCKS.md is generated from the manifests', () => {
    // It listed blocks that were deleted months earlier, and three block READMEs
    // already called it stale. A generated doc cannot go stale; this one did.
    expect(tracked).not.toContain('docs/BLOCK_MATRIX.md');
    const refs = tracked
      .filter(f => /\.(md|jsx?|cjs)$/.test(f) && f !== 'tests/docs-truth.test.js')
      .filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('BLOCK_MATRIX.md'));
    expect(refs, 'files still pointing readers at BLOCK_MATRIX.md').toEqual([]);
  });

  it('agent briefings live out of the root, in the places their tools read', () => {
    expect(tracked).not.toContain('CLAUDE.md');
    expect(tracked).not.toContain('AGENTS.md');
    expect(tracked).toContain('.claude/CLAUDE.md');
    expect(tracked).toContain('.github/AGENTS.md');
  });
});
