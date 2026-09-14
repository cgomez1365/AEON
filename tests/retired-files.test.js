/**
 * Files retired in the 2026-09-14 stale-file sweep, and they stay retired.
 *
 * CEO, 2026-09-14: "Note how some files in the GitHub repo haven't been touched
 * in months. Go through them all. If they are not needed, delete."
 *
 * Method (Bible §21 — prove dead, gate first, one scoped commit):
 *   1. Every tracked file last committed before 2026-08-14 (366 of 581) was
 *      scanned for a consumer: an import or require (including extensionless
 *      specifiers), an npm script, CI, a launcher, HTML, or a URL built from its
 *      path. Files the kernel or Vite pick up by convention (block manifests,
 *      block UIs, block APIs, tests, docs) were excluded from deletion.
 *   2. The 42 with no consumer were re-checked by hand; seven had real
 *      consumers the name scan missed and were kept (e.g. src/kernel/auth.js,
 *      imported extensionless by three components; sections/work.svg, built as
 *      `sections/${name}.svg`; scripts/build-usb.js, loaded by usb-portable).
 *   3. What remains is below. Most had not changed since the initial commit.
 *
 * Two corrections recorded here because they reverse earlier claims:
 *   - public/models (24 depth-map PNGs, ~14 MB) was called "in use" on
 *     2026-09-13 because src/kernel/utils/mathModels.js lists them. Nothing
 *     loads mathModels.js, so nothing loads the PNGs.
 *   - AEON has never been deployed to Vercel from this repository: all eight
 *     projects on the account show zero deployments since the repo was created
 *     (2026-07-21). api/debug.js, which returns stack traces to any caller, was
 *     reachable only in a deployment that never happened — and is removed
 *     before one does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const RETIRED = {
  // UI components nothing renders.
  'src/components/LandingPage.jsx': 'no importer; the console boots straight into the layout',
  'src/components/NeuronViewport.jsx': 'no importer; the Matrix graph uses its own vendor bundle',
  'src/components/NoteEditor.jsx': 'no importer',
  'src/components/StatusWidget.jsx': 'no importer',
  'src/components/MobileCommandDashboard.jsx': 'no importer; byte-for-byte duplicate of the dashboard copy',
  'src/blocks/dashboard/components/MobileCommandDashboard.jsx': 'no importer',
  'src/blocks/fleet_control/components/AgentTelemetry.jsx': 'no importer',
  // Kernel utilities nothing calls.
  'src/kernel/hooks/useAudioRecorder.js': 'no importer',
  'src/kernel/utils/audioEngine.js': 'no importer',
  'src/kernel/utils/exportPDF.js': 'no importer',
  'src/kernel/utils/mathModels.js': 'no importer — the only reference to public/models',
  'src/kernel/server-utils/governance.js': 'no importer',
  'src/kernel/skillifyHook.cjs': 'no importer',
  'src/kernel/workflowHost.cjs': 'no importer',
  'src/utils/supabaseFallback.js': 'no importer',
  'services/treasury.js': 'no importer; the treasury panel it fed was removed from Dashboard',
  'services/local-runtime/registry.schema.json': 'never loaded; registry.cjs validates in code',
  // One-off scripts and harnesses nothing runs.
  'src/firestore_seed.js': 'one-off 2026-05 seed for a 12-agent fleet that no longer exists',
  'tools/research_agent.py': 'no caller; AEON has no Python runtime',
  'tools/incremental-index.mjs': 'the pre-ingest.cjs indexer; still reads .docx, which AEON dropped',
  'tools/stress/terminal-stress.mjs': 'no script or CI; drives /scan-all, a command that no longer exists',
  'tools/stress/terminal-stress-round2.mjs': 'no script or CI',
  'tools/stress/terminal-stress-round3.mjs': 'no script or CI',
  'tools/stress/terminal-stress-round4.mjs': 'no script or CI',
  'tools/stress/block-stress-local.mjs': 'no script or CI',
  'tools/stress/settings-audit.mjs': 'no script or CI',
  'tools/stress/verify-totp-reinstalls.mjs': 'no script or CI',
  'tools/stress/totp-reinstall-worker.mjs': 'spawned only by verify-totp-reinstalls.mjs',
  // Vite starter-template leftovers.
  'src/counter.ts': 'Vite vanilla-ts template file; nothing imports it',
  'tsconfig.json': 'only included src/counter.ts; no script runs tsc',
  'src/assets/hero.png': 'template asset; no reference',
  'src/assets/vite.svg': 'template asset; no reference',
  'src/assets/typescript.svg': 'template asset; no reference',
  // Exposure that only a deployment could reach.
  'api/debug.js': 'returned stack traces to any caller on a Vercel deployment',
};

// The depth-map images whose only consumer was mathModels.js.
const RETIRED_DIRS = ['public/models/'];

const CODE = tracked.filter(f => /\.(js|cjs|mjs|jsx|ts|tsx|html)$/.test(f) && !f.startsWith('tests/') && !f.startsWith('src/blocks/aeon_matrix/public/vendor/'));
const code = Object.fromEntries(CODE.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

describe('retired files are gone', () => {
  for (const [file, why] of Object.entries(RETIRED)) {
    it(`${file} — ${why}`, () => {
      expect(tracked).not.toContain(file);
    });
  }

  it('public/models is gone with the only module that listed it', () => {
    for (const dir of RETIRED_DIRS) expect(tracked.filter(f => f.startsWith(dir))).toEqual([]);
  });
});

describe('and nothing still loads them', () => {
  it('no code imports or requires a retired module', () => {
    const specifiers = Object.keys(RETIRED)
      .filter(f => /\.(js|cjs|mjs|jsx|ts)$/.test(f))
      .map(f => path.basename(f).replace(/\.(js|cjs|mjs|jsx|ts)$/, ''));
    const offenders = [];
    for (const [f, src] of Object.entries(code)) {
      for (const name of specifiers) {
        const re = new RegExp(`(?:import[^'"\`]*|require\\(|import\\()\\s*['"\`][^'"\`]*/${name}(?:\\.[a-z]+)?['"\`]`);
        if (re.test(src)) offenders.push(`${f} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no code builds a /models/ image URL', () => {
    const offenders = Object.entries(code)
      .filter(([, src]) => /['"`]\/models\/[^'"`]*\.png/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('TypeScript is gone as a dependency, not just as a config', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies?.typescript).toBeUndefined();
    expect(pkg.dependencies?.typescript).toBeUndefined();
  });
});
