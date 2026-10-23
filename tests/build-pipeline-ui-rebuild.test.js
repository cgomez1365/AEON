/**
 * The build pipeline's interface-rebuild hook.
 *
 * A promoted block's screen only enters the bundle at build time, so where an
 * install or an update goes live (the LOW auto-promote in submitBuild, and
 * approveBuild) the pipeline awaits an injected rebuildUI hook and returns its
 * answer as `uiRebuilt`. What must hold:
 *   - the hook is awaited and its answer comes back, on both paths;
 *   - a hook that rejects (or throws) never turns a live install into an error;
 *   - a Tier 3 approval closes IDE mode BEFORE the (minutes-long) rebuild;
 *   - submitBuild({ deferUiRebuild }) skips the hook and says { pending: true },
 *     and pipeline.rebuildUI() runs it later.
 *
 * The pipeline's collaborators (staging, approvals, IDE mode, run state, the
 * boot proof) are stubbed through the require cache, so no staging/ or
 * src/blocks/ folder of the checkout is touched and the call order is recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const KERNEL = path.join(path.dirname(require.resolve('../src/kernel/buildPipeline.cjs')));
const resolve = (name) => path.join(KERNEL, `${name}.cjs`);
const STUBBED = ['staging', 'approvals', 'ideMode', 'runState', 'bootProof', 'complexityGate', 'buildEnvelope'];
const PIPELINE = resolve('buildPipeline');

let tmp, events, saved, pending, tier3Active;

function install(name, exports) {
  const file = resolve(name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}

/** A fresh buildPipeline over stubbed collaborators; `events` records the order of things. */
function load({ score = 'LOW' } = {}) {
  events = [];
  install('buildEnvelope', { normalize: (source, payload) => ({ source, manifest: payload.manifest, files: payload.files || [], trust: 'test', spec: '' }) });
  install('complexityGate', { gate: () => ({ score, behavior: 'single-click', reasons: [] }) });
  install('bootProof', { bootProof: async () => ({ ok: true }) });
  install('runState', { registerManual: () => events.push('registerManual'), isRunning: () => false });
  install('ideMode', {
    isActive: () => tier3Active,
    setActive: (on) => { tier3Active = on; events.push(`ide:${on ? 'on' : 'off'}`); },
    audit: () => events.push('ide:audit'),
  });
  install('approvals', {
    ensureAdmin: () => ({ provisioned: false }),
    list: () => [],
    enqueue: (i) => ({ id: 'APR-1', ...i }),
    getItem: (id) => (id === 'APR-1' ? pending : null),
    decide: (id, status) => { pending = { ...pending, status }; return { ok: true, item: pending }; },
  });
  install('staging', {
    STAGING_DIR: path.join(tmp, 'staging'), BLOCKS_DIR: path.join(tmp, 'blocks'),
    ensureStagingDir: () => fs.mkdirSync(path.join(tmp, 'staging'), { recursive: true }),
    lintBlock: () => ({ errors: [] }),
    promoteBlock: (id) => { events.push(`promote:${id}`); return { ok: true }; },
    validateManifest: () => [], scanSources: () => [], detectCircularImports: () => [], isCodeFile: () => true,
  });
  delete require.cache[PIPELINE];
  return require(PIPELINE);
}

const manifest = { id: 'zz_ui_probe', version: '1.0.0' };
const payload = { manifest, files: [{ path: 'index.jsx', content: 'export default () => null;\n' }] };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pipeline-ui-'));
  tier3Active = false;
  pending = { id: 'APR-1', blockId: 'zz_ui_probe', status: 'pending', permissions: {} };
  saved = Object.fromEntries(STUBBED.concat('buildPipeline').map((n) => [n, require.cache[resolve(n)]]));
});
afterEach(() => {
  // Put the real modules back for whatever test file runs next in this worker.
  for (const [n, entry] of Object.entries(saved)) {
    if (entry) require.cache[resolve(n)] = entry; else delete require.cache[resolve(n)];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('LOW auto-promote (submitBuild)', () => {
  it('awaits the hook after the rescan and returns its answer as uiRebuilt', async () => {
    const { createBuildPipeline } = load();
    const p = createBuildPipeline({
      rescan: () => { events.push('rescan'); return { ok: true }; },
      rebuildUI: async (id) => { events.push(`hook:start:${id}`); await wait(30); events.push('hook:done'); return { ok: true, ms: 30 }; },
    });
    const r = await p.submitBuild('store', payload);
    expect(r).toMatchObject({ ok: true, stage: 'live', blockId: 'zz_ui_probe', uiRebuilt: { ok: true, ms: 30 } });
    expect(events).toEqual(['promote:zz_ui_probe', 'registerManual', 'rescan', 'hook:start:zz_ui_probe', 'hook:done']);
  });

  it('a hook that rejects does not break the result — the block is live, the rebuild reports failed', async () => {
    const { createBuildPipeline } = load();
    const p = createBuildPipeline({ rebuildUI: async () => { throw new Error('vite exploded'); } });
    const r = await p.submitBuild('store', payload);
    expect(r).toMatchObject({ ok: true, stage: 'live', uiRebuilt: { ok: false, error: 'vite exploded' } });
  });

  it('a hook that throws synchronously is caught the same way', async () => {
    const { createBuildPipeline } = load();
    const p = createBuildPipeline({ rebuildUI: () => { throw new Error('sync boom'); } });
    expect((await p.submitBuild('store', payload)).uiRebuilt).toEqual({ ok: false, error: 'sync boom' });
  });

  it('with no hook wired it answers skipped, not undefined', async () => {
    const { createBuildPipeline } = load();
    const r = await createBuildPipeline({}).submitBuild('store', payload);
    expect(r.uiRebuilt).toEqual({ ok: false, skipped: true, reason: 'no rebuildUI hook' });
  });

  it('deferUiRebuild skips the hook and says pending; pipeline.rebuildUI runs it later', async () => {
    const { createBuildPipeline } = load();
    const asked = [];
    const p = createBuildPipeline({ rebuildUI: async (id) => { asked.push(id); return { ok: true, ms: 1 }; } });
    const r = await p.submitBuild('store', payload, { deferUiRebuild: true });
    expect(r).toMatchObject({ ok: true, stage: 'live', uiRebuilt: { pending: true } });
    expect(asked).toEqual([]);
    expect(await p.rebuildUI('zz_ui_probe')).toEqual({ ok: true, ms: 1 });
    expect(asked).toEqual(['zz_ui_probe']);
  });

  it('a block that needs approval is queued and never rebuilds anything', async () => {
    const { createBuildPipeline } = load({ score: 'MEDIUM' });
    const asked = [];
    const p = createBuildPipeline({ rebuildUI: async (id) => { asked.push(id); return { ok: true }; } });
    const r = await p.submitBuild('store', payload);
    expect(r).toMatchObject({ ok: true, stage: 'queued' });
    expect(r.uiRebuilt).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('approveBuild', () => {
  it('awaits the hook after the rescan and returns uiRebuilt', async () => {
    const { createBuildPipeline } = load({ score: 'MEDIUM' });
    const p = createBuildPipeline({
      rescan: () => { events.push('rescan'); return { ok: true }; },
      rebuildUI: async (id) => { events.push(`hook:${id}`); await wait(20); events.push('hook:done'); return { ok: true, ms: 20 }; },
    });
    const r = await p.approveBuild('APR-1', { approver: 'cris' });
    expect(r).toMatchObject({ ok: true, stage: 'live', blockId: 'zz_ui_probe', uiRebuilt: { ok: true, ms: 20 }, ideModeAutoDisabled: false });
    expect(events).toEqual(['promote:zz_ui_probe', 'registerManual', 'rescan', 'hook:zz_ui_probe', 'hook:done']);
  });

  it('a Tier 3 approval turns IDE mode off BEFORE the rebuild starts', async () => {
    const { createBuildPipeline } = load({ score: 'HIGH' });
    pending = { ...pending, permissions: { shell: true } };
    tier3Active = true;
    const p = createBuildPipeline({
      rescan: () => { events.push('rescan'); return { ok: true }; },
      rebuildUI: async () => { events.push(`hook:start:ide=${tier3Active ? 'on' : 'off'}`); await wait(20); events.push('hook:done'); return { ok: true, ms: 20 }; },
    });
    const r = await p.approveBuild('APR-1', { approver: 'cris' });
    expect(r).toMatchObject({ ok: true, ideModeAutoDisabled: true, uiRebuilt: { ok: true } });
    expect(events.indexOf('ide:off')).toBeGreaterThan(-1);
    expect(events.indexOf('ide:off')).toBeLessThan(events.indexOf('hook:start:ide=off'));
    expect(events).not.toContain('hook:start:ide=on');
    expect(r.note).toMatch(/IDE mode auto-disabled/);
  });

  it('a Tier 3 approval still disarms IDE mode when the rebuild fails', async () => {
    const { createBuildPipeline } = load({ score: 'HIGH' });
    pending = { ...pending, permissions: { shell: true } };
    tier3Active = true;
    const p = createBuildPipeline({ rebuildUI: async () => { throw new Error('build died'); } });
    const r = await p.approveBuild('APR-1', { approver: 'cris' });
    expect(tier3Active).toBe(false);
    expect(r).toMatchObject({ ok: true, ideModeAutoDisabled: true, uiRebuilt: { ok: false, error: 'build died' } });
  });

  it('a Tier 3 approval without IDE mode is refused before anything runs', async () => {
    const { createBuildPipeline } = load({ score: 'HIGH' });
    pending = { ...pending, permissions: { shell: true } };
    tier3Active = false;
    const asked = [];
    const p = createBuildPipeline({ rebuildUI: async (id) => { asked.push(id); return { ok: true }; } });
    expect(await p.approveBuild('APR-1')).toMatchObject({ ok: false, tier3: true });
    expect(asked).toEqual([]);
  });

  it('an unknown approval is a plain failure, no rebuild', async () => {
    const { createBuildPipeline } = load();
    const asked = [];
    const p = createBuildPipeline({ rebuildUI: async (id) => { asked.push(id); return { ok: true }; } });
    expect(await p.approveBuild('APR-nope')).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });
});

describe('pipeline.rebuildUI', () => {
  it('is exported, and never rejects', async () => {
    const { createBuildPipeline } = load();
    const p = createBuildPipeline({ rebuildUI: async () => { throw new Error('nope'); } });
    expect(typeof p.rebuildUI).toBe('function');
    expect(await p.rebuildUI('x')).toEqual({ ok: false, error: 'nope' });
    expect(Object.keys(p).sort()).toEqual(['approveBuild', 'rebuildUI', 'rejectBuild', 'submitBuild', 'validateBuild']);
  });

  it('a hook that answers nothing becomes a skipped answer', async () => {
    const { createBuildPipeline } = load();
    const p = createBuildPipeline({ rebuildUI: async () => undefined });
    expect(await p.rebuildUI('x')).toMatchObject({ ok: false, skipped: true });
  });
});
