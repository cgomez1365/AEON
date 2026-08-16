/**
 * NeuralTerminal.jsx is deleted. This gate fails if it comes back.
 *
 * 1,786 lines, replaced by Terminal2 on 2026-08-07 and kept as a rollback
 * path. That rollback stopped working almost immediately: Terminal2 has since
 * gained real stream cancellation (D1c), the challenge/outcome state machine
 * (D2c), honest empty output (D2d) and the argument contract (D2e). Reverting
 * to NeuralTerminal would have reintroduced every defect BO-D closed. It also
 * still called /api/orion-scrape and /api/memory/tidy, neither of which
 * exists. Deleted 2026-08-16 per Bible §21; git history is the rollback path.
 *
 * The trap this file exists to avoid: an absence-only gate passes just as
 * happily on a product with no terminal at all. §18 — every deletion needs a
 * functional test, not only an absence test. So the third block below asserts
 * the layouts still mount a terminal, and that it is Terminal2.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|cjs|mjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

describe('NeuralTerminal.jsx stays deleted', () => {
  it('the file does not exist', () => {
    expect(fs.existsSync(path.join(SRC, 'components', 'NeuralTerminal.jsx'))).toBe(false);
  });

  it('nothing imports it, by any spelling', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      const txt = fs.readFileSync(file, 'utf8');
      // An import of the MODULE — not the local identifier, which several
      // layouts legitimately still call NeuralTerminal while importing
      // ./Terminal2. The module specifier is what resolves to a file.
      if (/from\s*['"][^'"]*\/NeuralTerminal['"]|from\s*['"]\.\/NeuralTerminal['"]|import\s*\(\s*['"][^'"]*NeuralTerminal['"]/.test(txt)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the terminal still works after the deletion', () => {
  // The functional half. Absence alone is not evidence the product survived.
  const layouts = ['DesktopLayout.jsx', 'MobileLayout.jsx'];

  for (const name of layouts) {
    it(`${name} still mounts a terminal, and it is Terminal2`, () => {
      const file = path.join(SRC, 'components', name);
      expect(fs.existsSync(file)).toBe(true);
      const txt = fs.readFileSync(file, 'utf8');

      // It imports Terminal2 — whatever the local identifier is called.
      const imp = txt.match(/import\s+(\w+)\s+from\s*['"]\.\/Terminal2['"]/);
      expect(imp, `${name} must import ./Terminal2`).not.toBeNull();

      // And it actually renders that identifier.
      const ident = imp[1];
      expect(new RegExp(`<${ident}[\\s/>]`).test(txt),
        `${name} imports ${ident} but never renders it`).toBe(true);
    });
  }

  it('Terminal2 exists and is not a stub', () => {
    const t2 = path.join(SRC, 'components', 'Terminal2.jsx');
    expect(fs.existsSync(t2)).toBe(true);
    expect(fs.readFileSync(t2, 'utf8').length).toBeGreaterThan(1000);
  });
});
