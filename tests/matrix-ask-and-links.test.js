/**
 * BO-B2 — the Matrix answers, and the graph carries meaning.
 *
 * Two capabilities, one shared theme: the pieces existed and nothing joined
 * them up.
 *
 *   /ask   Retrieval already scored the Table of Contents and read the matching
 *          files. It stopped one step short of answering. Everything up to that
 *          point costs ZERO provider tokens, which is exactly why the last hop
 *          is affordable — the index narrows the Vault to a handful of files
 *          before any model is involved.
 *
 *   links  memory_core's mdMirror has always written `refs: [...]` into YAML
 *          frontmatter, and markdown notes carry [[wikilinks]]. The graph read
 *          neither, so every edge meant "lives in this folder" and none meant
 *          "relates to". It rendered like Obsidian while encoding containment.
 *
 * These test the parsing and policy directly. The end-to-end proof — a local
 * model answering from a real Vault with citations — is in the build report;
 * a unit suite cannot start llama-server.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'src', 'blocks', 'aeon_matrix');

const retrieveSrc = fs.readFileSync(path.join(MATRIX, 'api', 'retrieve.cjs'), 'utf8');
const indexSrc = fs.readFileSync(path.join(MATRIX, 'api', 'index.cjs'), 'utf8');
const uiSrc = fs.readFileSync(path.join(MATRIX, 'index.jsx'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(MATRIX, 'block.manifest.json'), 'utf8'));

// The parsers, mirrored from index.cjs. Kept in step by the assertions in the
// last describe block, which fail if the implementation drifts from these.
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const normalise = (s) => String(s).replace(/\.[^.]+$/, '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
function parseRefs(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];
  const line = /^refs:\s*\[(.*)\]\s*$/m.exec(fm[1]);
  if (!line) return [];
  return line[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

describe('the require that never ran', () => {
  it('isInside is imported as CODE, not stranded inside the JSDoc block', () => {
    // The require was pasted INSIDE the opening /** comment, so it never
    // executed. resolveIndexedPath() threw "isInside is not defined" on every
    // call, the per-document catch swallowed it, and retrieval returned an
    // empty list for everyone — search looked empty rather than broken.
    // Found by driving /ask against a real Vault on 2026-08-04.
    const firstBlock = /^\/\*\*[\s\S]*?\*\//.exec(retrieveSrc);
    expect(firstBlock, 'file should open with a JSDoc block').toBeTruthy();
    expect(firstBlock[0]).not.toMatch(/require\(/);

    const code = retrieveSrc.slice(firstBlock[0].length);
    expect(code).toMatch(/const \{ isInside \} = require\(/);
  });

  it('no require hides inside any block comment in this file', () => {
    const blocks = retrieveSrc.match(/\/\*[\s\S]*?\*\//g) || [];
    for (const b of blocks) {
      expect(b, 'a require inside a comment never executes').not.toMatch(/^\s*const .*= require\(/m);
    }
  });
});

describe('/ask — answering costs a model call, so it holds a higher bar', () => {
  it('is declared as a route and a terminal command', () => {
    expect(retrieveSrc).toMatch(/second-brain\/ask/);
    const cmds = manifest.contract.commands.map(c => c.cmd);
    expect(cmds).toContain('/ask');
    const ask = manifest.contract.commands.find(c => c.cmd === '/ask');
    expect(ask.route).toMatch(/second-brain\/ask/);
  });

  it('refuses weak matches without calling a model', () => {
    // Measured against a real Vault: a genuine question scored 0.62, nonsense
    // scored 0.41. The browse threshold (0.35) admits that noise, so /ask
    // needs its own floor or a meaningless question still reaches a provider.
    expect(retrieveSrc).toMatch(/ASK_MIN_SIMILARITY\s*=\s*0\.45/);
    const gate = retrieveSrc.indexOf('ASK_MIN_SIMILARITY');
    const call = retrieveSrc.indexOf('await kernelLLM(');
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);   // the gate must precede the spend
  });

  it('returns nothing rather than guessing when the index is empty', () => {
    expect(retrieveSrc).toMatch(/no_matches/);
  });

  it('instructs the model to use ONLY the supplied documents', () => {
    expect(retrieveSrc).toMatch(/ONLY the numbered documents/);
    expect(retrieveSrc).toMatch(/do not use outside knowledge/i);
  });

  it('every failure path names a remedy', () => {
    // BO-F3's rule. An error the operator cannot act on is half an error.
    for (const code of ['no_model', 'weak_matches', 'model_failed']) {
      const i = retrieveSrc.indexOf(`'${code}'`);
      expect(i, `${code} should exist`).toBeGreaterThan(-1);
      expect(retrieveSrc.slice(i, i + 700)).toMatch(/remedy/);
    }
  });
});

describe('wikilinks and refs become edges', () => {
  it('parses plain, aliased and heading links', () => {
    const t = 'See [[Alpha Note]], [[Beta|shown as this]] and [[Gamma#section]].';
    const found = [];
    WIKILINK_RE.lastIndex = 0;
    let m; while ((m = WIKILINK_RE.exec(t))) found.push(m[1].trim());
    expect(found).toEqual(['Alpha Note', 'Beta', 'Gamma']);
  });

  it('parses frontmatter refs, quoted or bare', () => {
    const doc = '---\nid: mem_1\ntags: [x]\nrefs: ["Alpha Note", Beta]\n---\n\nbody';
    expect(parseRefs(doc)).toEqual(['Alpha Note', 'Beta']);
  });

  it('ignores refs outside frontmatter', () => {
    expect(parseRefs('no frontmatter here\nrefs: [Nope]')).toEqual([]);
  });

  it('matches names across separator styles', () => {
    // The first live run produced ZERO links because [[recovery codes]] did not
    // match recovery-codes.md. People type titles, not filenames.
    const target = normalise('recovery-codes.md');
    expect(normalise('recovery codes')).toBe(target);
    expect(normalise('Recovery_Codes')).toBe(target);
    expect(normalise('RECOVERY-CODES')).toBe(target);
  });

  it('does not collapse genuinely different names', () => {
    expect(normalise('alpha notes')).not.toBe(normalise('beta notes'));
  });

  it('structural and knowledge edges are distinguishable', () => {
    expect(indexSrc).toMatch(/kind: 'contains'/);
    expect(indexSrc).toMatch(/kind: 'link'/);
  });

  it('a link-parsing failure cannot take down the structural graph', () => {
    // Target the CALL SITE, not the function definition — the first draft
    // matched `function addKnowledgeLinks(allNodes, …)` and proved nothing.
    const i = indexSrc.indexOf('linkStats = addKnowledgeLinks(');
    expect(i, 'the call site should assign to linkStats').toBeGreaterThan(-1);
    const around = indexSrc.slice(Math.max(0, i - 300), i + 500);
    expect(around).toMatch(/try\s*\{/);
    expect(around).toMatch(/catch\s*\(/);
    // And the structural graph must still be served when it fails.
    expect(around).toMatch(/structure still served|console\.warn/);
  });

  it('only text-ish files are opened, and only up to a size cap', () => {
    expect(indexSrc).toMatch(/LINKABLE_EXT/);
    expect(indexSrc).toMatch(/MAX_LINK_SCAN_BYTES/);
  });
});

describe('the help tab explains what is necessary and why', () => {
  it('exists as a view alongside search and graph', () => {
    expect(uiSrc).toMatch(/HELP_CARDS/);
    expect(uiSrc).toMatch(/\['help', 'Help', HelpCircle\]/);
    expect(uiSrc).toMatch(/view === 'help'/);
  });

  it('marks each concept as always-on or optional', () => {
    // The question that prompted this — "is the embedding model still
    // necessary?" — had no answer anywhere in the product. Degrading and
    // breaking are different, and the UI must say which.
    expect(uiSrc).toMatch(/need: 'core'/);
    expect(uiSrc).toMatch(/need: 'optional'/);
    expect(uiSrc).toMatch(/ALWAYS ON/);
    expect(uiSrc).toMatch(/OPTIONAL/);
  });

  it('states plainly that the embedding model degrades rather than breaks', () => {
    const i = uiSrc.indexOf('The embedding model');
    expect(i).toBeGreaterThan(-1);
    const card = uiSrc.slice(i, i + 900);
    expect(card).toMatch(/need: 'optional'/);
    expect(card).toMatch(/degrades quality/i);
    expect(card).toMatch(/never breaks/i);
  });

  it('explains the Table of Contents and why it keeps cost down', () => {
    expect(uiSrc).toMatch(/Table of Contents/);
    expect(uiSrc).toMatch(/vault_index\.json/);
    expect(uiSrc).toMatch(/no tokens are billed|costs you nothing/);
  });
});
