/**
 * Regression: the Cookbook install routes must derive dataRoot from the
 * registry file the same way paths.cjs does.
 *
 * Both POST /cookbook/local/install-runtime and POST /cookbook/local/install
 * computed `path.resolve(reg.file, '..', '..', '..')`. The registry lives at
 * <dataRoot>/local-runtime/local-runtime.json, so three levels up is the APP
 * ROOT, not dataRoot.
 *
 * The failure was silent and total: the download ran, the SHA-256 verified, the
 * GGUF probed, the registry said "ready" — all under <appRoot>/local-runtime/.
 * readyModels() reads <dataRoot>/local-runtime/, saw nothing, and the UI showed
 * "no models" forever. 185 MB of correctly-installed model, invisible.
 *
 * This asserts the real source text, because the bug is a literal path segment
 * count — mocking the route would prove nothing about what ships.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

const P = require(path.join(APP_ROOT, 'services', 'local-runtime', 'paths.cjs'));
const ROUTE_SRC = fs.readFileSync(
  path.join(APP_ROOT, 'src', 'blocks', 'cookbook', 'api', 'index.cjs'), 'utf8');

describe('install routes: dataRoot derivation', () => {
  it('registryPath() sits exactly two levels below dataRoot', () => {
    const dataRoot = path.join(APP_ROOT, 'data');
    const regFile = P.registryPath(dataRoot);
    // The contract the routes depend on. If the registry ever moves, this
    // fails first and tells you the routes must move with it.
    expect(path.resolve(regFile, '..', '..')).toBe(path.resolve(dataRoot));
    expect(path.resolve(regFile, '..', '..', '..')).not.toBe(path.resolve(dataRoot));
  });

  it('no install route walks three levels up from the registry file', () => {
    const bad = /path\.resolve\(\s*reg\.file\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'\.\.'\s*\)/g;
    const hits = ROUTE_SRC.match(bad) || [];
    expect(hits, 'three-level resolve escapes dataRoot to the app root').toHaveLength(0);
  });

  it('every reg.file-derived dataRoot uses exactly two levels', () => {
    const derivations = ROUTE_SRC.match(/path\.resolve\(\s*reg\.file[^)]*\)/g) || [];
    expect(derivations.length, 'expected the runtime + model install routes').toBeGreaterThanOrEqual(2);
    for (const d of derivations) {
      const levels = (d.match(/'\.\.'/g) || []).length;
      expect(levels, `wrong level count in: ${d}`).toBe(2);
    }
  });
});

describe('install routes: failures are not silent (R-05)', () => {
  // Both routes previously reported failure only into an in-memory task map or
  // a per-session log file. Nothing reached the console, so a failed install
  // was indistinguishable from one that never started.
  it('both install routes log failure to the console', () => {
    const runtimeFail = /console\.error\(`\[LOCAL RUNTIME\] Install FAILED/;
    const modelFail = /console\.error\(`\[LOCAL MODEL\] Install FAILED/;
    expect(ROUTE_SRC).toMatch(runtimeFail);
    expect(ROUTE_SRC).toMatch(modelFail);
  });

  it('local status surfaces the last runtime-install outcome', () => {
    // Without this the panel can only say "not installed", never "failed, and
    // here is why".
    expect(ROUTE_SRC).toMatch(/\binstall,/);
    expect(ROUTE_SRC).toMatch(/latest\('runtime-install'\)/);
  });

  it('local status surfaces the last MODEL-install outcome too', () => {
    // The status route only ever reported runtime installs, and the model
    // installer never registered a task at all — so a failed model install
    // showed as "not installed" with no reason, which reads to a user as the
    // button doing nothing. That is the failure the CEO hit on a clean machine.
    expect(ROUTE_SRC).toMatch(/type: 'model-install'/);
    expect(ROUTE_SRC).toMatch(/latest\('model-install'\)/);
    expect(ROUTE_SRC).toMatch(/modelInstall,/);
  });

  it('the model catalog is reachable from the Cookbook UI', () => {
    // The self-contained installer (no Python, no HF CLI) existed but had no
    // button. The only model-install control called the HF/python path, which
    // is why a clean machine could not install a model at all.
    const ui = fs.readFileSync(
      path.join(APP_ROOT, 'src', 'blocks', 'cookbook', 'index.jsx'), 'utf8');
    expect(ui).toMatch(/\/api\/cookbook\/local\/catalog/);
    expect(ui).toMatch(/\/api\/cookbook\/local\/install['"]/);
  });
});
