/**
 * Activity's numbers are the ledger's numbers.
 *
 * Measured 2026-09-23 on a fresh install (agent C3, isolated home, stub LLM):
 *
 *   - GET /api/token-analytics/heatmap at 02:09 local returned 364 days ending
 *     YESTERDAY. The loop stepped a Date by setDate(+1) from "now minus 364
 *     days"; crossing the March spring-forward moved its wall clock from 02:09
 *     to 03:09, so the final `cursor <= end` failed and today — the only day
 *     with calls — was dropped. The dashboard's 7d/30d/90d chart slices the
 *     same array, so it lost today too.
 *   - currentStreak was overwritten by every older run it walked past: today
 *     active, yesterday idle, three days before active reported "3".
 *   - With zero LLM calls, summary.totalRequests was 1 (the chat log's seeded
 *     "SYSTEM INITIALIZED" message, via `totalRequests || chatCount ||
 *     auditCount`), and GET /api/telemetry reported 1 request / 150 tokens for
 *     "aeon_cortex" (`Number(msg.tokens) || 150`).
 *   - Counts came from activity_heatmap.json while cost came from the ledger —
 *     two sources that part ways whenever the heatmap recorder is not attached
 *     (Settings → telemetry off; server.js's direct mount failing), so the
 *     panels could disagree with the ledger every other surface reads.
 *
 * Drives the real routers in-process; nothing is re-implemented here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createTokenAnalytics = require('../src/blocks/activity/api/token-analytics.cjs');
const createAnalytics = require('../src/blocks/activity/api/analytics.cjs');

const ORIGINAL_TZ = process.env.TZ;
let root, dbDir, dataDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-activity-'));
  dbDir = path.join(root, 'db');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'activity'), { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function deps(over = {}) {
  return {
    getLocalFile: (n) => path.join(dbDir, n),
    getDataFile: (rel) => path.join(dataDir, rel),
    AUDIT_FILE: path.join(dbDir, 'audit_log.json'),
    LOG_FILE: path.join(dbDir, 'chat_log.json'),
    TOKEN_LEDGER_FILE: path.join(dbDir, 'token_ledger.json'),
    isVercel: false,
    supabase: null,
    GEMINI_PRICE_PER_TOKEN: 0.00000015,
    GROQ_PRICE_PER_TOKEN: 0.0000006,
    validateSDI: () => ({ valid: true }),
    ...over,
  };
}

const ledgerFile = () => path.join(dbDir, 'llm_calls.jsonl');
function writeLedger(rows) {
  fs.writeFileSync(ledgerFile(), rows.map(r => JSON.stringify({
    provider: 'custom', model: 'stub-chat', tokens: 25, latencyMs: 5, success: true, ...r,
  })).join('\n') + '\n');
}
function writeHeatmapFile(obj) {
  fs.writeFileSync(path.join(dataDir, 'activity', 'activity_heatmap.json'), JSON.stringify(obj));
}
/** Local-time timestamp for a calendar day offset from "today" at noon. */
function localTs(daysAgo, hour = 12) {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, hour).getTime();
}
function key(daysAgo) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** In-process request driver — no port, no listener. */
function call(router, method, url) {
  return new Promise((resolve) => {
    let done = false;
    const req = { method, url, headers: {}, body: {}, query: {} };
    const q = url.split('?')[1];
    if (q) for (const kv of q.split('&')) { const [k, v] = kv.split('='); req.query[k] = decodeURIComponent(v || ''); }
    const res = {
      statusCode: 200,
      setHeader() {}, getHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { if (!done) { done = true; resolve({ status: this.statusCode, body: b }); } return this; },
      end() { if (!done) { done = true; resolve({ status: this.statusCode, body: null }); } return this; },
    };
    router.handle(req, res, () => { if (!done) { done = true; resolve({ status: 404, body: null }); } });
  });
}

describe('the heatmap always ends today', () => {
  it('includes today at 02:30 local when the year spans a spring-forward', async () => {
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T09:30:00Z')); // 02:30 PDT
    writeLedger([{ ts: Date.now() - 60_000 }, { ts: Date.now() - 30_000 }]);

    const r = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/heatmap');
    expect(r.status).toBe(200);
    const last = r.body.days[r.body.days.length - 1];
    expect(last.date).toBe('2026-09-23');
    expect(last.requests).toBe(2);
    expect(r.body.days).toHaveLength(365);
    expect(r.body.totalRequests).toBe(2);
    // No day appears twice and none is skipped.
    expect(new Set(r.body.days.map(d => d.date)).size).toBe(365);
  });
});

describe('counts come from the ledger — the record every surface reads', () => {
  it('calls the heatmap file never saw are still counted', async () => {
    // The recorder that writes activity_heatmap.json was not attached (or
    // telemetry was off); the ledger still has every call.
    writeLedger([{ ts: localTs(0) }, { ts: localTs(0), success: false, tokens: 0, status: 429, error: 'rate limited' }, { ts: localTs(1) }]);
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.totalRequests).toBe(3);
    expect(s.body.totalTokens).toBe(50);
    expect(s.body.errors).toBe(1);
    expect(s.body.today).toMatchObject({ requests: 2, tokens: 25, errors: 1 });
    expect(s.body.activeDays).toBe(2);
  });

  it('keeps legacy heatmap history from before the ledger existed', async () => {
    writeHeatmapFile({ [key(40)]: { requests: 7, tokens: 700, models: { old: { requests: 7, tokens: 700 } } } });
    writeLedger([{ ts: localTs(0) }]);
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.totalRequests).toBe(8);
    expect(s.body.activeDays).toBe(2);
    const d = await call(createTokenAnalytics(deps()), 'GET', `/token-analytics/daily/${key(40)}`);
    expect(d.body.requests).toBe(7);
  });

  it('a heatmap-file day the ledger also covers is not counted twice', async () => {
    writeHeatmapFile({ [key(0)]: { requests: 2, tokens: 50, models: {} } });
    writeLedger([{ ts: localTs(0) }, { ts: localTs(0) }]);
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.totalRequests).toBe(2);
  });

  it('7/30/90-day windows are calendar days, today included', async () => {
    writeLedger([0, 6, 7, 29, 30, 89, 90].map(n => ({ ts: localTs(n, 1) })));
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.last7.requests).toBe(2);   // days 0 and 6
    expect(s.body.last30.requests).toBe(4);  // + 7, 29
    expect(s.body.last90.requests).toBe(6);  // + 30, 89
  });
});

describe('streaks', () => {
  it('the current streak is the run that reaches today, not the oldest run walked', async () => {
    writeLedger([0, 2, 3, 4].map(n => ({ ts: localTs(n) })));
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.currentStreak).toBe(1);
    expect(s.body.longestStreak).toBe(3);
  });

  it('same rule on legacy heatmap-file history (no ledger yet)', async () => {
    const e = { requests: 1, tokens: 10, models: {} };
    writeHeatmapFile({ [key(0)]: e, [key(2)]: e, [key(3)]: e, [key(4)]: e });
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.currentStreak).toBe(1);
    expect(s.body.longestStreak).toBe(3);
  });

  it('a streak through yesterday is still current before today has a call', async () => {
    writeLedger([1, 2].map(n => ({ ts: localTs(n) })));
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.currentStreak).toBe(2);
  });

  it('no activity means no streak', async () => {
    writeLedger([5].map(n => ({ ts: localTs(n) })));
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.currentStreak).toBe(0);
    expect(s.body.longestStreak).toBe(1);
  });
});

describe('a fresh install reports zero', () => {
  beforeEach(() => {
    // Exactly what a fresh home contains: the seeded system line, no calls.
    fs.writeFileSync(path.join(dbDir, 'chat_log.json'), JSON.stringify([
      { id: 1, sender: 'system', name: 'AEON_CORTEX', content: 'SYSTEM INITIALIZED. WAITING FOR CEO COMMAND.' },
    ]));
    fs.writeFileSync(path.join(dbDir, 'audit_log.json'), JSON.stringify([{ id: 'a', action: 'AUTH_SETUP' }]));
  });

  it('summary does not borrow the chat or audit log as a request count', async () => {
    const s = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/summary');
    expect(s.body.totalRequests).toBe(0);
    expect(s.body.totalTokens).toBe(0);
    expect(s.body.activeDays).toBe(0);
  });

  it('/api/telemetry does not invent 150 tokens per chat message', async () => {
    const t = await call(createAnalytics(deps()), 'GET', '/telemetry');
    expect(t.status).toBe(200);
    expect(t.body.totalRequests).toBe(0);
    expect(t.body.totalTokens).toBe(0);
    expect(t.body.staffUsage).toEqual({});
  });
});

describe('/api/telemetry matches the ledger', () => {
  it('reports per-provider usage and today\'s derived cost', async () => {
    writeLedger([
      { ts: localTs(0), provider: 'gemini', model: 'gemini-flash', tokens: 1000 },
      { ts: localTs(0), provider: 'custom', model: 'stub-chat', tokens: 25 },
      { ts: localTs(0), provider: 'custom', model: 'stub-fail', tokens: 0, success: false, status: 429 },
    ]);
    const t = await call(createAnalytics(deps()), 'GET', '/telemetry');
    expect(t.body.totalRequests).toBe(3);
    expect(t.body.totalTokens).toBe(1025);
    expect(t.body.staffUsage.gemini).toMatchObject({ requests: 1, tokens: 1000 });
    expect(t.body.staffUsage.custom).toMatchObject({ requests: 2, tokens: 25, errors: 1 });
    expect(t.body.totalCost).toBeCloseTo(1000 * 0.00000015, 12);
  });
});

describe('failed calls say why', () => {
  it('lists recent failures with the HTTP status and error the ledger kept', async () => {
    writeLedger([
      { ts: localTs(0, 9) },
      { ts: localTs(0, 10), model: 'stub-fail', tokens: 0, success: false, status: 429, error: 'Endpoint error 429: rate limit' },
    ]);
    const r = await call(createTokenAnalytics(deps()), 'GET', '/token-analytics/calls?failed=1&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.calls).toHaveLength(1);
    expect(r.body.calls[0]).toMatchObject({ model: 'stub-fail', status: 429, success: false });
    expect(r.body.calls[0].error).toMatch(/rate limit/);
  });
});

describe('spend is the kernel\'s own number', () => {
  it('uses deps.getDailyCost when the kernel provides it', async () => {
    writeLedger([{ ts: localTs(0), provider: 'gemini', tokens: 1000 }]);
    const s = await call(createTokenAnalytics(deps({ getDailyCost: () => 0.42 })), 'GET', '/token-analytics/summary');
    expect(s.body.dailyCost).toBe(0.42);
  });
});
