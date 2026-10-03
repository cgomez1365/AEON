/**
 * A drive built by scripts/build-usb.js carries other people's software and
 * says so (GitHub audit #24, 2026-10-03).
 *
 * The public ZIP has no node_modules and no runtime. A drive has both: the
 * whole node_modules (ffmpeg-static's FFmpeg binary, GPL-3.0-or-later), a
 * portable Node.js, the llama.cpp runtime once Cookbook installs it, and with
 * --model a Llama or Gemma file. The builder wrote no notice for any of it and
 * no license beside the weights. These tests pin THIRD_PARTY_NOTICES.txt at the
 * drive root and <weights>.LICENSE.txt beside a seeded model, for both the
 * blank bundle and --carry-home. No network, no real build.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-notices-home-'));
process.env.AEON_HOME = path.join(iso, 'home');
process.env.AEON_SECRETS_DIR = path.join(iso, 'home', 'secrets');
process.env.AEON_ENV_FILE = path.join(iso, 'home', '.env');
afterAll(() => { try { fs.rmSync(iso, { recursive: true, force: true }); } catch {} });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildUsb = require('../scripts/build-usb.js');
const carry = require('../scripts/build-usb-carry.cjs');
const catalog = require('../services/local-runtime/model-catalog.json').models;
const runtimeAssets = require('../services/local-runtime/runtime-assets.json');
const byId = (id) => catalog.find((m) => m.id === id);

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-notices-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/** An app folder as a drive holds it: ffmpeg-static installed, the pinned runtime manifest. */
function fakeApp(dir, { ffmpeg = true } = {}) {
  if (ffmpeg) {
    write(path.join(dir, 'node_modules/ffmpeg-static/package.json'), JSON.stringify({
      name: 'ffmpeg-static', version: '5.3.0', license: 'GPL-3.0-or-later',
      'ffmpeg-static': { 'binary-release-tag': 'b6.1.1' },
    }));
    write(path.join(dir, 'node_modules/ffmpeg-static/ffmpeg'), 'binary');
  }
  write(path.join(dir, 'services/local-runtime/runtime-assets.json'), JSON.stringify(runtimeAssets));
  return dir;
}

describe('THIRD_PARTY_NOTICES.txt', () => {
  it('names FFmpeg with its license and where its source is, Node.js and llama.cpp', () => {
    const app = fakeApp(path.join(tmp, 'AEON'));
    const [file] = buildUsb.writeNotices(tmp, { appDir: app, nodeVersions: ['v22.14.0'], nodeLicenseInArchives: true });
    expect(file).toBe(path.join(tmp, buildUsb.NOTICES_FILE));
    const txt = fs.readFileSync(file, 'utf8');
    expect(txt).toContain('ffmpeg-static 5.3.0 (license: GPL-3.0-or-later)');
    expect(txt).toContain(buildUsb.FFMPEG_SOURCE_URL);
    expect(txt).toContain('https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1');
    expect(txt).toContain('Node.js v22.14.0');
    expect(txt).toContain('https://github.com/nodejs/node/blob/v22.14.0/LICENSE');
    expect(txt).toContain('Each archive in runtime/node/ also contains that LICENSE file.');
    expect(txt).toContain(`release ${runtimeAssets.releaseTag}`);
    expect(txt).toContain(runtimeAssets.licenseUrl);
    expect(txt).toContain('No catalogue model weights are on this drive.');
    expect(txt).not.toContain('null');
  });

  it('says so when there is no ffmpeg-static and no portable Node, instead of claiming them', () => {
    const app = fakeApp(path.join(tmp, 'AEON'), { ffmpeg: false });
    const txt = buildUsb.thirdPartyNotices({ appDir: app, nodeVersions: [] });
    expect(txt).toContain('No ffmpeg-static package is in AEON/node_modules on this drive.');
    expect(txt).toContain('No portable Node.js was staged on this drive.');
    expect(txt).not.toContain('GPL');
  });
});

describe('a seeded model gets its license beside it', () => {
  it('Llama: the licensor\'s license and use policy, the same terms Cookbook shows', () => {
    const app = fakeApp(path.join(tmp, 'AEON'));
    const entry = byId('llama3-8b-q4');
    const modelsDir = path.join(tmp, 'models');
    write(path.join(modelsDir, entry.filename), 'weights');
    const written = buildUsb.writeNotices(tmp, { appDir: app, models: [entry], modelsDir });
    const lf = path.join(modelsDir, `${entry.filename}.LICENSE.txt`);
    expect(written).toContain(lf);
    const lic = fs.readFileSync(lf, 'utf8');
    expect(lic).toContain('Llama 3.1 Community License');
    expect(lic).toContain('https://llama.meta.com/llama3_1/use-policy');
    expect(lic).toContain('not under the AEON Community License');
    const notices = fs.readFileSync(path.join(tmp, buildUsb.NOTICES_FILE), 'utf8');
    expect(notices).toContain(`${entry.filename}: Llama 3.1 Community License`);
  });

  it('every catalogue model produces a pointer with a license name and a link', () => {
    for (const m of catalog) {
      const txt = buildUsb.modelLicenseText(m);
      expect(txt, m.id).toMatch(/License:\s+\S/);
      expect(txt, m.id).toMatch(/License text: https:\/\//);
    }
  });

  it('writes no license file for weights that are not there (a failed download)', () => {
    const app = fakeApp(path.join(tmp, 'AEON'));
    const modelsDir = path.join(tmp, 'models');
    fs.mkdirSync(modelsDir);
    const written = buildUsb.writeNotices(tmp, { appDir: app, models: [byId('gemma2-2b-q4')], modelsDir });
    expect(written).toEqual([path.join(tmp, buildUsb.NOTICES_FILE)]);
  });
});

describe('--carry-home', () => {
  it('names the models and llama.cpp runtime the carried home holds, without writing into AEON-Data', () => {
    const plan = { app: fakeApp(path.join(tmp, 'AEON')), data: path.join(tmp, 'AEON-Data') };
    const entry = byId('qwen3-1.7b-q8');
    const dataRoot = carry.driveRoots(plan.app, plan.data).data;
    write(path.join(dataRoot, entry.relPathTemplate), 'weights');
    write(path.join(dataRoot, 'local-runtime/runtime/b10216-cpu/llama-server'), 'bin');
    const input = carry.carriedNoticesInput(plan, { runtimes: { macLegacy: 'x' }, version: 'v24.9.0' });
    expect(input.models.map((m) => m.id)).toEqual([entry.id]);
    expect(input.llamaOnDrive).toBe(true);
    expect(input.nodeVersions).toEqual(['v24.9.0', carry.LEGACY_MAC_NODE]);
    const before = fs.readdirSync(path.dirname(path.join(dataRoot, entry.relPathTemplate)));
    buildUsb.writeNotices(tmp, input);
    expect(fs.readdirSync(path.dirname(path.join(dataRoot, entry.relPathTemplate)))).toEqual(before);
    const txt = fs.readFileSync(path.join(tmp, buildUsb.NOTICES_FILE), 'utf8');
    expect(txt).toContain(`${entry.filename}: Apache-2.0`);
    expect(txt).toContain('A llama.cpp runtime installed by Cookbook is on this drive');
  });

  it('both builders write the file (wiring)', () => {
    // main() and buildCarried() need a real build and network to run whole;
    // these pin that each one calls the writer.
    const main = fs.readFileSync(path.join(ROOT, 'scripts/build-usb.js'), 'utf8');
    expect(main).toMatch(/writeNotices\(TARGET, \{[\s\S]*?models: seededModel \? \[seededModel\] : \[\]/);
    const carried = fs.readFileSync(path.join(ROOT, 'scripts/build-usb-carry.cjs'), 'utf8');
    expect(carried).toContain('buildUsb.writeNotices(target, carriedNoticesInput(plan,');
  });
});
