/**
 * B1 — Build Envelope. Four sources, one shape. The rest of the pipeline
 * (gate → staging → promote) never knows or cares where code came from;
 * only `trust` differs, and paste gets zero trust bonus (most scrutiny).
 *
 * Envelope shape (frozen with schema 1.0.0):
 * {
 *   envelopeVersion: '1.0.0',
 *   source: 'kernelLLM' | 'userKey' | 'local' | 'paste',
 *   trust:  'system'    | 'user'    | 'local' | 'untrusted',
 *   spec:   string,                 // the natural-language build request
 *   manifest: object,               // proposed block.manifest.json
 *   files: [{ path, content }],     // proposed block files, paths relative to block root
 *   estimatedDailyCost: number,     // USD/day the block is expected to burn
 *   receivedAt: ISO string,
 *   meta: {}                        // adapter-specific (model id, key ref, etc.) — never raw keys
 * }
 */

const ENVELOPE_VERSION = '1.0.0';

function baseEnvelope(source, trust, { spec, manifest, files, estimatedDailyCost, meta }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('envelope requires a proposed manifest');
  if (!Array.isArray(files)) throw new Error('envelope requires files[]');
  for (const f of files) {
    if (!f.path || typeof f.content !== 'string') throw new Error('each file needs { path, content }');
  }
  return {
    envelopeVersion: ENVELOPE_VERSION,
    source, trust,
    spec: spec || '',
    manifest,
    files,
    estimatedDailyCost: Number(estimatedDailyCost) || 0,
    receivedAt: new Date().toISOString(),
    meta: { ...(meta || {}) },
  };
}

// The four adapters. Identical output shape — that IS the B1 exit criterion.
const adapters = {
  // Built-in kernelLLM — response already envelope-shaped by our own prompt contract.
  kernelLLM: (p) => baseEnvelope('kernelLLM', 'system', p),

  // User's own API key (vault ref only — never a raw key in the envelope).
  userKey: (p) => {
    const meta = { ...(p.meta || {}) };
    for (const k of Object.keys(meta)) {
      if (/key|secret|token/i.test(k) && typeof meta[k] === 'string' && meta[k].length > 12 && !meta[k].startsWith('vault:')) {
        throw new Error(`userKey adapter: meta.${k} looks like a raw credential — pass a vault: ref instead`);
      }
    }
    return baseEnvelope('userKey', 'user', { ...p, meta });
  },

  // Local model (Ollama) — only source permitted to have read retrieval history.
  local: (p) => baseEnvelope('local', 'local', p),

  // Pasted from an external session. Zero trust bonus — least verified, most scrutiny.
  paste: (p) => baseEnvelope('paste', 'untrusted', { ...p, meta: { ...(p.meta || {}), tag: 'build:paste' } }),

  // BGI Store cartridge (S1, Month 5). No special trust for store blocks —
  // same zero bonus as paste; a marketplace zip is still someone else's code.
  store: (p) => baseEnvelope('store', 'untrusted', { ...p, meta: { ...(p.meta || {}), tag: 'build:store' } }),
};

function normalize(source, payload) {
  const adapter = adapters[source];
  if (!adapter) throw new Error(`unknown build source "${source}" — expected kernelLLM|userKey|local|paste|store`);
  return adapter(payload);
}

module.exports = { normalize, ENVELOPE_VERSION, SOURCES: Object.keys(adapters) };
