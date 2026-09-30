/**
 * The shell never writes a layout it did not read (sweep follow-up to C04).
 *
 * DesktopLayout and MobileLayout fell back to an EMPTY layout when GET
 * /api/settings failed (a 401 after a session ended, a restart, a dead
 * network), and every layout save is a full replace: the next Dashboard drag
 * wrote that empty stand-in plus one placement over every section the
 * operator had made. A failed read now leaves the layout null (sections show
 * their defaults) and a save is refused, with a reason, while it is null.
 *
 * Master's install panel writes the layout itself and then hands it to the
 * shell; the shell adopted it by writing it a second time, and a failure of
 * only that second write reverted the shell to a copy without the placement.
 * It is adopted now ({ saved: true }), not re-written.
 *
 * No DOM in this suite (vitest environment: node), so the wiring is read from
 * the source, comments stripped.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const between = (src, from, to) => {
  const i = src.indexOf(from);
  expect(i, `missing: ${from}`).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf(to, i + from.length));
};

for (const file of ['DesktopLayout.jsx', 'MobileLayout.jsx']) {
  describe(`${file}`, () => {
    const src = code('src', 'components', file);

    it('a failed settings read leaves the layout unread, not empty', () => {
      const load = between(src, "fetch('/api/settings')", '}, []);');
      expect(load).not.toMatch(/\.catch\(\(\) => setBlockLayout\(/);
      expect(load).not.toMatch(/d\?\.settings\?\.blockLayout \|\|/);
      // Only a reply that carries settings sets it.
      expect(load).toMatch(/const s = d\?\.settings;\s*if \(s && typeof s === 'object'/);
    });

    it('a save is refused, with the reason, while the saved layout is unread', () => {
      const save = between(src, 'const saveBlockLayout = useCallback(', '}, []);');
      const refuse = save.indexOf('window.alert(LAYOUT_NOT_READ)');
      expect(refuse).toBeGreaterThan(-1);
      expect(save).toMatch(/if \(!(previous|layoutRef\.current)\) \{ console\.warn\(`\[LAYOUT\] \$\{LAYOUT_NOT_READ\}`\); window\.alert\(LAYOUT_NOT_READ\); return; \}/);
      expect(refuse).toBeLessThan(save.indexOf("fetch('/api/settings/block-layout'"));
    });

    it('a layout the caller already saved is adopted, not written again', () => {
      const save = between(src, 'const saveBlockLayout = useCallback(', '}, []);');
      expect(save).toMatch(/\(next, \{ saved = false \} = \{\}\)/);
      expect(save.indexOf('if (saved) { setBlockLayout(next); return; }')).toBeLessThan(save.indexOf("fetch('/api/settings/block-layout'"));
    });
  });
}

describe('Master → Install hands the shell a layout it already saved', () => {
  it('passes { saved: true } with it', () => {
    const src = code('src', 'blocks', 'master', 'InstallPanel.jsx');
    expect(src).toMatch(/onBlockLayoutChange\(next, \{ saved: true \}\)/);
    expect(src).not.toMatch(/onBlockLayoutChange\(next\)/);
  });
});

// Sweep C31, the half that reaches the operator: the server marks every answer
// X-AEON-UI-Stale when dist/ predates the UI source; nothing read it.
describe('the stale-screen notice', () => {
  it('DesktopLayout reads the header and says what to do', () => {
    const src = code('src', 'components', 'DesktopLayout.jsx');
    expect(src).toMatch(/setUiStale\(r\.headers\.get\('X-AEON-UI-Stale'\)\)/);
    expect(src).toMatch(/\{uiStale && \(\s*<div role="alert"/);
    expect(src).toMatch(/npm run build<\/code> in the AEON folder and reload this tab/);
  });
});
