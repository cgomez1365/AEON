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

// ── Lightweight local embeddings (native runtime) ─────────────────────────
const EMBED_MODEL = process.env.AEON_EMBED_MODEL || 'nomic-embed-text-q8';

async function embedLocal(text) {
  const lr = require('../../../../services/local-runtime/index.cjs');
  return lr.embed(text);
}

// ── API-key embedding fallback (Gemini text-embedding-004) ───────────────
// Same key pool the kernel uses (vault-hydrated at boot). Rotates on 429.
// IMPORTANT: vectors from different models live in different spaces —
// callers must only compare embeddings tagged with the same model name.
function getGeminiKeys() {
  // Unbounded: GEMINI_PAID_KEY, GEMINI_API_KEY, GEMINI_FREE_KEY_1..N.
  const keys = [process.env.GEMINI_PAID_KEY, process.env.GEMINI_API_KEY];
  Object.keys(process.env)
    .filter(n => /^GEMINI_FREE_KEY_\d+$/.test(n))
    .sort((a, b) => Number(a.slice(16)) - Number(b.slice(16)))
    .forEach(n => keys.push(process.env[n]));
  return [...new Set(keys.filter(Boolean))];
}

async function embedGemini(text) {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('no Gemini keys configured');
  for (const key of keys) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: String(text).slice(0, 8000) }] } }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const values = (await r.json())?.embedding?.values;
        if (Array.isArray(values)) return values;
      } else if (r.status !== 429) {
        console.warn(`[EMBED] Gemini embed error ${r.status}`);
      }
      // 429 → try next key
    } catch (e) { console.warn(`[EMBED] Gemini key ***${key.slice(-4)} failed:`, e.message); }
  }
  throw new Error('all Gemini keys exhausted for embedding');
}

// Work-with-what-you-have embedder: native local runtime first (free, private),
// Gemini API fallback when native runtime has no embed model.
async function embed(text) {
  try {
    const vector = await embedLocal(text);
    return { vector, model: EMBED_MODEL };
  } catch (e) {
    const vector = await embedGemini(text);
    return { vector, model: 'text-embedding-004' };
  }
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

module.exports = { loadExtractors, extractText, embedLocal, embedGemini, embed, cosineSimilarity, EMBED_MODEL };
