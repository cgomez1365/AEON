/**
 * The shell must build without any particular block.
 *
 * Measured 2026-09-23 (removability run, one block at a time): 16 of 17 blocks
 * can be removed and AEON keeps running — but with `security` gone the UI does
 * not build at all: `Could not resolve "../blocks/security/components/
 * SetupWizard.jsx" from "src/components/CloudSetupGate.jsx"`. So there was no
 * empty shell and no way to add security last, while Bible §19/§20 said "AEON
 * boots with zero blocks". The empty-shell test drives the server's block host
 * only, so it could not see a build-time import.
 *
 * Rollup resolves a literal path at build time whether it is a static import
 * or a dynamic import(). The one form that tolerates an absent block is
 * import.meta.glob — the registry itself discovers blocks that way — because
 * it matches nothing instead of failing. So: outside src/blocks/, a block's
 * files are reached through import.meta.glob or not at all.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function shellFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p === path.join(SRC, 'blocks')) continue;
      shellFiles(p, out);
    } else if (/\.(jsx?|mjs|tsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}

// `import X from '…/blocks/…'`, `import '…/blocks/…'`, `import('…/blocks/…')`,
// `export … from '…/blocks/…'` — each resolved by Rollup at build time.
const LITERAL_BLOCK_IMPORT = /(?:\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)['"`](?:\.\.?\/)+(?:[\w-]+\/)*blocks\/[^'"`]+['"`]/g;

describe('the shell reaches blocks only through import.meta.glob', () => {
  it('no file outside src/blocks names a block path in an import', () => {
    const offenders = [];
    for (const f of shellFiles()) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(LITERAL_BLOCK_IMPORT)) {
        offenders.push(`${path.relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern catches both forms (self-check, so the gate cannot pass by matching nothing)', () => {
    const cases = [
      "import SetupWizard from '../blocks/security/components/SetupWizard.jsx';",
      "const S = lazy(() => import('../blocks/security/index.jsx'));",
    ];
    for (const c of cases) expect(c.match(LITERAL_BLOCK_IMPORT)).not.toBeNull();
    expect("import.meta.glob('../blocks/security/index.jsx')".match(LITERAL_BLOCK_IMPORT)).toBeNull();
  });
});
