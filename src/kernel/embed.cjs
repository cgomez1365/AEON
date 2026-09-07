/**
 * AEON — embedding, as a kernel service (BO-EMB).
 *
 * §14: a block never names a provider. It asks for the `embed` role and the
 * kernel resolves role → endpoint → model. Before this module the Aeon Matrix
 * called Google's embedding API directly, held its own GEMINI_* key pool and
 * ran its own rotation loop — a vendor named inside a block, and a key path
 * that never passed through the vault.
 *
 * Transports live here because this is the layer allowed to know about them.
 *
 * Contract: resolves to { vector: number[], model: string }. `model` is the
 * RESOLVED model id, not a configured default — the index tags every vector
 * with it, and retrieval refuses to compare across two tags. A wrong tag is an
 * empty search reported as success.
 */
'use strict';

const endpoints = require('./endpoints.cjs');
const { pace, paceKey } = require('./pacing.cjs');

const { EMBED_ROLE } = endpoints;

/** Structured failure — callers render the remedy, never a raw transport error. */
function embedError(code, message, action) {
  const err = new Error(message);
  err.code = code;
  err.embedFailure = true;   // structural, never scraped from message text
  if (action) err.action = action;
  return err;
}

async function embedLocal(text) {
  let lr;
  try { lr = require('../../services/local-runtime/index.cjs'); }
  catch { throw embedError('no_embed_model', 'The local AI engine is not installed.', 'Install it in Cookbook.'); }
  const vector = await lr.embed(text);
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
    throw embedError('embed_failed', 'The local embedding model returned no vector.');
  }
  return Array.from(vector);
}

/** OpenAI-compatible /v1/embeddings — the shape every generic endpoint speaks. */
async function embedOpenAICompatible(text, { base_url, apiKey, model }) {
  const url = `${String(base_url).replace(/\/$/, '')}/embeddings`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input: String(text).slice(0, 8000) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    // The remote body is LOGGED, never propagated.
    //
    // An embed failure message travels: embed.cjs -> retrieve.cjs
    // (`unavailable.message`) -> context.cjs, which renders it inside the
    // [AEON SECOND BRAIN CONTEXT] block wrapped in imperative framing ("Tell
    // the operator this plainly"). Splicing a third party's response body into
    // that string puts bytes from someone else's server into the model's turn,
    // positioned as AEON's own context — a prompt-injection channel that opens
    // the moment an operator points the embed role at an endpoint they do not
    // control, which the README explicitly invites. The gemini transport below
    // already declined to forward the body; the two disagreed about what was
    // safe to pass on.
    const body = (await res.text().catch(() => '')).slice(0, 200);
    if (body) console.warn(`[EMBED] endpoint ${res.status}: ${body.replace(/\s+/g, ' ')}`);
    if (res.status === 401 || res.status === 403) {
      throw embedError('embed_auth', 'This endpoint rejected the key assigned to the Embedding role.', 'Check the key in Settings → Connections.');
    }
    if (res.status === 429) {
      const e = embedError('embed_rate_limited', 'The embedding endpoint is rate limiting this run.', 'Lower the requests-per-minute for this endpoint in Settings → Connections, or install a local embedding model in Cookbook.');
      e.rateLimited = true;
      throw e;
    }
    throw embedError(
      'embed_failed',
      `The embedding endpoint answered ${res.status}.`,
      'Check the endpoint address and key in Settings → Connections, or install a local embedding model in Cookbook. The endpoint\u2019s own message is in the server log.',
    );
  }
  const vector = (await res.json())?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw embedError('embed_failed', 'Embedding endpoint returned no vector.');
  return vector;
}

/** Gemini speaks :embedContent rather than /embeddings. */
async function embedGeminiTransport(text, { base_url, apiKey, model }) {
  const base = String(base_url || endpoints.PROVIDER_TRANSPORT.gemini.base).replace(/\/$/, '');
  const res = await fetch(`${base}/models/${encodeURIComponent(model)}:embedContent`, {
    method: 'POST',
    // The key travels as a header, never in the query string. A key in a URL
    // lands in the target's access log — the exfiltration shape closed 2026-09-06.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey || '' },
    body: JSON.stringify({ content: { parts: [{ text: String(text).slice(0, 8000) }] } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    if (res.status === 429) {
      const e = embedError('embed_rate_limited', 'The embedding endpoint is rate limiting this run.', 'Lower the requests-per-minute for this endpoint in Settings → Connections, or install a local embedding model in Cookbook.');
      e.rateLimited = true;
      throw e;
    }
    throw embedError('embed_failed', `Embedding endpoint returned ${res.status}.`);
  }
  const vector = (await res.json())?.embedding?.values;
  if (!Array.isArray(vector)) throw embedError('embed_failed', 'Embedding endpoint returned no vector.');
  return vector;
}

/**
 * Embed one string using whatever the operator assigned to the `embed` role.
 * @returns {Promise<{vector: number[], model: string, provider: string}>}
 */
/**
 * The task prefix an embedding model expects, if any.
 *
 * nomic-embed-text — the model AEON ships in its catalog — is trained with
 * instruction prefixes and its own card says retrieval quality degrades
 * without them: documents are embedded as `search_document: …` and queries
 * as `search_query: …`. AEON sent neither. Measured live on a 1,473-document
 * corpus: the right file ranked, the right WINDOW of it did not, and nearly
 * every document cleared the similarity floor. Keyed on the model name, not
 * the provider, because the same model served from a hosted endpoint needs
 * the same prefix; other models get none.
 */
function taskPrefix(model, kind) {
  if (!/nomic-embed/i.test(String(model || ''))) return '';
  return kind === 'query' ? 'search_query: ' : 'search_document: ';
}

async function kernelEmbed(text, { supabase = null, kind = 'document' } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw embedError('empty_input', 'Nothing to embed.');
  }

  const r = await endpoints.resolveForRole(EMBED_ROLE, supabase);
  if (!r.ok) {
    throw embedError(
      r.code || 'no_embed_model',
      r.error || 'No embedding model is available.',
      'Install one in Cookbook (about 150 MB, runs on CPU), or assign an endpoint that serves embeddings to the Embedding role in Settings → Model Assignment.',
    );
  }

  const prefix = taskPrefix(r.model, kind);
  const input = prefix + text;
  // A prefixed embedding is a different SPACE from an unprefixed one of the
  // same model (R08: vectors are tagged and never mixed). The tag carries it,
  // so an index built before prefixes existed is migrated rather than compared.
  const space = prefix ? `${r.model}#task` : r.model;

  if (r.provider === 'local') {
    return { vector: await embedLocal(input), model: space, provider: 'local' };
  }

  // Cloud: pace against the SAME per-address budget chat uses, before the call.
  await pace(paceKey(r.base_url, r.provider), r.rpm_limit);

  const style = (endpoints.PROVIDER_TRANSPORT[r.provider] || {}).style || 'openai';
  const vector = style === 'gemini'
    ? await embedGeminiTransport(input, r)
    : await embedOpenAICompatible(input, r);

  return { vector, model: space, provider: r.provider };
}

/** Can embedding run right now? Sync, local registry only — mirrors the badge path. */
function embedReadiness() {
  return endpoints.describeRoleLocal(EMBED_ROLE);
}

module.exports = { kernelEmbed, embedReadiness, embedError, taskPrefix };
