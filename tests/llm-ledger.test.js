/**
 * BO-D2g — analytics that record what actually happened.
 *
 * REPORTED: heatmap, Activity, Fleet Control and token analytics all show
 * zero while live telemetry shows calls in the same viewport.
 *
 * WHAT WAS ACTUALLY TRUE (checked on disk, 2026-08-06):
 *
 *   db/token_ledger.json                     does not exist
 *   src/blocks/activity/db/activity_heatmap.json   DOES exist, with records
 *
 * So the diagnosis needed correcting. Two separate defects, not one:
 *
 *   #23/#24  The COST ledger is written by addRunCost(), called from exactly
 *            one place — dashboard/api/chat.cjs, the legacy non-streaming
 *            /api/chat that nothing uses. The streaming terminal, /api/ai,
 *            Writer, Council and the agent loop never call it, so the file
 *            is never created and every consumer correctly reports zero.
 *            Its shape — {date, cost} — is a single day, overwritten. Even
 *            written perfectly it could never answer the questions asked of
 *            it: a heatmap needs per-day history, a model chart needs
 *            per-call records, a streak needs continuity.
 *
 *   #15      The heatmap records only SUCCESSES. Every recorded entry also
 *            carries "tokens": 0. A day of failed calls is indistinguishable
 *            from a day nobody worked — which is the §08 shape again: the
 *            system knows and does not say.
 *
 * The fix hangs recording off _trackLLM, the ONE seam every provider — local
 * and cloud — already crosses, and stores append-only per-call records with
 * the aggregates derived on read.
 *
 * Drives the real module. Nothing is re-implemented inline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ledgerMod = require('../src/kernel/llm-ledger.cjs');

let dir;
let ledger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ledger-'));
  ledger = ledgerMod.createLedger({ file: path.join(dir, 'llm_calls.jsonl') });
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const call = (over = {}) => ({
  provider: 'local', model: 'llama3-8b-q4', tokens: 120,
  latencyMs: 900, success: true, ...over,
});

describe('one record per call, at the seam every provider crosses', () => {
  it('a call is persisted and can be read back', () => {
    ledger.record(call());
    const rows = ledger.read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'local', model: 'llama3-8b-q4', tokens: 120, success: true });
    expect(typeof rows[0].ts).toBe('number');
  });

  it('records FAILURES too — a day of failures is not a day of no work', () => {
    ledger.record(call({ success: false, tokens: 0 }));
    const rows = ledger.read();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(false);
  });

  it('is append-only — a second call does not overwrite the first', () => {
    // The old ledger was {date, cost}, rewritten every time. One day, one
    // number, no history.
    ledger.record(call({ model: 'a' }));
    ledger.record(call({ model: 'b' }));
    ledger.record(call({ model: 'c' }));
    expect(ledger.read().map(r => r.model)).toEqual(['a', 'b', 'c']);
  });

  it('survives a corrupt line rather than losing the file', () => {
    ledger.record(call());
    fs.appendFileSync(path.join(dir, 'llm_calls.jsonl'), 'not json at all\n');
    ledger.record(call({ model: 'after' }));
    const rows = ledger.read();
    expect(rows).toHaveLength(2);
    expect(rows[1].model).toBe('after');
  });

  it('never throws into the caller — telemetry must not break inference', () => {
    const broken = ledgerMod.createLedger({ file: path.join(dir, 'nope', 'deep', 'x.jsonl') });
    expect(() => broken.record(call())).not.toThrow();
  });
});

describe('the aggregates every consumer asked for are DERIVED', () => {
  beforeEach(() => {
    const day = 86_400_000;
    const now = Date.now();
    ledger.record(call({ ts: now, tokens: 100, provider: 'local', model: 'llama3-8b-q4' }));
    ledger.record(call({ ts: now, tokens: 50, provider: 'local', model: 'llama3-8b-q4' }));
    ledger.record(call({ ts: now, tokens: 10, provider: 'gemini', model: 'gemini-2.0-flash', success: false }));
    ledger.record(call({ ts: now - day, tokens: 70, provider: 'gemini', model: 'gemini-2.0-flash' }));
  });

  it('per-day history — what a heatmap needs', () => {
    const byDay = ledger.byDay();
    const days = Object.keys(byDay).sort();
    expect(days).toHaveLength(2);
    const today = byDay[days[1]];
    expect(today.requests).toBe(3);
    expect(today.tokens).toBe(160);
    expect(today.errors).toBe(1);
  });

  it('per-model breakdown — what a model chart needs', () => {
    const models = ledger.byModel();
    expect(models['llama3-8b-q4'].requests).toBe(2);
    expect(models['llama3-8b-q4'].tokens).toBe(150);
    expect(models['gemini-2.0-flash'].requests).toBe(2);
  });

  it('cost is DERIVED, not the reason the record exists', () => {
    // Local inference has no cost and is most of the traffic now. A ledger
    // built around cost could not describe it at all.
    const cost = ledger.dailyCost({ pricePerToken: { gemini: 0.00000015, local: 0 } });
    expect(cost).toBeCloseTo(10 * 0.00000015, 10);
  });

  it('totals ignore nothing and invent nothing', () => {
    const t = ledger.totals();
    expect(t.requests).toBe(4);
    expect(t.tokens).toBe(230);
    expect(t.errors).toBe(1);
  });
});

describe('#15 — one router, one data root', () => {
  /**
   * The heatmap recorded and the heatmap reported zero, at the same time.
   *
   * The activity block DECLARES its token-analytics routes, so the block
   * loader mounts an instance with getDataFile (→ data/activity/). server.js
   * mounted a SECOND instance of the same file without getDataFile, which
   * fell back to src/blocks/activity/db/ — and that second instance's
   * recordActivity is the one wired to _trackLLM.
   *
   * Writer wrote to the block folder. Reader served from the data root.
   * Both were working perfectly. Same shape as BO-C's two model registries:
   * not a missing feature, a second copy nobody knew was there.
   */
  it('server.js passes getDataFile, so both instances resolve one file', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'server', 'server.js'), 'utf8'
    );
    const mount = src.slice(src.indexOf('token-analytics.cjs'));
    const block = mount.slice(0, mount.indexOf('});'));
    expect(block, 'the token-analytics mount must pass getDataFile').toMatch(/getDataFile/);
  });

  it('operator telemetry never lands inside src/blocks/', () => {
    // src/ is source. Portable mode relocates the data root out from under
    // it, so anything written there is lost on the next install.
    const stray = path.join(process.cwd(), 'src', 'blocks', 'activity', 'db', 'activity_heatmap.json');
    expect(fs.existsSync(stray), `${stray} is operator data living in source`).toBe(false);
  });
});

describe('the file the old ledger could never be', () => {
  it('a fresh install reports zero without pretending it has data', () => {
    const empty = ledgerMod.createLedger({ file: path.join(dir, 'absent.jsonl') });
    expect(empty.read()).toEqual([]);
    expect(empty.totals()).toMatchObject({ requests: 0, tokens: 0, errors: 0 });
    expect(empty.dailyCost({ pricePerToken: {} })).toBe(0);
  });

  it('prunes old records instead of growing without bound', () => {
    const small = ledgerMod.createLedger({ file: path.join(dir, 'p.jsonl'), maxRecords: 10 });
    for (let i = 0; i < 25; i++) small.record(call({ model: `m${i}` }));
    const rows = small.read();
    expect(rows.length).toBeLessThanOrEqual(10);
    // Newest survive — a heatmap reads recent history.
    expect(rows[rows.length - 1].model).toBe('m24');
  });
});
