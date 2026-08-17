/**
 * The 2026-08-06 writer incident, closed.
 *
 * writer/block.manifest.json was found gutted to scaffold defaults mid-session
 * — route table, AI roles and permissions wiped — breaking four unrelated test
 * files until it was restored by hand. It never reproduced, and three reports
 * carried it as "suspect blockStandard.syncAllBlocks, not reproduced since".
 *
 * It could not reproduce because a normal boot cannot reproduce it. The
 * mechanism needs a manifest that EXISTS but cannot be parsed at the instant
 * sync reads it:
 *
 *   readManifest()      returns null for "absent" AND for "unparseable"
 *   normalizeManifest() did `readManifest(folder) || {}`
 *   syncAllBlocks()     writes the normalized result back over the file
 *
 * So a transient read failure — a concurrent write, an editor mid-save, a
 * partial flush — became permanent data loss, performed by the code whose job
 * is to heal drift. R-05: no silent failures.
 *
 * blocksDir.cjs itself records the observed race: on 2026-08-10 two readers
 * were caught mid-write, one of them hitting "Unexpected end of JSON input",
 * roughly one run in three. That is the same window this defect needs.
 *
 * These tests drive the real kernel over a scratch blocks dir.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

// AEON_BLOCKS_DIR must be set BEFORE the require below: blocksDir.cjs resolves
// BLOCKS_DIR at module scope, deliberately, so a value cannot change between
// two reads in one process.
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-manifest-'));
process.env.AEON_BLOCKS_DIR = FIXTURE;

const std = require('../src/kernel/blockStandard.cjs');

const BLOCK = 'probe_block';
const blockDir = path.join(FIXTURE, BLOCK);
const manifestPath = path.join(blockDir, 'block.manifest.json');
const write = (contents) => fs.writeFileSync(manifestPath, contents, 'utf8');

/** A manifest carrying exactly the fields the incident destroyed. */
const REAL_MANIFEST = {
  id: BLOCK,
  description: 'A real block with real content',
  routes: [
    { path: '/api/probe/items', method: 'GET', auth: true },
    { path: '/api/probe/items', method: 'POST', auth: true },
  ],
  contract: {
    permissions: ['vault:read', 'vault:write'],
    ai: { capabilities: ['summarize'], roles: ['writer'] },
  },
};

beforeEach(() => {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  fs.mkdirSync(blockDir, { recursive: true });
});

afterAll(() => {
  delete process.env.AEON_BLOCKS_DIR;
  try { fs.rmSync(FIXTURE, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe('classifyManifest tells absent apart from unreadable', () => {
  it('absent is absent — defaults are correct for a genuinely new block', () => {
    expect(std.classifyManifest(BLOCK).state).toBe('absent');
  });

  it('a valid JSON object is present', () => {
    write(JSON.stringify(REAL_MANIFEST));
    const r = std.classifyManifest(BLOCK);
    expect(r.state).toBe('present');
    expect(r.data.routes).toHaveLength(2);
  });

  // Every one of these used to be indistinguishable from "absent", and every
  // one is a real shape a file takes while another process is writing it.
  it.each([
    ['an empty file', ''],
    ['whitespace only', '   \n  '],
    ['a truncated write', '{"id":"probe_block","routes":[{"path":"/api/'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['not JSON at all', 'this is not json'],
  ])('%s is unreadable, not absent', (_label, contents) => {
    write(contents);
    const r = std.classifyManifest(BLOCK);
    expect(r.state).toBe('unreadable');
    expect(r.error).toBeTruthy();
  });
});

describe('an unreadable manifest is never overwritten', () => {
  it('normalizeManifest refuses rather than returning scaffold defaults', () => {
    write('{"id":"probe_block","routes":[{"path":"/api/');
    expect(() => std.normalizeManifest(BLOCK)).toThrowError(/refusing to normalize probe_block/);
  });

  it('syncAllBlocks leaves the bytes on disk untouched', () => {
    // THE REGRESSION TEST FOR 2026-08-06. Before the fix this file came back
    // normalized to a scaffold: routes [], no permissions, no ai roles.
    const truncated = '{"id":"probe_block","routes":[{"path":"/api/';
    write(truncated);

    std.syncAllBlocks({ writeRuntime: false });

    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(truncated);
  });

  it('still boots, and still syncs the healthy blocks', () => {
    // One corrupt manifest must not stop AEON booting, or the operator loses
    // the server they need in order to fix it — the same reasoning as the
    // first-run vault guard (P0-01).
    const healthy = path.join(FIXTURE, 'healthy_block');
    fs.mkdirSync(healthy, { recursive: true });
    fs.writeFileSync(
      path.join(healthy, 'block.manifest.json'),
      JSON.stringify({ id: 'healthy_block', description: 'fine' }),
      'utf8',
    );
    write('{ broken');

    const registry = std.syncAllBlocks({ writeRuntime: false });

    expect(registry.map((b) => b.id)).toContain('healthy_block');
    expect(registry.map((b) => b.id)).not.toContain(BLOCK);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe('{ broken');
  });
});

describe('a healthy manifest keeps the fields the incident destroyed', () => {
  it('routes, permissions and ai roles survive a normalize', () => {
    write(JSON.stringify(REAL_MANIFEST, null, 2));

    const out = std.normalizeManifest(BLOCK);

    expect(out.routes, 'the route table was wiped').toHaveLength(2);
    expect(out.contract.permissions, 'permissions were wiped')
      .toEqual(['vault:read', 'vault:write']);
    expect(out.contract.ai?.roles, 'AI roles were wiped').toEqual(['writer']);
  });
});
