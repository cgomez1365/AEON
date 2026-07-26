import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const client = require('../tools/terminal/client.cjs');
const router = require('../tools/terminal/router.cjs');
const render = require('../tools/terminal/renderers.cjs');

// BO-TGM — God Mode terminal. The CLI is a client of the kernel's existing
// command bus (src/kernel/commandRegistry.cjs); it owns routing and rendering
// only. Dispatch, confirmation gates and permissions stay server-side, which
// is what stops the terminal becoming a way around them.

const REGISTRY = [
  { id: 'cookbook.gpu', cmd: '/gpu', blockId: 'cookbook', blockLabel: 'Cookbook', title: 'Probe GPU hardware status', desc: '', available: true },
  { id: 'cookbook.models', cmd: '/models', blockId: 'cookbook', blockLabel: 'Cookbook', title: 'List cached local models', desc: '', available: true },
  { id: 'cookbook.model-pull', cmd: '/model-pull', blockId: 'cookbook', blockLabel: 'Cookbook', title: 'Download a local model', desc: '', dangerous: true, available: true },
  { id: 'aeon_matrix.index-brain', cmd: '/index-brain', blockId: 'aeon_matrix', blockLabel: 'Aeon Matrix', title: 'Rebuild the Second Brain index', desc: '', available: true },
  { id: 'deep_research.scrape', cmd: '/scrape', blockId: 'deep_research', blockLabel: 'Deep Research', title: 'Scrape a URL via Orion', desc: '', available: true },
  { id: 'security.lock', cmd: '/lock', blockId: 'security', blockLabel: 'Security', title: 'Lock the vault', desc: '', dangerous: true, available: true },
  { id: 'writer.write', cmd: '/write', blockId: 'writer', blockLabel: 'Writer', title: 'Create a draft', desc: '', available: true },
];

describe('command token normalisation (BO-TGM)', () => {
  // MSYS/Git Bash — the default shell on many Windows dev machines — rewrites
  // a bare leading-slash argument into a Windows path. Without this, every
  // slash-prefixed command silently fails with "unknown command".
  it('recovers a command mangled into a Windows path by Git Bash', () => {
    expect(client.normalizeCommand('C:/Program Files/Git/gpu')).toBe('gpu');
    expect(client.normalizeCommand('C:\\Program Files\\Git\\model-pull')).toBe('model-pull');
  });

  it('leaves ordinary spellings alone', () => {
    expect(client.normalizeCommand('gpu')).toBe('gpu');
    expect(client.normalizeCommand('/gpu')).toBe('/gpu');
    expect(client.normalizeCommand('cookbook.gpu')).toBe('cookbook.gpu');
  });

  it('handles empty and undefined input without throwing', () => {
    expect(client.normalizeCommand('')).toBe('');
    expect(client.normalizeCommand(undefined)).toBe('');
  });
});

describe('fast routing (BO-TGM)', () => {
  // The fast tier is deterministic and free. Spending a model call to discover
  // that "/gpu" means /gpu is waste — and on a portable install it is latency
  // against an 8B model streaming off a USB stick.
  it('resolves an exact command with full confidence and no model', () => {
    const r = router.fastMatch('/gpu', REGISTRY);
    expect(r.id).toBe('cookbook.gpu');
    expect(r.confidence).toBe(1);
    expect(r.via).toBe('exact');
  });

  it('resolves a bare command without the slash', () => {
    expect(router.fastMatch('gpu', REGISTRY).id).toBe('cookbook.gpu');
  });

  it('resolves a namespaced id', () => {
    const r = router.fastMatch('cookbook.models', REGISTRY);
    expect(r.id).toBe('cookbook.models');
    expect(r.via).toBe('id');
  });

  it('carries the remainder of the line through as the argument', () => {
    expect(router.fastMatch('/model-pull qwen3:8b', REGISTRY).arg).toBe('qwen3:8b');
    expect(router.fastMatch('/gpu', REGISTRY).arg).toBe('');
  });

  it('routes plain intent to the owning block', () => {
    const r = router.fastMatch('check gpu status', REGISTRY);
    expect(r.blockId).toBe('cookbook');
    expect(r.via).toBe('intent');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns null on input with no signal, rather than guessing', () => {
    expect(router.fastMatch('xyzzy plugh', REGISTRY)).toBeNull();
    expect(router.fastMatch('', REGISTRY)).toBeNull();
  });
});

describe('argument extraction (BO-TGM)', () => {
  // "research USB trends" should search for "USB trends", not for the verb.
  // Only a leading imperative is stripped — never words from the middle.
  it('strips a leading imperative', () => {
    expect(router.stripIntentWords('search for competitor pricing')).toBe('competitor pricing');
    expect(router.stripIntentWords('show me the models')).toBe('the models');
    expect(router.stripIntentWords('please can you find the notes')).toBe('the notes');
  });

  it('does not strip the same words mid-sentence', () => {
    expect(router.stripIntentWords('notes about how to run a search')).toBe('notes about how to run a search');
  });
});

describe('model-route JSON extraction (BO-TGM)', () => {
  // Models wrap JSON in prose or fences no matter how firmly you ask them not
  // to, and a portable install runs a small local model that does it more.
  it('parses a bare object', () => {
    expect(router.extractJson('{"id":"cookbook.gpu","confidence":0.9}').id).toBe('cookbook.gpu');
  });

  it('parses a fenced object', () => {
    expect(router.extractJson('```json\n{"id":"cookbook.gpu"}\n```').id).toBe('cookbook.gpu');
  });

  it('parses an object buried in prose', () => {
    expect(router.extractJson('Sure! Here you go:\n{"id":"writer.write"}\nHope that helps.').id).toBe('writer.write');
  });

  it('handles nested braces without truncating', () => {
    const r = router.extractJson('{"id":"x","params":{"a":{"b":1}},"confidence":1}');
    expect(r.params.a.b).toBe(1);
  });

  it('returns null on unparseable output instead of throwing', () => {
    expect(router.extractJson('no json here')).toBeNull();
    expect(router.extractJson('')).toBeNull();
    expect(router.extractJson('{broken')).toBeNull();
  });
});

describe('suggestions (BO-TGM)', () => {
  it('offers near matches so a miss has a next step', () => {
    const s = router.suggest('model', REGISTRY);
    expect(s.length).toBeGreaterThan(0);
    expect(s.map((x) => x.blockId)).toContain('cookbook');
  });

  it('returns nothing when there is genuinely no overlap', () => {
    expect(router.suggest('zzzzz', REGISTRY)).toEqual([]);
  });
});

describe('renderers (BO-TGM)', () => {
  // A rendering crash would destroy a result the kernel already computed, so
  // every renderer must be total.
  const clean = (s) => render.strip(String(s));

  it('renders a grade card with score bars', () => {
    const out = clean(render.gradeCard({
      data: { grade: 'B+', score: 82, breakdown: { skills_match: 88, experience_fit: 79 }, recommendation: 'RECOMMEND' },
    }));
    expect(out).toContain('B+');
    expect(out).toContain('82');
    expect(out).toContain('Skills Match');
    expect(out).toContain('RECOMMEND');
  });

  it('renders numbered, selectable search results', () => {
    const out = clean(render.searchResults({ data: { results: [
      { title: 'Competitor_Pricing.md', date: '2026-07-19', snippet: 'pricing notes' },
      { title: 'Q3_Research.md', date: '2026-07-20' },
    ] } }));
    expect(out).toContain('[1]');
    expect(out).toContain('[2]');
    expect(out).toContain('Competitor_Pricing.md');
    expect(out).toContain('2 results');
  });

  it('reports an empty result set instead of rendering an empty frame', () => {
    expect(clean(render.searchResults({ data: { results: [] } }))).toContain('no results');
  });

  it('aligns table columns on visible width, not escape-code length', () => {
    const out = render.table([{ block: 'cookbook', ready: true }, { block: 'writer', ready: false }]);
    const lines = clean(out).split('\n').filter((l) => l.includes('│'));
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('auto-tables a payload named after the thing it returns', () => {
    // Blocks return {gpus:[…]}, {models:[…]} — the array IS the result.
    const out = clean(render.auto({ data: { gpus: [{ index: 0, name: 'GTX 1050', free_mb: 2981 }] } }));
    expect(out).toContain('GTX 1050');
    expect(out).toContain('INDEX');
  });

  it('renders a flat status blob as aligned pairs', () => {
    const out = clean(render.auto({ data: { ok: true, uptime: 42, version: '3.0.0' } }));
    expect(out).toContain('version');
    expect(out).toContain('3.0.0');
  });

  it('honours --json by returning parseable JSON', () => {
    const out = render.auto({ data: { anything: 1 } }, { json: true });
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).data.anything).toBe(1);
  });

  it('never throws on malformed or empty payloads', () => {
    for (const bad of [null, undefined, {}, { data: null }, { data: [] }, 'string', 42]) {
      expect(() => render.auto(bad)).not.toThrow();
    }
  });

  it('degrades to raw output if a renderer fails, rather than losing the result', () => {
    const hostile = { data: { grade: { toString() { throw new Error('boom'); } } } };
    const out = render.auto(hostile, { renderer: 'grade-card' });
    expect(clean(out)).toMatch(/renderer failed|grade/i);
  });

  it('wraps text without dropping words', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    expect(render.wrapText(words, 20).join(' ').split(/\s+/).sort()).toEqual(words.split(' ').sort());
  });
});

describe('a spinner never paints over an input prompt (BO-TGM)', () => {
  // A spinner repaints the current line every 80ms. When `aeon run <cmd>` hit
  // a locked vault, dispatchAndRender's spinner was still running while
  // withAuth() asked for a username — the question and the operator's
  // keystrokes were overwritten mid-type, so they were effectively entering a
  // password into a progress indicator. Found live by the CEO, 2026-07-26.
  it('exposes stopActiveSpinner so any reader can free the line', () => {
    expect(typeof render.stopActiveSpinner).toBe('function');
  });

  it('a running spinner is tracked, and stopActiveSpinner clears it', () => {
    const spin = render.spinner('working');
    let stopped = false;
    const original = spin.stop.bind(spin);
    spin.stop = (...a) => { stopped = true; return original(...a); };

    render.stopActiveSpinner();
    expect(stopped).toBe(true);

    // Nothing is active now, so a second call is a no-op rather than a throw.
    expect(() => render.stopActiveSpinner()).not.toThrow();
  });

  it('stopping twice is harmless', () => {
    const spin = render.spinner('x');
    expect(() => { spin.stop(); render.stopActiveSpinner(); spin.stop(); }).not.toThrow();
  });
});

describe('withAuth does not block on an interactive prompt without a TTY (BO-TGM)', () => {
  // `aeon commands --json` and `aeon blocks --json` used to hang indefinitely
  // when the guard was on and no session was stored: withAuth() unconditionally
  // tried an interactive login prompt on a 401, and a subprocess/script/CI
  // context has no TTY to answer it. Found by the settings/terminal stress
  // test (2026-07-26) spawning the real CLI binary -- it simply never
  // returned. Confirmed here with a hard race against a timeout: if the fix
  // regresses, this test hangs and fails on timeout rather than passing
  // silently.
  it('returns the 401 as-is instead of prompting when stdin is not a TTY', async () => {
    expect(process.stdin.isTTY).toBeFalsy(); // the test runner itself has no TTY -- exactly the failure condition
    const fakeUnauthorized = () => Promise.resolve({ ok: false, status: 401, data: { error: 'UNAUTHORIZED_SESSION' } });
    const result = await Promise.race([
      client.withAuth(fakeUnauthorized),
      new Promise((_, reject) => setTimeout(() => reject(new Error('withAuth hung waiting for a prompt with no TTY attached')), 2000)),
    ]);
    expect(result.status).toBe(401);
  });
});

describe('manifest scanning in standalone mode (BO-TGM)', () => {
  // With no server, the CLI reads manifests off disk so `status`, `commands`
  // and `blocks` still answer. Same shape as the server registry, so callers
  // and the router never branch on mode.
  it('discovers commands with the same shape the server returns', () => {
    const commands = client.scanManifests();
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('cmd');
      expect(c).toHaveProperty('blockId');
      expect(c).toHaveProperty('route');
      expect(c.id).toBe(`${c.blockId}.${c.cmd.replace(/^\//, '')}`);
    }
  });

  it('skips template and scaffold blocks', () => {
    expect(client.scanManifests().map((c) => c.blockId)).not.toContain('_template');
  });

  it('preserves the dangerous flag the dispatcher gates on', () => {
    const pull = client.scanManifests().find((c) => c.cmd === '/model-pull');
    if (pull) expect(pull.dangerous).toBe(true);
  });
});
