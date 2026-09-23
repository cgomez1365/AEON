/**
 * What the home and ops screens claim, tested without a DOM.
 *
 * The wording lives in small pure modules the pages import
 * (dashboard/kpis.js, fleet_control/health.js, quick_links/linkOps.js).
 * What the old inline code showed, measured on a fresh install 2026-09-23
 * (agent C3, isolated home, one local stub provider):
 *   - Dashboard "Server": CLOUD · "Supabase relay" for any non-200 from
 *     /api/llm-telemetry — including an expired session. There is no relay.
 *   - Dashboard "API Spend": session tokens × Gemini's price for every
 *     provider, sub "$15 daily limit" (enforced only by the unused legacy
 *     POST /api/chat).
 *   - Dashboard analytics with the activity block removed: "Loading
 *     heatmap..." forever (its Supabase fallback fetched "undefined/rest/…").
 *   - Fleet Control: groq/gemini/local/openrouter — never configured — drawn
 *     red "Unhealthy — cooling down"; card "0/5 healthy engines".
 *   - Quick Links: no edit, no reorder; `window.open(link.url)` opened any
 *     scheme a synced link carried.
 */
import { describe, expect, it } from 'vitest';
import { serverCard, spendCard, callsCard, analyticsProblem, failureLine } from '../src/blocks/dashboard/kpis.js';
import { serverStatus, providerRows, providerCard, hardwareSummary } from '../src/blocks/fleet_control/health.js';
import { safeHref, normalizeUrl, moveLink, editLink, storeProblem } from '../src/blocks/quick_links/linkOps.js';

describe('dashboard KPI row', () => {
  it('never calls an unanswered probe "cloud"', () => {
    expect(serverCard({ ok: false, status: 401 }).value).toBe('SIGNED OUT');
    expect(serverCard({ ok: false, status: 0 }).value).toBe('UNREACHABLE');
    expect(serverCard({ ok: false, status: 500 }).value).toBe('HTTP 500');
    for (const s of [0, 401, 500]) expect(JSON.stringify(serverCard({ ok: false, status: s }))).not.toMatch(/cloud|supabase|relay/i);
    expect(serverCard({ ok: true, uptime: 125 })).toMatchObject({ value: 'ONLINE', sub: 'Local kernel · up 2m' });
  });

  it('spend is today\'s kernel-derived figure and says which providers are priced', () => {
    const c = spendCard({ dailyCost: 0.00016, pricedProviders: ['gemini', 'groq'] });
    expect(c.value).toBe('$0.0002');
    expect(c.sub).toMatch(/Today/);
    expect(c.sub).toMatch(/gemini \+ groq/);
    expect(c.sub).toMatch(/not priced/);
    expect(c.sub).not.toMatch(/limit/i);
  });

  it('calls today count failures instead of hiding them', () => {
    expect(callsCard({ today: { requests: 6, tokens: 100, errors: 2 } })).toEqual({ value: '6', sub: 'Today · 100 tok · 2 failed' });
    expect(callsCard({ today: { requests: 0, tokens: 0, errors: 0 } })).toEqual({ value: '0', sub: 'Today · 0 tok' });
  });

  it('a missing activity block is named, not left "loading"', () => {
    expect(analyticsProblem(404)).toMatch(/Activity block is not installed/);
    expect(spendCard(null, 404).sub).toMatch(/Activity block is not installed/);
    expect(callsCard(null, 401).sub).toMatch(/sign in/i);
    expect(spendCard(null, undefined).sub).toBe('Loading');
  });

  it('a failed call reads as who, HTTP status and why', () => {
    const l = failureLine({ ts: 1000, provider: 'custom', model: 'stub-fail', status: 429,
      error: 'Endpoint error 429: {"error":{"message":"rate limit"}}' }, 1000 + 5 * 60_000);
    expect(l).toMatchObject({ who: 'custom / stub-fail', code: 'HTTP 429', ago: '5m ago' });
    expect(l.why).toMatch(/rate limit/);
    expect(l.why).not.toMatch(/^Endpoint error/);
  });
});

describe('fleet control provider health', () => {
  const now = 1_000_000;
  const health = {
    providers: {
      groq: { healthy: false, configured: false },
      gemini: { healthy: false, configured: false },
      local: { healthy: false, configured: false },
      openrouter: { healthy: false, configured: false },
      custom: { healthy: false, configured: true, blockedUntil: now + 42_000, reason: 'Endpoint error 429: rate limit exceeded' },
    },
    keyPools: {},
  };

  it('the server card never claims a cloud relay', () => {
    expect(serverStatus({ ok: false, status: 401 }).value).toBe('SIGNED OUT');
    expect(serverStatus({ ok: false, status: 0 }).value).toBe('UNREACHABLE');
    expect(serverStatus({ ok: true, uptime: 600 })).toMatchObject({ value: 'ONLINE', sub: 'Local kernel · up 10m' });
    for (const s of [0, 401, 503]) expect(JSON.stringify(serverStatus({ ok: false, status: s }))).not.toMatch(/cloud|supabase|relay/i);
  });

  it('unconfigured providers are "Not configured", never "cooling down"', () => {
    const rows = providerRows(health, now);
    for (const id of ['groq', 'gemini', 'local', 'openrouter']) {
      const r = rows.find(x => x.id === id);
      expect(r.state).toBe('unconfigured');
      expect(r.label).toBe('Not configured');
    }
  });

  it('a configured provider in cooldown says for how long and why', () => {
    const r = providerRows(health, now).find(x => x.id === 'custom');
    expect(r).toMatchObject({ state: 'cooling', label: 'Cooling down — retry in 42s' });
    expect(r.detail).toMatch(/rate limit exceeded/);
    expect(providerRows(health, now)[0].id).toBe('custom'); // problems first
  });

  it('a configured endpoint the health map has not seen is counted, not "no provider"', () => {
    const bare = { providers: { groq: { healthy: false, configured: false } }, keyPools: {} };
    const rows = providerRows(bare, now, [{ id: 'stub', provider: 'custom' }]);
    expect(rows.find(r => r.id === 'custom')).toMatchObject({ state: 'healthy', label: 'Healthy — no failures recorded' });
    expect(providerCard(rows)).toMatchObject({ value: '1/1', tone: 'ok' });
    // A provider the health map already reports keeps the kernel's verdict.
    const cooling = providerRows(health, now, [{ id: 'stub', provider: 'custom' }]).find(r => r.id === 'custom');
    expect(cooling.state).toBe('cooling');
  });

  it('the card counts configured providers only', () => {
    expect(providerCard(providerRows(health, now))).toMatchObject({ value: '0/1', tone: 'warn' });
    expect(providerCard(providerRows({ providers: { groq: { healthy: false, configured: false } } }, now)))
      .toMatchObject({ value: '0', sub: 'No provider configured' });
    expect(providerCard(providerRows({ providers: { custom: { healthy: true, configured: true } } }, now)))
      .toMatchObject({ value: '1/1', tone: 'ok' });
  });

  it('hardware summary names the machine and what fits', () => {
    const s = hardwareSummary({
      system: { cpu_model: 'i5', cpu_cores: 6, total_ram_gb: 8, has_gpu: false },
      models: [
        { short_name: 'A-8B', params_b: 8, fit: 'cpu', label: 'CPU/RAM Only' },
        { short_name: 'B-70B', params_b: 70, fit: 'too_large', label: 'Does Not Fit' },
        { short_name: 'C-3B', params_b: 3, fit: 'cpu', label: 'CPU/RAM Only' },
      ],
    });
    expect(s.machine).toBe('i5 · 6 cores · 8 GB RAM');
    expect(s.gpu).toBe('No GPU detected');
    expect(s.fits).toEqual({ gpu: 0, offload: 0, cpu: 2, tooLarge: 1 });
    expect(s.best[0]).toMatch(/^A-8B/);
    expect(hardwareSummary(null)).toBeNull();
  });
});

describe('quick links', () => {
  it('opens and stores http(s) only', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  const L = [
    { id: '1', name: 'A', url: 'https://a.test/', category: 'Work' },
    { id: '2', name: 'B', url: 'https://b.test/', category: 'Home' },
    { id: '3', name: 'C', url: 'https://c.test/', category: 'Work' },
  ];

  it('reorders within the visible category', () => {
    expect(moveLink(L, '3', -1).map(l => l.id)).toEqual(['3', '2', '1']);
    expect(moveLink(L, '1', +1).map(l => l.id)).toEqual(['3', '2', '1']);
    expect(moveLink(L, '1', -1)).toEqual(L);        // already first in Work
    expect(moveLink(L, '2', +1)).toEqual(L);        // only one in Home
    expect(L.map(l => l.id)).toEqual(['1', '2', '3']); // input untouched
  });

  it('edits name, url and category, refusing unsafe or empty values', () => {
    const ok = editLink(L, '2', { name: ' Bee ', url: 'bee.test', category: 'Work' });
    expect(ok.error).toBeNull();
    expect(ok.links[1]).toEqual({ id: '2', name: 'Bee', url: 'https://bee.test/', category: 'Work' });
    expect(editLink(L, '2', { url: 'javascript:x' }).error).toMatch(/http/);
    expect(editLink(L, '2', { name: '  ' }).error).toMatch(/name/);
    expect(editLink(L, 'nope', { name: 'x' }).error).toMatch(/no longer exists/);
  });

  it('names the missing Aeon Matrix block when the store route is absent', () => {
    expect(storeProblem(null, 404)).toBeNull();
    expect(storeProblem('Links were not saved (HTTP 404)', 404)).toMatch(/Aeon Matrix block, which is not installed/);
    expect(storeProblem('Links were not saved (HTTP 401)', 401)).toMatch(/sign in/);
    expect(storeProblem('Could not reach the links store (HTTP 500)', 500)).toMatch(/HTTP 500/);
  });
});
