// Dashboard KPI wording — pure functions, so what the home screen claims is
// testable without a DOM (tests/home-blocks-ui-logic.test.js).
//
// Every card states its source and scope. Before 2026-09-23 the row said:
//   API Spend  = session tokens × Gemini's price, whatever provider served
//                them, labelled "$15 daily limit" — a cap only the unused
//                legacy POST /api/chat enforces;
//   LLM Engines = engine/model pairs called since the server started,
//                commented as "engines reachable right now";
//   Server      = "CLOUD · Supabase relay" whenever /api/llm-telemetry did
//                not answer 200 — including a plain expired session on a
//                local-only install.

export function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/**
 * Why a block-owned analytics fetch failed, in words an operator can act on.
 * `status` is the HTTP status, or 0 when the request never got an answer.
 */
export function analyticsProblem(status) {
  if (status === 404) return 'The Activity block is not installed. The heatmap, analytics and live feed come from it.';
  if (status === 401) return 'Your session expired. Sign in again to load analytics.';
  if (!status) return 'The AEON server is not answering.';
  return `Analytics did not load (HTTP ${status}).`;
}

/** The Server card from the /api/llm-telemetry probe. */
export function serverCard(probe) {
  if (!probe) return { value: '…', sub: 'Checking', accent: 'cyan' };
  if (probe.ok) {
    const up = Number(probe.uptime);
    return {
      value: 'ONLINE',
      sub: Number.isFinite(up) ? `Local kernel · up ${fmtUptime(up)}` : 'Local kernel',
      accent: 'emerald',
    };
  }
  if (probe.status === 401) return { value: 'SIGNED OUT', sub: 'Session expired — sign in again', accent: 'amber' };
  if (!probe.status) return { value: 'UNREACHABLE', sub: 'The AEON server is not answering', accent: 'amber' };
  return { value: `HTTP ${probe.status}`, sub: 'Telemetry route failed', accent: 'amber' };
}

export function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Spend today, from the activity summary — the kernel's own derivation over
 * the call ledger (getDailyCost). Providers without a list price count $0,
 * and the card says so rather than implying they are free.
 */
export function spendCard(summary, problemStatus) {
  if (!summary) {
    return { value: '—', sub: problemStatus === undefined ? 'Loading' : analyticsProblem(problemStatus) };
  }
  const cost = Number(summary.dailyCost) || 0;
  const priced = Array.isArray(summary.pricedProviders) && summary.pricedProviders.length
    ? summary.pricedProviders.join(' + ')
    : 'no provider';
  return {
    value: `$${cost.toFixed(4)}`,
    sub: `Today · list price for ${priced}; other providers not priced`,
  };
}

/** LLM calls today, from the same summary. Failures are counted, not hidden. */
export function callsCard(summary, problemStatus) {
  if (!summary) {
    return { value: '—', sub: problemStatus === undefined ? 'Loading' : analyticsProblem(problemStatus) };
  }
  const t = summary.today || { requests: 0, tokens: 0, errors: 0 };
  const failed = t.errors ? ` · ${t.errors} failed` : '';
  return { value: String(t.requests || 0), sub: `Today · ${fmtNum(t.tokens)} tok${failed}` };
}

/** One failed ledger call, as a feed line: when, what, and why. */
export function failureLine(call, now = Date.now()) {
  const who = [call.provider, call.model].filter(Boolean).join(' / ') || 'unknown';
  const code = call.status ? `HTTP ${call.status}` : 'failed';
  const why = String(call.error || '').replace(/^Endpoint error \d+:\s*/, '');
  return { who, code, why: why.slice(0, 140), ago: ago(call.ts, now) };
}

export function ago(ts, now = Date.now()) {
  const ms = ts ? now - Number(ts) : NaN;
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
