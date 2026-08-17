/**
 * BO-K — Supabase config resolved at runtime, and first-run recorded once.
 *
 * The defect these pin: `import.meta.env.VITE_SUPABASE_URL` is inlined by Vite
 * at build time, so credentials saved through Settings could never reach the
 * browser. Pressing Save could not enable the Cloud tab on any machine, and a
 * green "configured" badge sat over it.
 *
 * The client is mocked at the @supabase/supabase-js boundary — these assert
 * OUR resolution logic (when do we build a client, when do we return null,
 * when do we re-read), not Supabase's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const created = [];
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url, key) => {
    created.push({ url, key });
    return { __client: true, url, key };
  },
}));

let getSupabase, resetSupabase;

beforeEach(async () => {
  created.length = 0;
  vi.resetModules();

  // ── Hermetic, BO-SHIP P10 ──────────────────────────────────────────
  //
  // build() short-circuits on import.meta.env.VITE_SUPABASE_* — deliberately,
  // so an install configured through .env pays no round trip. Vitest injects
  // the developer's REAL .env into import.meta.env, so on any machine with
  // Supabase actually configured that branch won, the runtime path below was
  // never reached, and these nine tests went red.
  //
  // Measured both ways: 9 failed with a populated .env, 9 passed with it moved
  // aside. CI stayed green only because CI has no credentials — the suite was
  // passing for the wrong reason, and would have ambushed the first person to
  // configure AEON properly.
  //
  // A test must own the environment it asserts against. These assert the
  // RUNTIME path, so the env vars are cleared here; the env-wins branch gets
  // its own tests below, which set them explicitly.
  vi.stubEnv('VITE_SUPABASE_URL', '');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

  // Fresh module instance per test — the cache is module-scoped by design.
  ({ getSupabase, resetSupabase } = await import('../src/kernel/supabase.js'));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const stubFetch = (payload, ok = true) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => payload })));

describe('getSupabase', () => {
  it('builds a client from the runtime route — no rebuild required', async () => {
    stubFetch({ ok: true, configured: true, supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon-123' });
    const c = await getSupabase();
    expect(c).toBeTruthy();
    expect(created).toEqual([{ url: 'https://proj.supabase.co', key: 'anon-123' }]);
  });

  it('returns null when the server says unconfigured — local-only is supported', async () => {
    stubFetch({ ok: true, configured: false, supabaseUrl: null, supabaseAnonKey: null });
    expect(await getSupabase()).toBeNull();
    expect(created).toEqual([]);
  });

  it('returns null rather than throwing when the kernel is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await getSupabase()).toBeNull();
  });

  it('returns null on a non-2xx without trying to parse it', async () => {
    stubFetch({}, false);
    expect(await getSupabase()).toBeNull();
  });

  it('treats a partial config as unconfigured', async () => {
    stubFetch({ ok: true, configured: true, supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: null });
    expect(await getSupabase()).toBeNull();
  });

  it('fetches once for concurrent callers, then caches', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ configured: true, supabaseUrl: 'u', supabaseAnonKey: 'k' }) }));
    vi.stubGlobal('fetch', f);
    const [a, b] = await Promise.all([getSupabase(), getSupabase()]);
    expect(a).toBe(b);
    await getSupabase();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('caches the null result too — an unconfigured install is not re-asked forever', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ configured: false }) }));
    vi.stubGlobal('fetch', f);
    await getSupabase();
    await getSupabase();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('resetSupabase', () => {
  it('makes newly saved credentials usable without a page reload', async () => {
    stubFetch({ configured: false });
    expect(await getSupabase()).toBeNull();

    // Operator saves credentials in Settings; the wizard calls resetSupabase().
    stubFetch({ configured: true, supabaseUrl: 'https://new.supabase.co', supabaseAnonKey: 'anon-new' });
    resetSupabase();

    const c = await getSupabase();
    expect(c).toBeTruthy();
    expect(created.at(-1)).toEqual({ url: 'https://new.supabase.co', key: 'anon-new' });
  });
});

describe('the public config contract', () => {
  it('never asks for or stores a service-role key', async () => {
    // A full-access credential must never be resolvable from the browser. If
    // someone widens the route's response later, this fails.
    stubFetch({
      configured: true,
      supabaseUrl: 'https://proj.supabase.co',
      supabaseAnonKey: 'anon-123',
      serviceRoleKey: 'SHOULD-NEVER-BE-USED',
    });
    await getSupabase();
    const keysUsed = created.map((c) => c.key);
    expect(keysUsed).toEqual(['anon-123']);
    expect(keysUsed).not.toContain('SHOULD-NEVER-BE-USED');
  });
});

/**
 * The build-time branch, which had no coverage at all.
 *
 * BO-SHIP P10. It was exercised only by accident — on whichever developer
 * machine happened to have VITE_SUPABASE_* set, where it silently replaced the
 * runtime path the other tests assert. That is the worst of both: no
 * intentional coverage, and interference with the tests that do have some.
 *
 * Asserted deliberately here, with the env owned by the test.
 */
describe('build-time credentials still win, when they are really set', () => {
  it('uses .env values and never asks the kernel', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://from-env.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-from-env');
    vi.resetModules();
    const f = vi.fn();
    vi.stubGlobal('fetch', f);

    const mod = await import('../src/kernel/supabase.js');
    const c = await mod.getSupabase();

    expect(c).toBeTruthy();
    expect(created.at(-1)).toEqual({ url: 'https://from-env.supabase.co', key: 'anon-from-env' });
    expect(f, 'a build-time config must not pay a round trip').not.toHaveBeenCalled();
  });

  it('falls through to the runtime route when only one half is set', async () => {
    // A half-configured .env is the shape that produces a confusing failure:
    // present enough to look configured, incomplete enough to be unusable.
    vi.stubEnv('VITE_SUPABASE_URL', 'https://from-env.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ configured: true, supabaseUrl: 'https://runtime.supabase.co', supabaseAnonKey: 'anon-runtime' }),
    })));

    const mod = await import('../src/kernel/supabase.js');
    await mod.getSupabase();

    expect(created.at(-1)).toEqual({ url: 'https://runtime.supabase.co', key: 'anon-runtime' });
  });
});
