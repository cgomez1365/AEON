/**
 * Forensics-banner policy for the global fetch interceptor (App.jsx).
 *
 * Extracted so the decision table is testable directly. A test that
 * re-implements this table inline stays green while the banner is broken.
 *
 * MATCHING RULE — an entry ending in '/' matches by PREFIX; every other entry
 * matches the request path EXACTLY (query string and hash stripped first).
 * A prefix entry must therefore end on a path separator, so it can only ever
 * match a DEEPER SEGMENT of the same route — it can never reach a sibling.
 *
 * That rule is not cosmetic. Two live pairs in this repo would break under
 * naive prefix matching:
 *   '/api/search' (retrieve.cjs:112) is ignored, but '/api/search-web' is a
 *     separate route called from the browser (deep_research/index.jsx:367;
 *     NeuralTerminal.jsx was the other caller until it was deleted 2026-08-16)
 *     whose failures must be seen.
 *   '/api/writer/style/analyze' is ignored, but '/api/writer/style'
 *     (writer.js:147) is fetched at writer/index.jsx:151 behind a bare
 *     `.catch(() => {})` — the banner is its ONLY surface.
 * The same hazard waits for any future '/api/audit-*' sibling of '/api/audit'.
 *
 * Query stripping is what makes the exact rule usable: '/api/search-web?q=…'
 * is still the search-web route, and '/api/audit?limit=50' is still audit.
 */

// Endpoints whose failures the caller already surfaces, so a banner would be
// noise. Each entry needs that justification — this list is not a place to
// quiet something that is actually broken.
//
// /api/chat used to be here, and cloud was suppressed wholesale by a hostname
// check. Between them, dashboard chat answered HTTP 500 on every AI message in
// production and no user or developer ever saw a signal. R-05 has no cloud
// exemption: a failure the operator cannot see is a silent failure.
//
// /api/kernel/llm — components handle their own error rendering.
// /api/auth/status — 404s by design when no auth block is installed.
//
// The four /api/writer AI routes below all funnel their failure through the
// block's own aiFail()/showToast() (writer/index.jsx:163-170), and cowrite
// renders `error` straight into the Co-Write panel (writer/index.jsx:398).
// Two toasts fired for one failure and the useless generic one took the prime
// position at the top of the screen — labelled PENDING_OR_UNREACHABLE, which
// was a lie: the server answered and explained itself, it just carries no
// correlation_id in that shape.
// Deliberately NOT the whole '/api/writer/' prefix: the CRUD routes under it
// (docs, doc, doc/:id, versions, restore, style) end in bare `catch {}` on the
// client, so their failures have no other surface — the banner IS the signal
// there, and suppressing it would be the R-05 violation in reverse.
export const IGNORED_ENDPOINTS = [
  '/api/audit', '/api/health', '/api/canva/status',
  '/api/telemetry', '/api/llm-telemetry', '/api/local-status',
  '/api/gas/status', '/api/transcribe', '/api/kernel/llm', '/api/auth/status',
  '/api/writer/cowrite', '/api/writer/improve', '/api/writer/generate',
  '/api/writer/style/analyze',
];

// NETWORK-level exceptions only — a transport failure here is expected, an
// HTTP failure here is not, so these must never join IGNORED_ENDPOINTS.
//
// /api/kernel/security-availability is mounted by the kernel itself
// (authGate.cjs) and is PRE_SETUP_SAFE, so a non-2xx from it is a genuine
// kernel defect and still banners. The throw only happens when the server is
// not listening yet — auth.js:securityAvailability() takes a deliberate
// fallback for exactly that case, and a server that is truly down announces
// itself through every other API call anyway. It raised [NETWORK DEAD] on
// every boot that beat the kernel to the port.
export const NETWORK_TOLERANT_ENDPOINTS = ['/api/kernel/security-availability'];

// A request header a caller sets to say "I render my own failure, inline, every
// time." The banner then stays out of the way for that ONE request instead of a
// whole URL pattern being quieted forever.
//
// This exists because widget endpoints are declared by block manifests, so they
// cannot be listed above — and listing them would be the wrong shape anyway.
// The justification IGNORED_ENDPOINTS demands is a property of the CALLER, not
// of the URL: BlockWidget renders "Widget unavailable — <reason>" for every
// non-2xx and never swallows one. Two renderings of one failure is the §08
// defect the operator saw — a red [API FAILED] toast covering the panel's own
// sentence, which named the remedy.
//
// Deliberately narrow: it suppresses the BANNER only, never the failure, and
// only when the caller has opted in per request.
export const SELF_REPORTED_HEADER = 'x-aeon-self-reported';

/** Did this request opt out of the banner? Reads whatever fetch() was given. */
export function isSelfReported(init) {
  const h = init?.headers;
  if (!h) return false;
  try {
    if (typeof h.get === 'function') return !!h.get(SELF_REPORTED_HEADER);
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === SELF_REPORTED_HEADER) return !!h[k];
    }
  } catch { /* exotic headers object — treat as not opted out */ }
  return false;
}

const pathOf = (url) => String(url || '').split('#')[0].split('?')[0];

export function isApiUrl(url) {
  return pathOf(url).startsWith('/api');
}

export function matchesEndpoint(url, list) {
  const p = pathOf(url);
  return list.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
}

/** Does a non-2xx response deserve a banner? Cheap — no body read. */
export function shouldBannerResponse({ url, ok, status, selfReported = false, hasSession = true }) {
  if (ok || !isApiUrl(url)) return false;
  // 428 = intentional confirmation gate (dangerous commands) — not an error.
  if (status === 428) return false;
  // BO-H7b — a 401 with NO session is the gate working. The operator is on the
  // login screen; telling them "[API FAILED] UNAUTHORIZED_SESSION" describes a
  // correct state as a fault and teaches them to distrust true signals (§08).
  //
  // A 401 that arrives WITH a session is the one worth interrupting for: it
  // means a session that should work does not. That still banners.
  if (status === 401 && !hasSession) return false;
  // 401 on auth/security routes is EXPECTED when locked or signed out — the
  // AuthGate handles it, so it must never raise the forensics banner.
  const p = pathOf(url);
  if (status === 401 && (p.startsWith('/api/auth/') || p.startsWith('/api/security/'))) return false;
  // A caller that renders its own 401 inline gets one rendering, not two.
  // Scoped to 401/403 on purpose: a self-reporting panel still deserves the
  // banner for a 500, which is a defect rather than a permission state.
  if (selfReported && (status === 401 || status === 403)) return false;
  return !matchesEndpoint(url, IGNORED_ENDPOINTS);
}

/**
 * What to show once shouldBannerResponse() has said yes.
 * A server that explained itself gets its own words; the trace ID is for the
 * failure nobody can explain.
 */
export function describeResponseBanner({ url, body }) {
  // The command bus answers in an envelope that carries its explanation one
  // level down: { ok:false, text, data:{ error, correlation_id }, meta }.
  // Reading only the top level found neither, so a route that HAD explained
  // itself was labelled PENDING_OR_UNREACHABLE — the placeholder reserved for
  // a failure nobody can explain. The operator read that as an unreachable
  // dispatcher three separate times (BO-D finding #21) and it was never down.
  //
  // Top level still wins; `data` is a fallback for the envelope shape, never
  // an override.
  const env = (body && typeof body.data === 'object' && body.data !== null) ? body.data : null;
  const pick = (k) => {
    const top = body?.[k];
    if (typeof top === 'string' && top.trim()) return top.trim();
    const nested = env?.[k];
    return (typeof nested === 'string' && nested.trim()) ? nested.trim() : null;
  };

  const message = pick('error');
  const traceId = pick('correlation_id');
  if (message) return { kind: 'api', url, message, traceId };
  return { kind: 'api', url, message: null, traceId: traceId || 'PENDING_OR_UNREACHABLE' };
}

/**
 * How a streaming chat turn should render its failure.
 *
 * BO-D2f. Terminal2 rendered every failure as `[NEURAL LINK] <message>` — a
 * label that asserts the link is dead. The backend's honest, specific
 * "Native local runtime not ready" therefore reached the operator as a
 * network fault, and they went looking for one that did not exist. Three
 * different things were wearing one label:
 *
 *   server    an `event: error` frame — the server answered and explained
 *             itself, so it gets its own words and no diagnosis bolted on
 *   api       a non-2xx before the stream opened
 *   network   fetch itself threw — the only case where the link IS dead
 *
 * Extracted here, rather than left inline, for the reason this whole module
 * exists: a decision table inside a component cannot be tested without
 * standing up a DOM, so it silently rots. The labels match the ones App.jsx
 * uses so both surfaces speak one vocabulary (§05).
 *
 * `cancelled` is not a failure and returns null — a deliberate stop must
 * never render as an error (D1c).
 */
export function describeStreamFailure(error) {
  if (!error) return null;
  if (error.name === 'AbortError') return null;

  const message = String(error.message || '').trim() || 'Unknown failure';
  switch (error.aeonKind) {
    case 'server':
      return { kind: 'server', text: message };
    case 'api':
      return { kind: 'api', text: `[API FAILED] ${message}` };
    default:
      return { kind: 'network', text: `[NETWORK DEAD] ${message}` };
  }
}

/** Transport-level failure (fetch threw). Null = stay silent. */
export function decideNetworkBanner({ url }) {
  if (!isApiUrl(url)) return null;
  if (matchesEndpoint(url, IGNORED_ENDPOINTS)) return null;
  if (matchesEndpoint(url, NETWORK_TOLERANT_ENDPOINTS)) return null;
  return { kind: 'network', url, message: null, traceId: 'PENDING_OR_UNREACHABLE' };
}
