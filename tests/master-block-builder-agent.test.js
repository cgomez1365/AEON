/**
 * The Block Builder persona: one Markdown file, served by master, with a
 * loop that ends in verification — not in "files written".
 *
 * CEO, 2026-09-07: "add a md persona agent — give it a looped agentic form so
 * users can copy it to their ai of choice to build them a true aeon block —
 * start to finish."
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const MD = path.join(ROOT, 'src/blocks/master/AEON_BLOCK_BUILDER.md');
const md = fs.readFileSync(MD, 'utf8');

describe('the persona file', () => {
  it('is a loop: phases A–I, each with an exit check and an on-failure rule', () => {
    const phases = md.match(/^### Phase [A-I] — /gm) || [];
    expect(phases.length).toBe(9);
    expect((md.match(/\*\*Exit check:\*\*/g) || []).length).toBeGreaterThanOrEqual(8);
    expect((md.match(/\*\*On failure:\*\*/g) || []).length).toBeGreaterThanOrEqual(8);
  });

  it('ends in verification against a running server, and a report that may say PARTIAL', () => {
    expect(md).toMatch(/blocks\/registry/);
    expect(md).toMatch(/npm run build/);
    expect(md).toMatch(/npm run aeon lint/);
    expect(md).toMatch(/npm run aeon promote/);
    expect(md).toMatch(/scan:release-gate/);
    expect(md).toMatch(/DONE \| PARTIAL/);
    expect(md).toMatch(/Do not describe a result you did not see/);
  });

  it('names paths that exist and the icon drop-in location', () => {
    for (const p of ['src/blocks/_template/', 'public/brand/block-icons/', 'src/kernel/blockStandard.cjs', 'src/kernel/blockRegistry.js', 'server/block-loader.js', 'src/kernel/staging.cjs', 'tools/aeon-cli.cjs']) {
      expect(md).toContain(p);
      expect(fs.existsSync(path.join(ROOT, p)), p).toBe(true);
    }
    expect(md).toMatch(/public\/brand\/block-icons\/<id>\.svg/);
  });

  it('its manifest skeleton carries the live manifestVersion', () => {
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocks/_template/block.manifest.json'), 'utf8'));
    expect(md).toContain(`"manifestVersion": "${tpl.manifestVersion}"`);
  });
});

describe('master serves it', () => {
  it('GET /api/master/agent.md returns the file as markdown', async () => {
    const router = require('../src/blocks/master/api/master.cjs')({});
    const app = express(); app.use('/api', router);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/api/master/agent.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/markdown/);
      expect(await res.text()).toBe(md);
    } finally { s.close(); }
  });

  it('the page has a Copy affordance for it', () => {
    const page = fs.readFileSync(path.join(ROOT, 'src/blocks/master/index.jsx'), 'utf8');
    expect(page).toMatch(/\/api\/master\/agent\.md/);
    expect(page).toMatch(/Copy agent/);
  });
});
