/**
 * BO-H3a — ask HuggingFace whether a repo actually contains weights this
 * runtime can open, BEFORE a download starts.
 *
 * On 2026-08-08 an operator installed `Qwen/Qwen3-14B` from the browse list.
 * It fetched 18 files, wrote five .incomplete safetensors blobs, exited 1, and
 * reported DOWNLOAD_FAILED with the cause buried under two pages of unrelated
 * huggingface_hub warnings. No setting, no retry and no better hardware would
 * have helped: llama.cpp reads GGUF, and that repo publishes safetensors. It
 * could never have worked, and AEON started it anyway.
 *
 * The judgement already existed — index.cjs decides `servable` from exactly
 * this fact — but it ran AFTER install, to explain a model that was already on
 * disk. This is the same question asked early enough to be useful.
 *
 * FAILS OPEN, deliberately. If the HF API is unreachable, rate-limited or
 * returns something unexpected, this returns `{ ok: false }` and the caller
 * proceeds. A probe that cannot answer must not become a refusal — turning a
 * network blip into "you may not install this" would be a worse defect than
 * the one it prevents.
 */
const https = require('https');

const API_TIMEOUT_MS = 8000;

/** GET a HuggingFace API path, resolving null on any failure. Never throws. */
function hfGet(pathname, hfToken) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'AEON-Cookbook' };
    // A token raises the rate limit and unlocks gated repos the operator has
    // accepted. Optional everywhere — an anonymous probe is still useful.
    if (hfToken) headers.Authorization = `Bearer ${hfToken}`;

    const req = https.get(`https://huggingface.co${pathname}`, { timeout: API_TIMEOUT_MS, headers }, (r) => {
      // 401/403 on a gated repo is not "no GGUF" — it is "we were not allowed
      // to look". Treat it as unknown so the caller still proceeds.
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
  });
}

const isGguf = (name) => typeof name === 'string' && name.toLowerCase().endsWith('.gguf');

/**
 * Look for a GGUF build of the same model, so a refusal can name the thing
 * that WOULD work instead of just saying no. Qwen/Qwen3-14B → Qwen3-14B-GGUF.
 */
async function findGgufAlternative(repoId, hfToken) {
  const short = String(repoId).split('/').pop();
  if (!short) return null;
  const results = await hfGet(`/api/models?search=${encodeURIComponent(short)}-GGUF&limit=8`, hfToken);
  if (!Array.isArray(results)) return null;

  const wanted = `${short}-gguf`.toLowerCase();
  let best = null;
  for (const entry of results) {
    const id = entry.modelId || entry.id;
    if (!id) continue;
    const tail = String(id).split('/').pop().toLowerCase();
    // Exact name match wins; otherwise keep the most-downloaded near match.
    if (tail === wanted) return id;
    if (tail.includes(short.toLowerCase()) && tail.includes('gguf')) {
      if (!best || (entry.downloads || 0) > best.downloads) best = { id, downloads: entry.downloads || 0 };
    }
  }
  return best ? best.id : null;
}

/**
 * @returns {Promise<{ok:boolean, hasGguf?:boolean, ggufFiles?:string[], suggestion?:string|null, reason?:string}>}
 *   ok:false  → could not determine. CALLER MUST PROCEED.
 *   ok:true, hasGguf:true  → safe to download.
 *   ok:true, hasGguf:false → refuse, and suggest `suggestion` if present.
 */
async function ggufProbe(repoId, hfToken) {
  if (!repoId || typeof repoId !== 'string') return { ok: false, reason: 'no repo id' };

  const info = await hfGet(`/api/models/${repoId}`, hfToken);
  if (!info) return { ok: false, reason: 'HuggingFace API unreachable or repo not visible' };

  // `siblings` is the file listing. Absent on some responses — that is unknown,
  // not empty, and the difference matters: treating a missing list as "no GGUF"
  // would refuse repos that are perfectly fine.
  if (!Array.isArray(info.siblings)) return { ok: false, reason: 'file list not returned' };

  const ggufFiles = info.siblings.map((s) => s && s.rfilename).filter(isGguf);
  if (ggufFiles.length > 0) return { ok: true, hasGguf: true, ggufFiles };

  const suggestion = await findGgufAlternative(repoId, hfToken);
  return { ok: true, hasGguf: false, ggufFiles: [], suggestion };
}

module.exports = { ggufProbe, findGgufAlternative, isGguf };
