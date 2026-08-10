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
  // Fresh module instance per test — the cache is module-scoped by design.
  ({ getSupabase, resetSupabase } = await import('../src/kernel/supabase.js'));
});

afterEach(() => { vi.restoreAllMocks(); });

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
