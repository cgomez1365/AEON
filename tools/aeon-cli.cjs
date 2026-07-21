#!/usr/bin/env node
/**
 * DX1 — aeon CLI (Ship Plan v2, Month 1)
 *   aeon lint <id|path>   deterministic gate checks (schema + code) — run BEFORE submitting
 *   aeon pack <id>        lint + bundle a store-ready .aeon cartridge into dist-blocks/
 *   aeon promote <id>     staging/<id> → src/blocks/<id> through the lint airlock
 *   aeon dev <id>         isolated dev server on :3002 (staging/ or src/blocks/), hot-remount on save
 *   aeon new <id>         copy _template into staging/<id> and personalize
 *
 * Deterministic only — the CLI never calls an LLM.
 */
const path = require('path');
const fs   = require('fs');
const { lintBlock, promoteBlock, ensureStagingDir, BLOCKS_DIR, STAGING_DIR } = require('../src/kernel/staging.cjs');

const [, , cmd, arg] = process.argv;
const ROOT = path.join(__dirname, '..');

function resolveBlockDir(idOrPath) {
  if (!idOrPath) return null;
  for (const candidate of [
    path.resolve(idOrPath),
    path.join(STAGING_DIR, idOrPath),
    path.join(BLOCKS_DIR, idOrPath),
  ]) {
    if (fs.existsSync(path.join(candidate, 'block.manifest.json'))) return candidate;
  }
  return null;
}

function printLint(result, dir) {
  console.log(`\naeon lint — ${dir}`);
  console.log(`score: ${result.score}`);
  if (result.errors.length) { console.log('ERRORS:'); result.errors.forEach(e => console.log(`  ✗ ${e}`)); }
  if (result.findings.length) {
    console.log('FINDINGS:');
    result.findings.forEach(f => console.log(`  [${f.sev}] ${f.check} in ${f.file} — ${f.why}`));
  }
  if (!result.errors.length && !result.findings.length) console.log('  ✓ clean');
}

const commands = {
  lint() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg} (looked in staging/, src/blocks/, and as a path)`); process.exit(1); }
    const result = lintBlock(dir);
    printLint(result, dir);
    process.exit(result.errors.length || result.findings.some(f => f.sev === 'HIGH') ? 1 : 0);
  },

  pack() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg}`); process.exit(1); }
    const result = lintBlock(dir);
    if (result.errors.length || result.findings.some(f => f.sev === 'HIGH')) {
      printLint(result, dir);
      console.error('\npack refused — fix lint first. Nothing goes to the store without passing pack.');
      process.exit(1);
    }
    const AdmZip = require('adm-zip');
    const m = result.manifest;
    const outDir = path.join(ROOT, 'dist-blocks');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${m.id}-${m.version || '0.0.0'}.aeon`);
    const zip = new AdmZip();
    zip.addLocalFolder(dir, m.id, (p) => !/(^|[\/\\])(data|node_modules|\.aeon\.runtime\.json)([\/\\]|$)/.test(p));
    zip.writeZip(outFile);
    console.log(`✓ packed ${outFile} (score ${result.score})`);
  },

  promote() {
    const r = promoteBlock(arg);
    if (!r.ok) {
      console.error(`✗ ${r.error}`);
      if (r.lint) printLint(r.lint, path.join(STAGING_DIR, arg));
      process.exit(1);
    }
    console.log(`✓ promoted ${r.promoted} → src/blocks/ (score ${r.score}). ${r.note}`);
  },

  new() {
    if (!arg || !/^[a-z0-9_]+$/.test(arg) || arg.startsWith('_')) {
      console.error('usage: aeon new <id>  (lowercase a-z0-9_, no leading underscore)');
      process.exit(1);
    }
    ensureStagingDir();
    const dst = path.join(STAGING_DIR, arg);
    if (fs.existsSync(dst)) { console.error(`staging/${arg} already exists`); process.exit(1); }
    fs.cpSync(path.join(BLOCKS_DIR, '_template'), dst, { recursive: true });
    const mPath = path.join(dst, 'block.manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    m.id = arg; m.route = `/${arg}`; m.label = arg.replace(/_/g, ' ');
    m.nav.hidden = false; m.nav.label = m.label;
    m.routes = [{ method: 'ALL', path: `/${arg}/*`, auth: true }];
    m.description = '';
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    console.log(`✓ staging/${arg} created from _template. Edit it, then: aeon lint ${arg} && aeon promote ${arg}`);
  },

  dev() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg}`); process.exit(1); }
    const express = require('express');
    const app = express();
    app.use(express.json());
    let mounted = [];

    const mount = () => {
      app._router && (app._router.stack = app._router.stack.filter(l => !l._aeonDev));
      mounted = [];
      const apiDir = path.join(dir, 'api');
      if (fs.existsSync(apiDir)) {
        for (const f of fs.readdirSync(apiDir).filter(f => /\.(cjs|js)$/.test(f) && !f.startsWith('_'))) {
          const full = path.join(apiDir, f);
          delete require.cache[require.resolve(full)]; // hot-remount = full module cache purge (B6)
          try {
            const factory = require(full);
            // dev deps are deliberately empty-ish: isolated block sees no production state (DX2)
            const devDeps = { isVercel: false, fs, path, getLocalFile: (n) => path.join(dir, 'data', n) };
            if (typeof factory === 'function') {
              if (factory.length === 1) { const r = factory(devDeps); if (r) { const layer = app.use('/api', r); } }
              else factory(app, devDeps);
              mounted.push(f);
            }
          } catch (e) { console.error(`  mount failed ${f}: ${e.message}`); }
        }
      }
      console.log(`[aeon dev] mounted: ${mounted.join(', ') || '(no api files)'}`);
    };

    mount();
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.watch(dir, { recursive: true }, (_evt, file) => {
      if (file && /\.(cjs|js|jsx|json)$/.test(file) && !file.includes('data')) {
        console.log(`[aeon dev] change: ${file} → remounting`);
        try { mount(); } catch (e) { console.error(e.message); }
      }
    });
    app.get('/', (_req, res) => res.json({ dev: true, block: path.basename(dir), apis: mounted, note: 'isolated dev server — sees its own data/ only (DX2)' }));
    app.listen(3002, () => console.log(`[aeon dev] ${path.basename(dir)} on http://localhost:3002 (isolated, staging-safe)`));
  },
};

if (!cmd || !commands[cmd]) {
  console.log('aeon — AEON block DX CLI\n  aeon new <id>      scaffold into staging/\n  aeon lint <id>     deterministic gate checks\n  aeon dev <id>      isolated dev server :3002\n  aeon pack <id>     build .aeon cartridge\n  aeon promote <id>  staging → src/blocks via airlock');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
