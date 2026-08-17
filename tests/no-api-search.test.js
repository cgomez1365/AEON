/**
 * POST /api/search is deleted. This gate fails if it comes back.
 *
 * It existed for one caller: src/components/NeuralTerminal.jsx, which called it
 * on every submitted message. That file was deleted 2026-08-16 (§21) and this
 * route went with it — a route with no caller is a surface a buyer can reach
 * and nobody maintains.
 *
 * The route was verified live before deletion, not just grepped: booted at
 * 127.0.0.1:3001, POST /api/search answered HTTP 200 {"documents":[],
 * "skipped":true}. So this removes something that was genuinely mounted, which
 * is why the functional half below matters.
 *
 * What survives, and must keep working: POST /crn/second-brain/retrieve — the
 * block-namespaced route that dashboard/api/chat.cjs actually uses, and which
 * orion_search fans out to. Retrieval is not being removed; one duplicate,
 * unnamespaced entry point to it is.
 *
 * §18 — a deletion needs a functional test, not only an absence test. An
 * absence-only gate here would pass just as happily on a product with no
 * Second Brain retrieval at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RETRIEVE = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'api', 'retrieve.cjs');
const MANIFEST = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'block.manifest.json');

describe('POST /api/search stays deleted', () => {
  it('retrieve.cjs mounts no bare /search handler', () => {
    const src = fs.readFileSync(RETRIEVE, 'utf8');
    expect(/router\.(post|get|all)\(\s*['"]\/search['"]/.test(src),
      'retrieve.cjs mounts /search again — it has no caller').toBe(false);
  });

  it('no manifest declares /api/search', () => {
    // A declared route with no handler is the inverse defect: the product
    // advertises a capability it does not have, which is what /scrape did.
    const blocks = path.join(ROOT, 'src', 'blocks');
    const offenders = [];
    for (const b of fs.readdirSync(blocks)) {
      const m = path.join(blocks, b, 'block.manifest.json');
      if (!fs.existsSync(m)) continue;
      const json = JSON.parse(fs.readFileSync(m, 'utf8'));
      for (const r of json.routes || []) {
        if (r.path === '/api/search') offenders.push(b);
      }
    }
    expect(offenders, `these manifests still declare /api/search: ${offenders.join(', ')}`)
      .toEqual([]);
  });
});

describe('Second Brain retrieval still exists after the deletion', () => {
  it('the block-namespaced retrieve route is still mounted', () => {
    const src = fs.readFileSync(RETRIEVE, 'utf8');
    expect(/router\.post\(\s*['"]\/crn\/second-brain\/retrieve['"]/.test(src)
      || /router\.post\(\s*['"]\/retrieve['"]/.test(src),
      'the surviving retrieval route is gone — this deletion removed the feature').toBe(true);
  });

  it('the manifest still declares a retrieval route', () => {
    const json = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const retrieval = (json.routes || []).filter((r) => /retrieve/.test(r.path || ''));
    expect(retrieval.length,
      'aeon_matrix declares no retrieval route at all').toBeGreaterThan(0);
  });

  it('the real caller still points at the surviving route', () => {
    // dashboard/api/chat.cjs is what actually performs Second Brain lookups on
    // a terminal turn. If this ever changes to /api/search, the deletion breaks
    // chat and this gate is the thing that says so.
    const chat = path.join(ROOT, 'src', 'blocks', 'dashboard', 'api', 'chat.cjs');
    const src = fs.readFileSync(chat, 'utf8');
    expect(/crn\/second-brain\/retrieve/.test(src),
      'dashboard chat no longer calls the namespaced retrieve route').toBe(true);
    expect(/['"`][^'"`]*\/api\/search['"`]/.test(src),
      'dashboard chat calls the deleted /api/search').toBe(false);
  });
});
