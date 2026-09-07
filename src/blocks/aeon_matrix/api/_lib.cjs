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
  if (ext === '.html' || ext === '.htm') return htmlToText(fs.readFileSync(fullPath, 'utf8'));
  return fs.readFileSync(fullPath, 'utf8');
}

/**
 * HTML to readable text. Deterministic on purpose: chunk offsets are recorded
 * against THIS output at index time and re-derived from it at query time, so
 * the same file must always produce the same string.
 *
 * BO-CHUNK. The Bible, the doctrine and every EOD report are .html, and the
 * indexer's extension list did not include it — the operator's most important
 * documents were invisible to the Second Brain. Found live on a 1,612-file
 * corpus: 211 files never indexed, and a question the Bible answers came back
 * "I cannot determine the answer based on the provided documents".
 */
function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|figcaption|header|footer|table|ul|ol|dd|dt)>/gi, '\n\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
       .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
       .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
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

module.exports = { loadExtractors, extractText, htmlToText, embed, cosineSimilarity, EMBED_MODEL };
