/**
 * BO-D1a, at the seam that actually serves the operator.
 *
 * FOUND DOUBLE-CHECKING THE D1 BUILD (2026-08-05). D1a replaced the
 * hardcoded 512 in services/local-runtime/index.cjs and proved it against
 * ServerSession. Both true, and both beside the point: services/ai.js:307
 * passed `maxTokens: opts.max_tokens || 512` on the way in. An explicit 512
 * is a ceiling, and a ceiling wins over a derived budget — so /api/ai, the
 * kernel route, still capped every answer at 512 tokens.
 *
 * The original gate could not have caught this. It drove ServerSession
 * directly and never crossed the seam where the constant lived. That is the
 * same error as D2f — BO-C was verified on :3000 and chat was broken on
 * :3001, the path anyone actually uses.
 *
 * So this gate drives services/ai.js itself and asserts on what reaches the
 * runtime, because that is the boundary the defect hid behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AI_PATH = path.join(ROOT, 'services', 'ai.js');
const LR_PATH = path.join(ROOT, 'services', 'local-runtime', 'index.cjs');

/**
 * Swap the local runtime for a recorder, build a fresh services/ai.js
 * against it, and hand back what the runtime was asked for.
 */
function aiWithRecordedRuntime() {
  const calls = [];
  const stub = {
    isAvailable: () => true,
    defaultModel: () => 'stub-model',
    listReadyModels: () => [{ id: 'stub-model' }],
    status: () => ({ ready: true, readyModels: [{ id: 'stub-model' }] }),
    plannedContext: async () => ({ contextTokens: 32768 }),
    cancelAll: () => 0,
    infer: async (prompt, opts) => {
      calls.push(opts);
      return { text: 'ok', tokens: 5, model: 'stub-model', latencyMs: 1, complete: true };
    },
    inferStream: async (prompt, opts, onToken) => {
      calls.push(opts);
      onToken?.('ok');
      return { text: 'ok', tokens: 5, model: 'stub-model', complete: true };
    },
  };

  delete require.cache[AI_PATH];
  const prevLr = require.cache[LR_PATH];
  require.cache[LR_PATH] = { id: LR_PATH, filename: LR_PATH, loaded: true, exports: stub };

  const ai = require(AI_PATH)({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(ROOT, 'db', 'token_ledger.json'),
    loadSettings: () => ({ models: { chat: { provider: 'local', model: 'stub-model' } }, prefs: {} }),
    aeonTerminalStream: null,
  });

  return {
    ai,
    calls,
    restore() {
      delete require.cache[AI_PATH];
      if (prevLr) require.cache[LR_PATH] = prevLr; else delete require.cache[LR_PATH];
    },
  };
}

let h = null;
afterEach(() => { h?.restore(); h = null; });

describe('/api/ai local path — the budget must survive the seam', () => {
  it('does not impose a 512-token ceiling when the caller asked for nothing', () => {
    h = aiWithRecordedRuntime();
    return h.ai.localNativeRequest('write me a long document', 'stub-model', {}).then(() => {
      expect(h.calls).toHaveLength(1);
      const asked = h.calls[0].maxTokens ?? h.calls[0].max_tokens;
      // The defect: this was exactly 512, so every /api/ai answer was capped
      // regardless of the window the model was actually serving.
      expect(asked).not.toBe(512);
      // Nothing at all is the correct value — it means "derive it from the
      // window", which is the only number correct for every prompt size.
      expect(asked).toBeUndefined();
    });
  });

  it('still forwards an explicit caller ceiling unchanged', async () => {
    h = aiWithRecordedRuntime();
    await h.ai.localNativeRequest('summarise this', 'stub-model', { max_tokens: 2048 });
    const asked = h.calls[0].maxTokens ?? h.calls[0].max_tokens;
    expect(asked).toBe(2048);
  });

  it('forwards a small explicit ceiling without inflating it', async () => {
    // tools/autopilot-daemon.cjs asks for 30. It must get 30.
    h = aiWithRecordedRuntime();
    await h.ai.localNativeRequest('ping', 'stub-model', { max_tokens: 30 });
    const asked = h.calls[0].maxTokens ?? h.calls[0].max_tokens;
    expect(asked).toBe(30);
  });
});
