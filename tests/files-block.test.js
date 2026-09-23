/**
 * The Files block, measured as the operator uses it (agent C4, 2026-09-23,
 * macOS, fresh isolated home, no Supabase).
 *
 * 1. /api/notes was declared `ALL` (gen-block-routes emits ALL for the computed
 *    `methods.forEach(m => app[m](...))` registration) and manifestRouteAuth
 *    only protects a route whose method equals the request's — so with an
 *    account and the global guard off, GET/POST/PUT/DELETE /api/notes reached
 *    the handler with no session (live: 503 CLOUD_NOT_CONFIGURED instead of
 *    401; with Supabase configured, the notes themselves).
 * 2. The registry reported files `ready:false, missingApis:["supabase"]` on a
 *    local-only install while the Local pane — the block's main job — works
 *    with no cloud at all. Supabase is optional (the Cloud pane and Cloud Notes).
 * 3. The Local pane calls host_os's /api/fs/* and declared no dependency on it.
 * 4. New folder / Upload at the landing view built paths from the browser's
 *    WORKSPACE constant, which no build sets: New folder asked for `/<name>`
 *    (403 outside the allowed area) and Upload wrote into the workspace instead
 *    of the Vault on screen (live: "saved" and the file never appeared).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK = path.join(ROOT, 'src', 'blocks', 'files');
const manifest = () => JSON.parse(fs.readFileSync(path.join(BLOCK, 'block.manifest.json'), 'utf8'));

describe('/api/notes needs a session once an account exists', () => {
  it('declares every method it serves — no ALL, which the manifest guard never matches', () => {
    const notes = manifest().routes.filter((r) => r.path === '/api/notes');
    expect(notes.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'POST', 'PUT']);
    expect(notes.every((r) => r.auth === true)).toBe(true);
  });

  it('a real request with no session is refused, for every method (guard off, account exists)', async () => {
    const { manifestAuthGuard } = require('../src/kernel/manifestRouteAuth.cjs');
    const mountNotes = require('../src/blocks/files/api/notes.js');
    const sessions = {
      hasAccount: () => true,
      isPreAuthRequest: (req) => req.method === 'OPTIONS',
      validateSession: () => ({ ok: false, reason: 'no-session' }),
    };
    const app = express();
    app.use(express.json());
    app.use(manifestAuthGuard(manifest(), sessions));
    const router = express.Router();
    mountNotes(router, {});
    app.use(router);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/notes`;
    try {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        const body = await res.json();
        expect(res.status, `${method} /api/notes`).toBe(401);
        expect(body.declaredBy).toBe(`files manifest: ${method} /api/notes`);
      }
    } finally { server.close(); }
  });
});

describe('what files needs is what it declares', () => {
  const std = require('../src/kernel/blockStandard.cjs');

  it('is ready on a local-only install — Supabase is optional', () => {
    const r = std.checkReadiness(manifest(), {});
    expect(r.missingApis).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('declares host_os (the Local pane is /api/fs/*), in both fields', () => {
    const m = manifest();
    expect(m.requires.blocks).toEqual(['host_os']);
    expect(m.dependencies).toEqual(['host_os']);
    const r = std.checkReadiness(std.normalizeManifest('files'), {}, new Set(['files']));
    expect(r.missingBlocks).toEqual(['host_os']);
  });
});

describe('Local pane path arithmetic', () => {
  it('never builds a path from the build-time WORKSPACE constant', () => {
    const src = fs.readFileSync(path.join(BLOCK, 'index.jsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(src).not.toMatch(/\bWORKSPACE\b/);
    // The landing folder comes from the server's own answer.
    expect(src).toMatch(/data\.path/);
  });

  it('joins, climbs and crumbs on POSIX and Windows paths', async () => {
    const { sepOf, joinPath, parentOf, crumbsFor } = await import('../src/blocks/files/localPaths.js');
    expect(sepOf('/Users/me/AEON/Vault')).toBe('/');
    expect(sepOf('C:\\Users\\me\\AEON\\Vault')).toBe('\\');
    expect(joinPath('/Users/me/AEON/Vault', 'Projects')).toBe('/Users/me/AEON/Vault/Projects');
    expect(joinPath('/', 'tmp')).toBe('/tmp');
    expect(joinPath('C:\\Users\\me\\Vault\\', 'Projects')).toBe('C:\\Users\\me\\Vault\\Projects');
    expect(parentOf('/Users/me/AEON/Vault')).toBe('/Users/me/AEON');
    expect(parentOf('/Users')).toBe('/');
    expect(parentOf('C:\\Users\\me')).toBe('C:\\Users');
    expect(parentOf('C:\\Users')).toBe('C:\\');
    expect(crumbsFor('/Users/me/AEON/Vault/Agents/x', '/Users/me/AEON/Vault'))
      .toEqual([{ label: 'Agents', path: '/Users/me/AEON/Vault/Agents' }, { label: 'x', path: '/Users/me/AEON/Vault/Agents/x' }]);
    expect(crumbsFor('/Users/me', '/Users/me/AEON/Vault'))
      .toEqual([{ label: 'Users', path: '/Users' }, { label: 'me', path: '/Users/me' }]);
    expect(crumbsFor('C:\\Users\\me', 'C:\\Users\\me\\AEON\\Vault'))
      .toEqual([{ label: 'C:', path: 'C:\\' }, { label: 'Users', path: 'C:\\Users' }, { label: 'me', path: 'C:\\Users\\me' }]);
  });
});
