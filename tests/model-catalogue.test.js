/**
 * The model catalogue reaches the operator WHOLE, and free models come first.
 *
 * Two regressions this pins:
 *
 *   1. Every branch of /api/settings/test-provider used to end in
 *      `.slice(0, 20|30|40)`. The picker has no cap of its own, so the cap cut
 *      the catalogue before the operator's search ran: filtering OpenRouter for
 *      "free" showed five models out of the twenty-one it publishes, because
 *      only five of the first forty rows were free.
 *
 *   2. Free-first ordering must come from the provider's PRICE, not from the
 *      ":free" suffix. The suffix misses zero-priced models that do not carry
 *      it, and would be fooled by a paid model with "free" in its name.
 *
 * Both fixtures below are deliberately LARGER than the old caps, so restoring a
 * slice turns this file red rather than passing by luck.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The picker's search predicate. ESM, so it imports directly — that is the
// whole point of extracting it: vitest.config.js sets environment:'node' and
// the suite has neither jsdom nor testing-library, so a predicate left inside
// ModelPicker would be a predicate nothing could test.
import { matchesModelQuery } from '../src/kernel/modelQuery.js';

const require = createRequire(import.meta.url);

// Same reason as tests/settings-service.js: SECRETS_DIR is resolved once at
// module scope, so it must be redirected BEFORE the kernel is required.
const SECRETS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-catalogue-secrets-'));
process.env.AEON_SECRETS_DIR = SECRETS_TMP;

const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

// Old caps: groq 20, openai 30, openrouter 40. Every fixture clears all three.
const CATALOGUE_SIZE = 120;

/** A stubbed OpenRouter catalogue: mostly paid, with free models scattered
 *  through it — never bunched at the front, so a passing sort has to have
 *  actually moved them. */
function openRouterCatalogue() {
  const rows = [];
  for (let i = 0; i < CATALOGUE_SIZE; i++) {
    const free = i % 9 === 4;             // 13 of 120, none in the first four
    rows.push({
      id: free ? `vendor/model-${i}:free` : `vendor/model-${i}`,
      pricing: free
        ? { prompt: '0', completion: '0' }
        : { prompt: '0.0000005', completion: '0.0000015' },
    });
  }
  // The two cases the ":free" suffix gets wrong, both real shapes from the
  // live catalogue (openrouter/free is zero-priced without the suffix).
  rows.push({ id: 'vendor/zero-priced-no-suffix', pricing: { prompt: '0', completion: '0' } });
  rows.push({ id: 'vendor/free-tier-trial', pricing: { prompt: '0.000002', completion: '0.000004' } });
  // A row with no pricing at all: unknown is not free.
  rows.push({ id: 'vendor/unpriced' });
  return rows;
}

function groqCatalogue() {
  return Array.from({ length: CATALOGUE_SIZE }, (_, i) => ({ id: `groq-model-${String(i).padStart(3, '0')}` }));
}

describe('provider model catalogue', () => {
  let server;
  let base;
  let realFetch;
  let previousKeys;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountSettingsApi(app, { supabase: null });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => { if (server) server.close(); });

  beforeEach(() => {
    previousKeys = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    };
    process.env.OPENROUTER_API_KEY = 'test-only-not-a-real-key';
    process.env.GROQ_API_KEY = 'test-only-not-a-real-key';

    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      // The test drives the route over a real socket; only the OUTBOUND
      // provider calls are stubbed.
      if (href.startsWith(base)) return realFetch(url, init);
      if (href.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: openRouterCatalogue() }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (href.includes('api.groq.com')) {
        return new Response(JSON.stringify({ data: groqCatalogue() }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected outbound fetch in test: ${href}`);
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(previousKeys)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const probe = async (id) => {
    const r = await realFetch(`${base}/api/settings/test-provider/${id}`, { method: 'POST' });
    return r.json();
  };

  it('returns the whole OpenRouter catalogue, not the first page of it', async () => {
    const body = await probe('openrouter');
    const sent = openRouterCatalogue();

    expect(body.ok).toBe(true);
    // Fails the moment a slice comes back: the old cap was 40.
    expect(body.models).toHaveLength(sent.length);
    expect(new Set(body.models)).toEqual(new Set(sent.map(m => m.id)));
    // And the last model sent is reachable, which a cap makes impossible.
    expect(body.models).toContain('vendor/unpriced');
  });

  it('sorts zero-priced models ahead of priced ones', async () => {
    const body = await probe('openrouter');
    const sent = openRouterCatalogue();
    const freeIds = sent
      .filter(m => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .map(m => m.id);

    expect(freeIds.length).toBeGreaterThan(5);
    // Every free model occupies the front of the list, in one block.
    expect(body.models.slice(0, freeIds.length).sort()).toEqual([...freeIds].sort());
    // Fails if the sort is removed: unsorted, index 4 is the first free one.
    expect(body.models[0]).not.toBe(sent[0].id);
  });

  it('decides free from the price, not from the name', async () => {
    const body = await probe('openrouter');

    // Zero-priced without the ":free" suffix — the suffix match would miss it.
    expect(body.free).toContain('vendor/zero-priced-no-suffix');
    expect(body.models.indexOf('vendor/zero-priced-no-suffix'))
      .toBeLessThan(body.models.indexOf('vendor/model-0'));

    // Priced, despite "free" in the id — a name match would promote it.
    expect(body.free).not.toContain('vendor/free-tier-trial');

    // No pricing at all is unknown, and unknown is not free.
    expect(body.free).not.toContain('vendor/unpriced');
  });

  it('sends no free flags for a provider that publishes no prices', async () => {
    const body = await probe('groq');

    expect(body.ok).toBe(true);
    expect(body.models).toHaveLength(CATALOGUE_SIZE); // old cap was 20
    // Groq's model list says nothing about price — free there is a property of
    // the KEY. Inventing a flag would be a badge that reads "free" off the
    // account tier, which is the class of lie this repo treats as a defect.
    expect(body.free).toBeUndefined();
  });
});


describe('free is a price the provider stated, not a coercion accident', () => {
  // These shapes never reach Number() in the live catalogue — all 445 rows
  // carry non-empty price strings — so this is a latent fault, pinned here
  // before it stops being latent. Number(null), Number(''), Number([]) and
  // Number(false) are every one of them 0, and every one of them finite, so a
  // plain Number() coercion reports all four as FREE and sorts them to the
  // front of the operator's list.
  const { isFreeModelRow } = require('../src/kernel/modelCatalogue.cjs');

  it('treats a blank or non-scalar price as unknown, and unknown as not free', () => {
    for (const blank of [null, '', '   ', [], false, undefined, {}, NaN, Infinity]) {
      expect(isFreeModelRow({ pricing: { prompt: blank, completion: blank } }))
        .toBe(false);
    }
    // One side stated, one side blank, is still unknown.
    expect(isFreeModelRow({ pricing: { prompt: '0', completion: null } })).toBe(false);
    expect(isFreeModelRow({ pricing: { prompt: null, completion: '0' } })).toBe(false);
  });

  it('reads every spelling of zero OpenRouter actually sends', () => {
    for (const zero of ['0', '0.0', '0.00000000', '0e0', 0]) {
      expect(isFreeModelRow({ pricing: { prompt: zero, completion: zero } }))
        .toBe(true);
    }
  });

  it('does not round a real price down to free', () => {
    expect(isFreeModelRow({ pricing: { prompt: '1e-7', completion: '0' } })).toBe(false);
    expect(isFreeModelRow({ pricing: { prompt: '0', completion: '0.0000015' } })).toBe(false);
  });

  it('answers false for a row with no pricing key at all', () => {
    expect(isFreeModelRow({ id: 'vendor/unpriced' })).toBe(false);
    expect(isFreeModelRow({ id: 'x', pricing: null })).toBe(false);
    expect(isFreeModelRow(null)).toBe(false);
  });
});

describe('searching the picker for "free"', () => {
  // The operator's literal ask: filter for "free" and see the free models.
  // The server sorts them to the front; this is the half they type at.
  const freeSet = new Set(['vendor/zero-priced-no-suffix', 'vendor/model-4:free']);

  it('matches a zero-priced model whose id never says "free"', () => {
    expect(matchesModelQuery('vendor/zero-priced-no-suffix', 'free', freeSet)).toBe(true);
    // And on every prefix of the word, so it matches while still being typed.
    for (const q of ['f', 'fr', 'fre', 'free', 'FREE']) {
      expect(matchesModelQuery('vendor/zero-priced-no-suffix', q, freeSet)).toBe(true);
    }
  });

  it('does not invent a free model out of a priced one', () => {
    // Not in freeSet, and its id does not contain the query.
    expect(matchesModelQuery('vendor/model-0', 'free', freeSet)).toBe(false);
    // With no free list at all — a provider that publishes no prices — the
    // query falls through to the id, and nothing is promoted.
    expect(matchesModelQuery('vendor/model-0', 'free', undefined)).toBe(false);
    expect(matchesModelQuery('vendor/model-0', 'free', new Set())).toBe(false);
  });

  it('still matches a priced model that genuinely has "free" in its id', () => {
    // Rule 1 is a plain substring match and is untouched: the operator asked
    // for it by name, so they get it — it is just no longer the ONLY rule.
    expect(matchesModelQuery('vendor/free-tier-trial', 'free', freeSet)).toBe(true);
  });

  it('only extends the match to a PREFIX of "free"', () => {
    // An id with none of f/r/e in it, so ONLY the free rule can match it and
    // the plain substring rule cannot muddy the result.
    const id = 'x/zap-001';
    const only = new Set([id]);
    expect(matchesModelQuery(id, 'f', only)).toBe(true);
    // Otherwise every free model would answer to "ee", "ree" and "reef".
    for (const q of ['ee', 'ree', 'reef', 'freee']) {
      expect(matchesModelQuery(id, q, only)).toBe(false);
    }
  });

  it('matches everything on an empty query', () => {
    for (const q of ['', '   ', null, undefined]) {
      expect(matchesModelQuery('vendor/model-0', q, freeSet)).toBe(true);
      expect(matchesModelQuery('vendor/zero-priced-no-suffix', q, freeSet)).toBe(true);
    }
  });

  it('keeps free-first order through the filter', () => {
    // The picker filters the array the server ordered; filtering preserves
    // order, so what the operator sees after typing is still free-first.
    const ordered = ['vendor/model-4:free', 'vendor/zero-priced-no-suffix', 'vendor/free-tier-trial'];
    const shown = ordered.filter(m => matchesModelQuery(m, 'free', freeSet));
    expect(shown).toEqual(ordered);
    expect(shown.slice(0, 2).every(m => freeSet.has(m))).toBe(true);
  });
});

describe('the catalogue behind "Get model list"', () => {
  // /api/connections/discover — the OTHER model picker. It used to return
  // endpoints.discoverModels' flat id array in the provider's raw order, with
  // no prices, because the id and the price were read in the same map() and
  // only the id survived it. The connection form then auto-selected models[0],
  // which on OpenRouter is a paid model every time.
  const endpoints = require('../src/kernel/endpoints.cjs');

  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: openRouterCatalogue() }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('keeps the price alive long enough to sort by it', async () => {
    const found = await endpoints.discoverModelCatalogue('openrouter', undefined, 'test-only-not-a-real-key');
    const sent = openRouterCatalogue();

    expect(found.error).toBeUndefined();
    // Whole catalogue: discovery never had a cap, and must not grow one.
    expect(found.models).toHaveLength(sent.length);
    // Free models exist, and every one of them is at the front.
    expect(found.free.length).toBeGreaterThan(5);
    expect(found.models.slice(0, found.free.length).sort()).toEqual([...found.free].sort());
    // Decided by price, not by name — both directions.
    expect(found.free).toContain('vendor/zero-priced-no-suffix');
    expect(found.free).not.toContain('vendor/free-tier-trial');
    expect(found.free).not.toContain('vendor/unpriced');
  });

  it('auto-selects a free model on the connection form', async () => {
    // The form does `selectedModel: d.models[0]`. That is the whole fix, seen
    // from where the operator stands.
    const found = await endpoints.discoverModelCatalogue('openrouter', undefined, 'test-only-not-a-real-key');
    expect(found.free).toContain(found.models[0]);
    // Unsorted, index 0 is the paid row the provider happened to send first.
    expect(found.models[0]).not.toBe(openRouterCatalogue()[0].id);
  });

  it('every free id is one the picker can actually match', async () => {
    // `free` and `models` must be the SAME normalized strings, or the picker's
    // Set lookup silently matches nothing and no badge is ever drawn.
    const found = await endpoints.discoverModelCatalogue('openrouter', undefined, 'test-only-not-a-real-key');
    const freeSet = new Set(found.free);
    for (const id of found.free) expect(found.models).toContain(id);
    expect(found.models.filter(m => matchesModelQuery(m, 'free', freeSet)).length)
      .toBeGreaterThanOrEqual(found.free.length);
  });

  it('still hands older callers the bare id array, in the new order', async () => {
    // model-scan's detect and scan-all, and the auto-discovery inside
    // POST /api/connections, all do `Array.isArray(models)`. scan-all upserts
    // this array back into the registry, so the STORED order is free-first too.
    const ids = await endpoints.discoverModels('openrouter', undefined, 'test-only-not-a-real-key');
    const found = await endpoints.discoverModelCatalogue('openrouter', undefined, 'test-only-not-a-real-key');
    expect(Array.isArray(ids)).toBe(true);
    expect(ids).toEqual(found.models);
  });
});
