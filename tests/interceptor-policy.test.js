/**
 * BO-F4 — forensics-banner policy (src/utils/interceptorPolicy.js).
 *
 * These tests import the REAL decision functions. They must never restate the
 * endpoint table inline: a test that re-implements its subject stays green
 * while the banner is broken.
 *
 * No server, no fetch, no HTTP. The policy is pure.
 */

import { describe, it, expect } from 'vitest';
import {
  IGNORED_ENDPOINTS,
  NETWORK_TOLERANT_ENDPOINTS,
  isApiUrl,
  matchesEndpoint,
  shouldBannerResponse,
  describeResponseBanner,
  decideNetworkBanner,
} from '../src/utils/interceptorPolicy.js';

const res500 = (url) => shouldBannerResponse({ url, ok: false, status: 500 });
const throwOn = (url) => decideNetworkBanner({ url });

describe('BO-F4 gate — HTTP branch', () => {
  it('ignored endpoint returning 500 raises no banner', () => {
    expect(res500('/api/audit')).toBe(false);
    expect(res500('/api/health')).toBe(false);
    expect(res500('/api/telemetry')).toBe(false);
  });

  it('non-ignored endpoint returning 500 raises a banner', () => {
    expect(res500('/api/prefs/appearance')).toBe(true);
    expect(res500('/api/build/ide-mode')).toBe(true);
  });

  it('a 2xx never raises a banner', () => {
    expect(shouldBannerResponse({ url: '/api/anything', ok: true, status: 200 })).toBe(false);
  });

  it('non-/api URLs are outside the interceptor entirely', () => {
    expect(res500('/index.html')).toBe(false);
    expect(res500('/assets/app.js')).toBe(false);
    expect(throwOn('/assets/app.js')).toBeNull();
  });
});

describe('BO-F4 gate — transport branch (F4b)', () => {
  it('network throw on an ignored endpoint raises no banner', () => {
    expect(throwOn('/api/audit')).toBeNull();
    expect(throwOn('/api/kernel/llm')).toBeNull();
  });

  it('network throw on a non-ignored endpoint raises a banner', () => {
    const b = throwOn('/api/prefs/appearance');
    expect(b).not.toBeNull();
    expect(b.kind).toBe('network');
    expect(b.url).toBe('/api/prefs/appearance');
  });

  // The catch branch was a bare `if (isApi)` — no exception could reach it.
  it('the ignore list is honoured in BOTH branches, not just the HTTP one', () => {
    for (const url of IGNORED_ENDPOINTS) {
      expect(res500(url), `${url} must not banner on 500`).toBe(false);
      expect(throwOn(url), `${url} must not banner on throw`).toBeNull();
    }
  });
});

describe('BO-F4b — /api/kernel/security-availability is network-tolerant, NOT ignored', () => {
  const URL = '/api/kernel/security-availability';

  it('is not in the ignore list — a non-2xx from a kernel route is a real defect', () => {
    expect(IGNORED_ENDPOINTS).not.toContain(URL);
    expect(res500(URL)).toBe(true);
    expect(shouldBannerResponse({ url: URL, ok: false, status: 404 })).toBe(true);
  });

  it('stays silent when the transport throws — the boot race, not a failure', () => {
    expect(NETWORK_TOLERANT_ENDPOINTS).toContain(URL);
    expect(throwOn(URL)).toBeNull();
  });

  it('network tolerance is not a back door into the HTTP branch', () => {
    for (const url of NETWORK_TOLERANT_ENDPOINTS) {
      if (IGNORED_ENDPOINTS.includes(url)) continue;
      expect(res500(url), `${url} must still banner on HTTP failure`).toBe(true);
    }
  });
});

describe('BO-F4a — the two toast systems no longer compete', () => {
  it('the writer AI routes are silent — the block surfaces its own message', () => {
    expect(res500('/api/writer/cowrite')).toBe(false);
    expect(res500('/api/writer/improve')).toBe(false);
    expect(res500('/api/writer/generate')).toBe(false);
    expect(res500('/api/writer/style/analyze')).toBe(false);
    expect(throwOn('/api/writer/cowrite')).toBeNull();
  });

  it('the writer CRUD routes still banner — bare catch {} leaves no other surface', () => {
    expect(res500('/api/writer/docs')).toBe(true);
    expect(res500('/api/writer/doc')).toBe(true);
    expect(res500('/api/writer/doc/abc123')).toBe(true);
    expect(res500('/api/writer/versions/abc123')).toBe(true);
    expect(res500('/api/writer/restore/abc123/17')).toBe(true);
    expect(res500('/api/writer/templates')).toBe(true);
  });
});

describe('BO-F4 gate — deliberate exclusions preserved', () => {
  it('428 is an intentional confirmation gate, not an error', () => {
    expect(shouldBannerResponse({ url: '/api/command', ok: false, status: 428 })).toBe(false);
  });

  it('expected 401s on /api/auth/* and /api/security/* stay silent', () => {
    expect(shouldBannerResponse({ url: '/api/auth/login', ok: false, status: 401 })).toBe(false);
    expect(shouldBannerResponse({ url: '/api/security/policy', ok: false, status: 401 })).toBe(false);
  });

  it('401 anywhere else is still a real signal', () => {
    expect(shouldBannerResponse({ url: '/api/prefs/appearance', ok: false, status: 401 })).toBe(true);
  });

  it('a NON-401 failure on an auth route still banners', () => {
    expect(shouldBannerResponse({ url: '/api/auth/login', ok: false, status: 500 })).toBe(true);
  });
});

describe('BO-F4 gate — anti-oversilencing (the matching rule)', () => {
  it('/api/search is ignored but /api/search-web still banners', () => {
    expect(res500('/api/search')).toBe(false);
    expect(res500('/api/search-web')).toBe(true);
    expect(throwOn('/api/search-web')).not.toBeNull();
  });

  it('/api/audit is ignored but /api/audit-log still banners', () => {
    expect(res500('/api/audit')).toBe(false);
    expect(res500('/api/audit-log')).toBe(true);
    expect(res500('/api/audit-export')).toBe(true);
  });

  it('/api/writer/style/analyze is ignored but /api/writer/style still banners', () => {
    expect(res500('/api/writer/style/analyze')).toBe(false);
    expect(res500('/api/writer/style')).toBe(true);
  });

  it('/api/kernel/llm is ignored but a sibling /api/kernel/llm-* would banner', () => {
    expect(res500('/api/kernel/llm')).toBe(false);
    expect(res500('/api/kernel/llm-status')).toBe(true);
  });

  it('/api/local-status is ignored but /api/local-status-detail would banner', () => {
    expect(res500('/api/local-status')).toBe(false);
    expect(res500('/api/local-status-detail')).toBe(true);
  });

  it('query strings and hashes are stripped before matching', () => {
    expect(res500('/api/audit?limit=50')).toBe(false);
    expect(res500('/api/search#top')).toBe(false);
    expect(res500('/api/search-web?q=rust%20vs%20go')).toBe(true);
    expect(throwOn('/api/search-web?q=x')).not.toBeNull();
  });

  it('no exact entry can ever reach a sibling route', () => {
    for (const entry of IGNORED_ENDPOINTS.filter((e) => !e.endsWith('/'))) {
      expect(matchesEndpoint(`${entry}-sibling`, IGNORED_ENDPOINTS), `${entry} leaked onto a sibling`).toBe(false);
      expect(matchesEndpoint(`${entry}/child`, IGNORED_ENDPOINTS), `${entry} leaked onto a child`).toBe(false);
    }
  });

  it('a prefix entry (trailing /) matches deeper segments only', () => {
    const list = ['/api/demo/'];
    expect(matchesEndpoint('/api/demo/child', list)).toBe(true);
    expect(matchesEndpoint('/api/demo/a/b?x=1', list)).toBe(true);
    expect(matchesEndpoint('/api/demo', list)).toBe(false);
    expect(matchesEndpoint('/api/demo-sibling', list)).toBe(false);
  });
});

describe('BO-F4c — prefer the specific message over the trace ID', () => {
  it('a response carrying `error` shows that message and no trace banner', () => {
    const b = describeResponseBanner({ url: '/api/x', body: { error: 'No AI provider configured.' } });
    expect(b.message).toBe('No AI provider configured.');
    expect(b.traceId).toBeNull();
  });

  it('the trace ID survives alongside a specific message when the server sent one', () => {
    const b = describeResponseBanner({ url: '/api/x', body: { error: 'Boom', correlation_id: 'abc-123' } });
    expect(b.message).toBe('Boom');
    expect(b.traceId).toBe('abc-123');
  });

  it('an unexplained failure with a correlation_id shows that trace ID', () => {
    const b = describeResponseBanner({ url: '/api/x', body: { correlation_id: 'trace-9' } });
    expect(b.message).toBeNull();
    expect(b.traceId).toBe('trace-9');
  });

  it('an unexplained failure with no id falls back to PENDING_OR_UNREACHABLE', () => {
    expect(describeResponseBanner({ url: '/api/x', body: {} }).traceId).toBe('PENDING_OR_UNREACHABLE');
    expect(describeResponseBanner({ url: '/api/x', body: null }).traceId).toBe('PENDING_OR_UNREACHABLE');
  });

  it('a blank or non-string `error` is not a message', () => {
    expect(describeResponseBanner({ url: '/api/x', body: { error: '   ' } }).message).toBeNull();
    expect(describeResponseBanner({ url: '/api/x', body: { error: { code: 5 } } }).message).toBeNull();
  });
});

describe('R-05 — no cloud exemption, no chat exemption', () => {
  it('/api/chat is not ignored: HTTP 500 on a cloud chat message must be seen', () => {
    expect(IGNORED_ENDPOINTS).not.toContain('/api/chat');
    expect(res500('/api/chat')).toBe(true);
    expect(throwOn('/api/chat')).not.toBeNull();
  });

  it('the policy has no hostname input at all — suppression cannot be host-scoped', () => {
    expect(shouldBannerResponse.length).toBe(1);
    expect(isApiUrl('/api/chat')).toBe(true);
    for (const entry of [...IGNORED_ENDPOINTS, ...NETWORK_TOLERANT_ENDPOINTS]) {
      expect(entry.startsWith('/api/'), `${entry} is not a path`).toBe(true);
      expect(entry).not.toMatch(/vercel|https?:|\./);
    }
  });
});
