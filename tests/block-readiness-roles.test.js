/**
 * BO-F3a/F3b gate — readiness must reflect ability to serve.
 *
 * checkReadiness() computed readiness from manifest.requires.apis ALONE.
 * Writer leaves that empty while declaring contract.ai.roles ["creative"], so
 * Writer was ALWAYS ready — including when its role pointed at a provider with
 * no model. The operator clicked an AI action on a block the UI called ready
 * and got an error.
 *
 * The line this file defends: role state is reported SEPARATELY from `ready`.
 * memory_core declares role "chat" for its distill route, but /api/memory/add
 * needs no model — saving a memory is a file write. Folding roles into `ready`
 * would mark memory_core not-ready with no provider and break the capability
 * BO-F1 exists to make trustworthy. `ready` = hard requirements. `roles` = which
 * declared AI capabilities can serve. `degraded` = the one-word summary.
 *
 * AEON_SECRETS_DIR is set BEFORE the requires: endpoints.cjs resolves its
 * registry path at module scope, so setting it afterwards would read the
 * operator's real install — the mistake that locked the CEO out on 2026-08-02.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-readiness-'));
process.env.AEON_SECRETS_DIR = tempSecrets;
delete process.env.VERCEL;
delete process.env.AEON_PORTABLE;

const std = require('../src/kernel/blockStandard.cjs');
const endpoints = require('../src/kernel/endpoints.cjs');
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const writerManifest = require('../src/blocks/writer/block.manifest.json');
const memoryManifest = require('../src/blocks/memory_core/block.manifest.json');

const writeRegistry = (reg) => fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
const clearRegistry = () => { try { fs.unlinkSync(REG_FILE); } catch {} };

const groqRegistry = (models = ['llama-3.1-8b-instant']) => ({
  endpoints: [{
    id: 'groq-test', label: 'Groq', kind: 'cloud', provider: 'groq',
    base_url: 'https://api.groq.com/openai/v1', auth_ref: 'groq-test-ref',
    models, reachable_from: ['local', 'cloud'],
  }],
  roles: {},
  updated_at: null,
});

beforeEach(clearRegistry);
afterAll(() => { try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {} });

describe('the manifests this change actually touches', () => {
  it('writer and memory_core are the only blocks declaring AI roles', () => {
    // If a third block starts declaring roles, its reported state changes too —
    // this test is the reminder to go verify it, not a style check.
    const blocksDir = path.join(__dirname, '..', 'src', 'blocks');
    const declaring = fs.readdirSync(blocksDir).filter((id) => {
      try {
        const m = require(path.join(blocksDir, id, 'block.manifest.json'));
        return (m.contract?.ai?.roles || []).length > 0;
      } catch { return false; }
    });
    expect(declaring.sort()).toEqual(['memory_core', 'writer']);
  });

  it('writer declares a creative role and requires no APIs — the exact gap', () => {
    expect(writerManifest.contract.ai.roles).toContain('creative');
    expect(writerManifest.requires?.apis || []).toHaveLength(0);
  });
});

describe('F3a — a declared role with no provider is reported, not hidden', () => {
  it('writer is degraded with a named reason when nothing is configured', () => {
    const r = std.checkReadiness(writerManifest, {});
    expect(r.degraded).toBe(true);
    expect(r.roles.creative.ready).toBe(false);
    expect(r.roles.creative.reason).toBe('no_providers_configured');
  });

  it('writer is NOT degraded once a provider with a model exists', () => {
    writeRegistry(groqRegistry());
    const r = std.checkReadiness(writerManifest, {});
    expect(r.degraded).toBe(false);
    expect(r.roles.creative.ready).toBe(true);
    expect(r.roles.creative.provider).toBe('groq');
    expect(r.roles.creative.model).toBeTruthy();
  });

  it('an endpoint carrying no models cannot satisfy a role', () => {
    writeRegistry(groqRegistry([]));
    const r = std.checkReadiness(writerManifest, {});
    expect(r.roles.creative.ready).toBe(false);
    expect(r.roles.creative.reason).toBe('no_model_on_endpoint');
  });

  it('an explicit role mapping pointing at a missing endpoint is named', () => {
    const reg = groqRegistry();
    reg.roles = { creative: { endpoint_id: 'deleted-endpoint', model: 'some-model' } };
    writeRegistry(reg);
    const r = std.checkReadiness(writerManifest, {});
    expect(r.roles.creative.ready).toBe(false);
    expect(r.roles.creative.reason).toBe('endpoint_missing');
  });
});

// ── THE LINE THIS CHANGE MUST NOT CROSS ─────────────────────────────────────
describe('F3a — role state must not break non-AI capabilities', () => {
  it('memory_core stays ready with no provider, because saving needs no model', () => {
    const r = std.checkReadiness(memoryManifest, {});
    expect(r.ready).toBe(true);          // /api/memory/add still mounts and works
    expect(r.degraded).toBe(true);       // but distill cannot serve, and says so
    expect(r.roles.chat.ready).toBe(false);
  });

  it('writer stays ready too — the block mounts, only the AI capability is down', () => {
    expect(std.checkReadiness(writerManifest, {}).ready).toBe(true);
  });

  it('blocks declaring no roles are entirely unaffected', () => {
    const settings = require('../src/blocks/settings/block.manifest.json');
    const r = std.checkReadiness(settings, process.env);
    expect(r.roles).toBeNull();
    expect(r.degraded).toBe(false);
  });

  it('readiness keeps its original keys, so existing callers still work', () => {
    const r = std.checkReadiness(writerManifest, {});
    expect(r).toHaveProperty('ready');
    expect(r).toHaveProperty('missingApis');
    expect(r).toHaveProperty('localMissing');
    expect(Array.isArray(r.missingApis)).toBe(true);
  });
});

describe('describeRoleLocal — the sync resolver readiness depends on', () => {
  it('reports no_providers_configured on a fresh install', () => {
    expect(endpoints.describeRoleLocal('creative')).toEqual({
      ok: false, reason: 'no_providers_configured',
    });
  });

  it('falls back to the chat mapping for an unmapped role, as the router does', () => {
    const reg = groqRegistry(['llama-3.1-8b-instant']);
    reg.roles = { chat: { endpoint_id: 'groq-test', model: 'llama-3.1-8b-instant' } };
    writeRegistry(reg);
    const r = endpoints.describeRoleLocal('creative');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('llama-3.1-8b-instant');
  });

  // BO-A5b — found in the operator's own restored registry, not invented.
  // Three roles were assigned models a GROQ endpoint does not serve
  // (qwen3-1.7b-q4, qwen3-4b-q4, gemini-2.5-flash) and readiness reported
  // ok:true for every one. The router would have 404'd on the first call.
  // Stale assignments are normal — they survive a provider being re-pointed, a
  // model being retired, or a config restored from another machine. Reporting
  // them is the fix, not preventing them.
  it('refuses a role assigned a model the endpoint does not serve', () => {
    const reg = groqRegistry(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    reg.roles = { creative: { endpoint_id: 'groq-test', model: 'qwen3-4b-q4' } };
    writeRegistry(reg);

    const r = endpoints.describeRoleLocal('creative');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('model_not_on_endpoint');
    // The error must name the remedy, not just the fault (BO-F3's rule).
    expect(r.detail).toMatch(/Settings/);
    expect(r.detail).toMatch(/qwen3-4b-q4/);
  });

  it('stays permissive when the endpoint has no discovered model list', () => {
    // An empty models[] means discovery never ran, not that the endpoint
    // serves nothing. Failing closed there would report every fresh install as
    // broken — a worse lie than the one being fixed.
    const reg = groqRegistry([]);
    reg.roles = { creative: { endpoint_id: 'groq-test', model: 'anything-at-all' } };
    writeRegistry(reg);

    const r = endpoints.describeRoleLocal('creative');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('anything-at-all');
  });

  it('accepts a role whose model IS on the endpoint', () => {
    const reg = groqRegistry(['llama-3.3-70b-versatile']);
    reg.roles = { creative: { endpoint_id: 'groq-test', model: 'llama-3.3-70b-versatile' } };
    writeRegistry(reg);
    expect(endpoints.describeRoleLocal('creative').ok).toBe(true);
  });

  it('auto-picks the preferred chat model when the prefer pattern matches', () => {
    writeRegistry(groqRegistry(['whisper-large-v3', 'llama-3.3-70b-versatile']));
    const r = endpoints.describeRoleLocal('creative');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('llama-3.3-70b-versatile'); // not the transcription model
  });

  // FLIPPED BY BO-A4. This test previously pinned a known defect: the prefer
  // pattern was an allow-list that `llama-3.1-8b-instant` did not match
  // ("instant", not "instruct"), so auto-pick handed the chat role the
  // transcription model at the head of the list. describeRoleLocal mirrored
  // the router's mistake on purpose, and the comment said this test flips when
  // BOTH are fixed. Both are fixed — one shared pickChatModel() predicate,
  // deny-list rather than allow-list.
  it('skips a transcription model to reach a chat model the old allow-list missed', () => {
    writeRegistry(groqRegistry(['whisper-large-v3', 'llama-3.1-8b-instant']));
    expect(endpoints.describeRoleLocal('creative').model).toBe('llama-3.1-8b-instant');
  });

  it('the badge and the router share one predicate, so they cannot disagree', () => {
    // Both call sites in endpoints.cjs must go through pickChatModel. Fixing
    // one alone is what makes the badge promise what the router will not
    // deliver (BO-F3's defect class).
    const src = fs.readFileSync(
      require.resolve('../src/kernel/endpoints.cjs'), 'utf8');
    const calls = src.match(/pickChatModel\(candidate\.models\)/g) || [];
    expect(calls.length, 'resolveForRole and describeRoleLocal must both use it').toBe(2);
    // And the old allow-list must be gone from the CODE, not merely bypassed.
    // Comments are stripped first — the fix documents the old pattern by
    // quoting it, and a naive scan would match that explanation.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/versatile\|instruct/);
  });

  it('picks a chat model regardless of list ordering — no ordering luck', () => {
    const { pickChatModel } = endpoints;
    expect(pickChatModel(['whisper-large-v3', 'llama-3.1-8b-instant'])).toBe('llama-3.1-8b-instant');
    expect(pickChatModel(['llama-guard-4-12b', 'llama-3.1-8b-instant'])).toBe('llama-3.1-8b-instant');
    expect(pickChatModel(['text-embedding-3-small', 'gpt-4o'])).toBe('gpt-4o');
    expect(pickChatModel(['whisper-large-v3', 'llama-3.3-70b-versatile'])).toBe('llama-3.3-70b-versatile');
  });

  it('treats an unknown model name as chat-capable rather than skipping it', () => {
    // A new chat model must work the day it ships. The failure mode of a
    // wrong guess here is a visible bad answer, not a silently skipped model.
    expect(endpoints.pickChatModel(['some-brand-new-model-2027'])).toBe('some-brand-new-model-2027');
    expect(endpoints.pickChatModel(['whisper-large-v3', 'brand-new-2027'])).toBe('brand-new-2027');
  });

  it('falls back to the first model rather than reporting none when all look non-chat', () => {
    // Reporting "no model" for an endpoint that HAS models would be a worse
    // lie than offering an imperfect one.
    expect(endpoints.pickChatModel(['whisper-large-v3'])).toBe('whisper-large-v3');
    expect(endpoints.pickChatModel([])).toBe(null);
    expect(endpoints.pickChatModel(null)).toBe(null);
  });

  it('never throws on a corrupt registry — an unreadable file is not configured', () => {
    fs.writeFileSync(REG_FILE, '{ not json');
    expect(() => endpoints.describeRoleLocal('creative')).not.toThrow();
    expect(endpoints.describeRoleLocal('creative').ok).toBe(false);
  });
});
