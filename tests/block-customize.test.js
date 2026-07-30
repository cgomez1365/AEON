/**
 * Block icon customization — regression tests.
 *
 * These import the REAL modules and drive the REAL router. The previous version
 * of this file re-implemented the persistence layer inline and asserted against
 * its own copy, so it passed green while the shipped code was broken:
 * getNavGroups() dropped `id`, every sidebar row read customizations[undefined],
 * and the PATCH route stored a literal "undefined" key. Test the real thing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  BLOCKS_DIR, ICON_BASE, ICON_DIR,
  listBlockFolders, readManifest, normalizeManifest,
} = require('../src/kernel/blockStandard.cjs');
const customizeRouter = require('../server/routes/customize.cjs');

// Blocks these tests mutate. Their manifests are restored in afterAll so the
// suite never leaves the working tree dirty.
const TOUCHED = ['council', 'writer'];
const BACKUP = {};
const manifestPath = f => path.join(BLOCKS_DIR, f, 'block.manifest.json');

let server;
const base = () => `http://127.0.0.1:${server.address().port}`;

beforeAll(async () => {
  for (const f of TOUCHED) BACKUP[f] = fs.readFileSync(manifestPath(f), 'utf8');
  const app = express();
  app.use(express.json());
  app.use(customizeRouter());
  server = await new Promise(resolve => {
    const i = app.listen(0, '127.0.0.1', () => resolve(i));
  });
});

afterAll(() => {
  if (server) server.close();
  for (const [f, raw] of Object.entries(BACKUP)) fs.writeFileSync(manifestPath(f), raw);
});

const get = async url => {
  const response = await fetch(`${base()}${url}`);
  return { response, body: await response.json() };
};
const send = async (method, url, body) => {
  const response = await fetch(`${base()}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { response, body: await response.json() };
};

const libraryFiles = () =>
  fs.readdirSync(ICON_DIR).filter(f => f.endsWith('.svg') && !f.startsWith('_'));

/** An icon that exists in the library but is not `exclude`'s own default. */
const borrowedIcon = exclude => `${ICON_BASE}/${libraryFiles().find(f => f !== `${exclude}.svg`)}`;

describe('GET /api/blocks/icons', () => {
  it('returns the folder-scanned library, not a hardcoded list', async () => {
    const { response, body } = await get('/api/blocks/icons');
    expect(response.status).toBe(200);
    expect(body.icons).toHaveLength(libraryFiles().length);
    expect(body.icons.every(i => i.path.startsWith(ICON_BASE))).toBe(true);
  });
});

describe('GET /api/blocks/nav', () => {
  it('reports an icon and editability for every installed block', async () => {
    const { response, body } = await get('/api/blocks/nav');
    expect(response.status).toBe(200);
    for (const folder of listBlockFolders()) {
      if (!readManifest(folder)) continue;
      expect(typeof body.blocks[folder]?.iconAsset).toBe('string');
      expect(typeof body.blocks[folder]?.iconEditable).toBe('boolean');
    }
  });
});

describe('PATCH /api/blocks/:blockId/customize', () => {
  it('404s on an unknown blockId — never stores it', async () => {
    const { response } = await send('PATCH', '/api/blocks/undefined/customize', {
      iconAsset: borrowedIcon('council'),
    });
    expect(response.status).toBe(404);
  });

  it('422s on a label — the display name is folder-derived', async () => {
    const { response, body } = await send('PATCH', '/api/blocks/council/customize', {
      label: 'Board', iconAsset: borrowedIcon('council'),
    });
    expect(response.status).toBe(422);
    expect(body.error).toMatch(/label is not editable/i);
  });

  it('422s on an icon outside the library', async () => {
    const { response } = await send('PATCH', '/api/blocks/council/customize', {
      iconAsset: `${ICON_BASE}/not-a-real-icon.svg`,
    });
    expect(response.status).toBe(422);
  });

  it('422s when iconAsset is missing', async () => {
    const { response } = await send('PATCH', '/api/blocks/council/customize', {});
    expect(response.status).toBe(422);
  });

  it('writes the pick into the manifest and touches ONLY that block', async () => {
    const icon = borrowedIcon('council');
    const otherBefore = readManifest('writer').nav.iconAsset;

    const { response } = await send('PATCH', '/api/blocks/council/customize', { iconAsset: icon });
    expect(response.status).toBe(200);
    expect(readManifest('council').nav.iconAsset).toBe(icon);
    // The bug this guards: one edit bleeding onto every other block.
    expect(readManifest('writer').nav.iconAsset).toBe(otherBefore);
  });

  it('survives boot sync — normalizeManifest preserves the pick', async () => {
    const icon = borrowedIcon('council');
    await send('PATCH', '/api/blocks/council/customize', { iconAsset: icon });
    expect(normalizeManifest('council').nav.iconAsset).toBe(icon);
  });

  it('degrades to the folder default when the picked file no longer exists', () => {
    const m = readManifest('council');
    m.nav.iconAsset = `${ICON_BASE}/deleted-icon-xyz.svg`;
    fs.writeFileSync(manifestPath('council'), JSON.stringify(m, null, 2));
    expect(normalizeManifest('council').nav.iconAsset).toBe(`${ICON_BASE}/council.svg`);
  });
});

describe('DELETE /api/blocks/:blockId/customize', () => {
  it('reverts to the folder default', async () => {
    await send('PATCH', '/api/blocks/writer/customize', { iconAsset: borrowedIcon('writer') });
    const { response } = await send('DELETE', '/api/blocks/writer/customize');
    expect(response.status).toBe(200);
    expect(readManifest('writer').nav.iconAsset).toBe(`${ICON_BASE}/writer.svg`);
  });

  it('404s on an unknown block', async () => {
    const { response } = await send('DELETE', '/api/blocks/nope_not_a_block/customize');
    expect(response.status).toBe(404);
  });
});

describe('block-declared customizability', () => {
  const optOut = folder => {
    const m = readManifest(folder);
    m.contract = { ...(m.contract || {}), customizable: { icon: false } };
    fs.writeFileSync(manifestPath(folder), JSON.stringify(m, null, 2));
  };

  it('403s when the cartridge opts out via contract.customizable.icon', async () => {
    optOut('writer');
    const { response } = await send('PATCH', '/api/blocks/writer/customize', {
      iconAsset: borrowedIcon('writer'),
    });
    expect(response.status).toBe(403);
  });

  it('normalizeManifest round-trips the opt-out instead of erasing it', () => {
    optOut('writer');
    expect(normalizeManifest('writer').contract.customizable.icon).toBe(false);
  });
});
