/**
 * Second Brain — shared helpers for ingest.cjs and retrieve.cjs.
 * Leading underscore keeps the block auto-loader from mounting this as a route.
 */
const path = require('path');
const fs   = require('fs');

let pdfParse = null, mammoth = null;
function loadExtractors() {
  if (pdfParse || mammoth) return;
  try { pdfParse = require('pdf-parse'); } catch { /* PDF support unavailable */ }
  try { mammoth = require('mammoth'); } catch { /* DOCX support unavailable */ }
}

async function extractText(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.pdf') {
    if (!pdfParse) return null;
    const data = await pdfParse(fs.readFileSync(fullPath));
    return data.text;
  }
  if (ext === '.docx') {
    if (!mammoth) return null;
    const result = await mammoth.extractRawText({ path: fullPath });
    return result.value;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

// ── Embedding — resolved by the kernel, never by this block ───────────────
//
// BO-EMB. This file used to hold a second embedder: it named one vendor's
// embedding API, read that vendor's keys straight out of the environment, and
// ran its own rotation loop. That is a block naming a provider (§14) and a key
// path that never passed through the vault.
//
// The block now asks for the `embed` role. Which model serves it — a local
// GGUF, a hosted OpenAI-compatible endpoint, anything else the operator
// connects — is the kernel's decision and the operator's choice.
const { kernelEmbed } = require('../../../kernel/embed.cjs');

// Legacy tag only. Documents indexed before vectors carried an embeddingModel
// were embedded by the native local runtime, and retrieve.cjs reads this as
// their implied tag. It is NOT a default embedder and nothing selects a model
// from it.
const EMBED_MODEL = process.env.AEON_EMBED_MODEL || 'nomic-embed-text-q8';

/**
 * Embed one string.
 * @returns {Promise<{vector: number[], model: string}>} `model` is the model
 * the kernel actually used, so the caller can tag the vector with its space.
 */
async function embed(text) {
  const { vector, model } = await kernelEmbed(text);
  return { vector, model };
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

module.exports = { loadExtractors, extractText, embed, cosineSimilarity, EMBED_MODEL };
