/**
 * BO-A2a/A2b — the widget contract has a consumer, and the consumer scopes.
 *
 * These tests import the real kernel module. They do not re-implement the
 * catalogue inline — a test that re-implements its subject stays green while
 * the feature is broken, which is how the suite missed a whole class of
 * regression before (see tests/README on the serve regression).
 *
 * DoD #4 lives here: "a test that asserts a widget is refused something
 * undeclared."
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The real kernel module. Not a re-implementation.
const {
  buildWidgetCatalogue,
  deriveScope,
  describeScope,
} = require('../src/kernel/widgets.cjs');

const APP_ROOT = path.join(__dirname, '..');
const BLOCKS_DIR = path.join(APP_ROOT, 'src', 'blocks');

const block = (id, extra = {}) => ({ id, label: id, widget: null, ...extra });

describe('widget catalogue — rendering', () => {
  it('a block declaring no widget contributes nothing (absence renders as absence)', () => {
    const { widgets, refused } = buildWidgetCatalogue([
      block('activity'),
      block('writer', { widget: undefined }),
    ]);
    // Not a refusal — nothing was claimed. And critically: no placeholder
    // entry, which would let settings render an empty card.
    expect(widgets).toEqual([]);
    expect(refused).toEqual([]);
  });

  it('a declared widget appears with its endpoint, label and refresh', () => {
    const { widgets } = buildWidgetCatalogue([
      block('master', {
        widget: { endpoint: '/api/master/widget', label: 'Master', refresh_ms: 30000 },
      }),
    ]);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({
      id: 'master',
      label: 'Master',
      endpoint: '/api/master/widget',
      refresh_ms: 30000,
    });
  });

  it('refresh_ms is clamped — a manifest cannot ask settings to hammer a route', () => {
    const { widgets } = buildWidgetCatalogue([
      block('a', { widget: { endpoint: '/api/a/w', refresh_ms: 10 } }),
      block('b', { widget: { endpoint: '/api/b/w' } }),
    ]);
    expect(widgets.find(w => w.id === 'a').refresh_ms).toBe(5000);
    // Absent refresh means "do not poll", not "poll at some default".
    expect(widgets.find(w => w.id === 'b').refresh_ms).toBe(0);
  });

  it('an unready block still lists its widget, flagged rather than hidden', () => {
    const { widgets } = buildWidgetCatalogue([
      block('x', { widget: { endpoint: '/api/x/w' }, readiness: { ready: false } }),
    ]);
    expect(widgets[0].ready).toBe(false);
  });
});

describe('widget catalogue — refusal (DoD #4: refused something undeclared)', () => {
  it('refuses a widget pointing at ANOTHER block’s namespace', () => {
    const { widgets, refused } = buildWidgetCatalogue([
      block('writer', { widget: { endpoint: '/api/security/vault' } }),
    ]);
    expect(widgets).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0].id).toBe('writer');
    expect(refused[0].reason).toMatch(/must start with \/api\/writer\//);
  });

  it('refuses a namespace-prefix lookalike', () => {
    // /api/masterfoo/ must not pass as /api/master — the trailing slash is
    // load-bearing.
    const { widgets, refused } = buildWidgetCatalogue([
      block('master', { widget: { endpoint: '/api/masterfoo/widget' } }),
    ]);
    expect(widgets).toEqual([]);
    expect(refused[0].reason).toMatch(/must start with/);
  });

  it('refuses path traversal out of the namespace', () => {
    const { widgets, refused } = buildWidgetCatalogue([
      block('writer', { widget: { endpoint: '/api/writer/../security/vault' } }),
    ]);
    expect(widgets).toEqual([]);
    expect(refused[0].reason).toMatch(/\.\./);
  });

  it('refuses a malformed declaration instead of dropping it silently (R-05)', () => {
    const { refused } = buildWidgetCatalogue([
      block('a', { widget: {} }),
      block('b', { widget: 'nope' }),
      block('c', { widget: ['nope'] }),
    ]);
    expect(refused.map(r => r.id)).toEqual(['a', 'b', 'c']);
    // Every refusal carries a reason the UI can render.
    for (const r of refused) expect(typeof r.reason).toBe('string');
  });
});

describe('widget scope is derived from the manifest, not assumed', () => {
  it('a manifest granting nothing reports no host access', () => {
    const scope = deriveScope({
      contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false } },
    });
    expect(describeScope(scope)).toBe('no host access');
  });

  it('granted permissions are named, so least privilege is readable', () => {
    const scope = deriveScope({
      contract: {
        permissions: { filesystem: 'workspace', network: 'internal', secrets: true, shell: false, ai: true },
        storage: { scope: 'block' },
      },
    });
    const label = describeScope(scope);
    expect(label).toMatch(/filesystem: workspace/);
    expect(label).toMatch(/network: internal/);
    expect(label).toMatch(/secrets/);
    expect(label).toMatch(/AI/);
    expect(label).toMatch(/storage: block/);
    // Not granted, so it must not be claimed.
    expect(label).not.toMatch(/shell/);
  });

  it('a missing permissions block defaults closed, never open', () => {
    const scope = deriveScope({});
    expect(scope).toMatchObject({
      filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false,
    });
  });
});

describe('the shipped manifests satisfy the contract', () => {
  const folders = fs.readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => d.name);

  const registry = folders.map(id => {
    const p = path.join(BLOCKS_DIR, id, 'block.manifest.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    return { id, label: m.label || id, widget: m.widget ?? null, contract: m.contract };
  });

  it('no shipped manifest declares a widget the kernel would refuse', () => {
    const { refused } = buildWidgetCatalogue(registry);
    expect(refused).toEqual([]);
  });

  it('master is a working reference implementation, and its route exists', () => {
    const { widgets } = buildWidgetCatalogue(registry);
    const master = widgets.find(w => w.id === 'master');
    expect(master, 'master must declare a widget — it is the reference').toBeTruthy();

    // The declared endpoint must be a route the block actually serves.
    // A declaration nobody can fetch is the same lie in a smaller box.
    const api = fs.readFileSync(path.join(BLOCKS_DIR, 'master', 'api', 'master.cjs'), 'utf8');
    const routePath = master.endpoint.replace(/^\/api/, '');
    expect(api).toContain(`'${routePath}'`);
  });
});
