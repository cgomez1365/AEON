/**
 * Second Brain — Ingestion API
 * Walks the Vault and maintains vault_index.json (the Table of Contents):
 * one entry per file — title, a short summary, folder-derived tags, and one
 * lightweight embedding of that summary (via local Ollama). One small embed
 * call per file, not per chunk — this is what keeps it cheap; retrieval
 * (see retrieve.cjs) is then plain cosine similarity against these cached
 * vectors, no LLM reasoning calls needed at search time.
 *
 * Routes:
 *   POST /crn/second-brain/ingest/chat      — chat session turns → a real file + ToC entry
 *   POST /crn/second-brain/ingest/document  — file content → ToC entry
 *   POST /crn/second-brain/ingest/scan-docs — incremental scan & index (new/changed/deleted)
 *   GET  /crn/second-brain/index-status     — doc count, last run (for Settings)
 *
 * deps.runSecondBrainScan(onEvent?) is exported for internal callers (boot auto-index,
 * nightly cron, other blocks pushing produced content) that don't want to hit HTTP.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { loadExtractors, extractText, embed } = require('./_lib.cjs');

const NIGHTLY_HOUR  = 3; // local hour to auto re-index, once per day
const INDEXABLE_EXT = /\.(md|txt|json|pdf|docx)$/i;
const SUMMARY_CHARS = 280;

// ── Helpers ─────────────────────────────────────────────────────────────────

function fileHash(stat) {
  return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
}

function deriveTitle(fullPath, text) {
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 120);
  return path.basename(fullPath, path.extname(fullPath));
}

function deriveSummary(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_CHARS) return flat;
  const cut = flat.slice(0, SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

function deriveTags(relPosix) {
  const parts = relPosix.split('/');
  parts.pop(); // drop filename
  return parts;
}

// ── Factory ──────────────────────────────────────────────────────────────────

module.exports = function ingestFactory(deps) {
  const router   = express.Router();
  const { isVercel, VAULT_ROOT } = deps;

  const DATA_ROOT  = path.join(__dirname, '..', 'data');
  const BRAIN_DIR  = VAULT_ROOT || path.join(DATA_ROOT, 'Vault');
  const MANIFEST_FILE = path.join(DATA_ROOT, 'index_manifest.json'); // hash-based change detection only
  const STATUS_FILE   = path.join(DATA_ROOT, 'index_status.json');
  const INDEX_FILE    = path.join(DATA_ROOT, 'vault_index.json');    // the Table of Contents

  function readManifest() {
    if (!fs.existsSync(MANIFEST_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return {}; }
  }
  function writeManifest(m) {
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2), 'utf8');
  }
  function readStatus() {
    if (!fs.existsSync(STATUS_FILE)) return { lastRun: null, totalDocs: 0, lastResult: null };
    try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return { lastRun: null, totalDocs: 0, lastResult: null }; }
  }
  function writeStatus(s) {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2), 'utf8');
  }
  function readIndex() {
    if (!fs.existsSync(INDEX_FILE)) return { generatedAt: null, documents: {} };
    try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { return { generatedAt: null, documents: {} }; }
  }
  function writeIndex(idx) {
    idx.generatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8');
  }

  let ollamaWarned = false;
  async function buildEntry(fullPath, relPosix, text, stat) {
    const summary = deriveSummary(text);
    const entry = {
      path: relPosix,
      title: deriveTitle(fullPath, text),
      summary,
      tags: deriveTags(relPosix),
      type: path.extname(fullPath).slice(1).toLowerCase(),
      sizeBytes: stat.size,
      updatedAt: Date.now(),
    };
    try {
      const { vector, model } = await embed(summary);
      entry.embedding = vector;
      entry.embeddingModel = model;
    } catch (e) {
      if (!ollamaWarned) {
        ollamaWarned = true;
        console.warn('[SECOND BRAIN] Embedding unavailable (Ollama off AND no Gemini keys?) — entries will index without vectors:', e.message);
      }
    }
    return entry;
  }

  // ── Core incremental scan — walks BRAIN_DIR, diffs against the manifest (hash
  //    only, no chunk bookkeeping), updates vault_index.json for new/changed
  //    files, removes entries for deleted files. onEvent(evt) streams progress.
  async function runScan(onEvent = () => {}) {
    const results = { ingested: 0, skipped: 0, deleted: 0, errors: [] };
    if (isVercel) {
      const r = { ...results, reason: 'cloud env — vault lives on the local filesystem only' };
      onEvent({ done: true, ...r });
      return r;
    }

    loadExtractors();

    const walk = (dir) => {
      if (!fs.existsSync(dir)) return [];
      const files = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { files.push(...walk(full)); continue; }
        if (INDEXABLE_EXT.test(name)) files.push(full);
      }
      return files;
    };

    const manifest = readManifest();
    const index = readIndex();
    const files = walk(BRAIN_DIR);
    const seen = new Set();

    // Persists manifest + index + status after every file so a cancel/crash
    // mid-run never loses progress and never redoes already-completed work.
    const checkpoint = () => {
      writeManifest(manifest);
      writeIndex(index);
      writeStatus({
        lastRun: new Date().toISOString(),
        totalDocs: Object.keys(index.documents).length,
        lastResult: results,
      });
    };

    for (const full of files) {
      const rel = path.relative(DATA_ROOT, full);
      const relPosix = rel.replace(/\\/g, '/');
      seen.add(rel);
      try {
        const stat = fs.statSync(full);
        const hash = fileHash(stat);
        if (manifest[rel] && manifest[rel].hash === hash) {
          // Backfill: docs ingested while no embedder was available have no
          // vector — give them one now (Ollama or Gemini fallback) without
          // re-extracting the file.
          const existing = index.documents[relPosix];
          if (existing && !Array.isArray(existing.embedding) && existing.summary) {
            try {
              const { vector, model } = await embed(existing.summary);
              existing.embedding = vector;
              existing.embeddingModel = model;
              existing.updatedAt = Date.now();
              results.ingested++;
              onEvent({ file: relPosix, action: 'embed-backfill' });
              if (results.ingested % 10 === 0) checkpoint();
              continue;
            } catch { /* still no embedder — stay vector-less */ }
          }
          results.skipped++;
          continue;
        }

        const text = await extractText(full);
        if (!text || text.trim().length < 20) {
          results.skipped++;
          continue;
        }

        index.documents[relPosix] = await buildEntry(full, relPosix, text, stat);
        manifest[rel] = { hash, indexedAt: Date.now() };
        results.ingested++;
        onEvent({ file: relPosix });
        checkpoint();
      } catch (err) {
        results.errors.push({ file: relPosix, error: err.message });
        onEvent({ file: relPosix, error: err.message });
      }
    }

    // Deletions: manifest entries whose file no longer exists on disk
    for (const rel of Object.keys(manifest)) {
      if (!seen.has(rel)) {
        const relPosix = rel.replace(/\\/g, '/');
        delete manifest[rel];
        delete index.documents[relPosix];
        results.deleted++;
        onEvent({ file: relPosix, deleted: true });
        checkpoint();
      }
    }

    writeManifest(manifest);
    writeIndex(index);
    writeStatus({
      lastRun: new Date().toISOString(),
      totalDocs: Object.keys(index.documents).length,
      lastResult: results,
    });

    onEvent({ done: true, ...results });
    return results;
  }

  // ── Nightly auto re-index — self-contained, no external scheduler needed.
  //    Checked hourly; runs once per calendar day at NIGHTLY_HOUR local time.
  if (!isVercel) {
    setInterval(() => {
      const now = new Date();
      if (now.getHours() !== NIGHTLY_HOUR) return;
      const status = readStatus();
      const today = now.toISOString().slice(0, 10);
      if (status.lastRun && status.lastRun.slice(0, 10) === today) return;
      console.log('[SECOND BRAIN] Nightly auto-index starting...');
      runScan().then(r => console.log(`[SECOND BRAIN] Nightly auto-index done: ${r.ingested} ingested, ${r.skipped} skipped, ${r.deleted} deleted.`));
    }, 60 * 60 * 1000);
  }

  if (isVercel) return router; // vault lives on the local filesystem — routes below are local-only

  // POST /crn/second-brain/ingest/chat — writes user turns to a real file so the
  // ToC has something to cite and retrieve() has something to read back.
  router.post('/crn/second-brain/ingest/chat', async (req, res) => {
    const { session_id, messages } = req.body || {};
    if (!session_id || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'session_id and messages required' });
    }

    const userTurns = messages
      .filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 20)
      .map(m => m.content.trim());

    if (!userTurns.length) return res.json({ ok: true, ingested: 0, reason: 'no user turns' });

    try {
      const chatDir = path.join(BRAIN_DIR, 'Chat_History');
      fs.mkdirSync(chatDir, { recursive: true });
      const full = path.join(chatDir, `${session_id}.md`);
      const block = `\n\n---\n${new Date().toISOString()}\n\n${userTurns.join('\n\n')}\n`;
      fs.appendFileSync(full, block, 'utf8');

      const text = fs.readFileSync(full, 'utf8');
      const stat = fs.statSync(full);
      const relPosix = path.relative(DATA_ROOT, full).replace(/\\/g, '/');
      const index = readIndex();
      index.documents[relPosix] = await buildEntry(full, relPosix, text, stat);
      writeIndex(index);

      res.json({ ok: true, ingested: userTurns.length, file: relPosix });
    } catch (err) {
      console.error('[INGEST] chat error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /crn/second-brain/ingest/document
  // Body: { file_path, content? } — content optional, reads from disk if omitted;
  // if content is given and no file exists yet, it's written to disk first so
  // the ToC entry always has a real, readable file behind it.
  // Also used by other blocks (autopilot, writer, etc.) to push produced content in.
  router.post('/crn/second-brain/ingest/document', async (req, res) => {
    const { file_path, content: bodyContent } = req.body || {};
    if (!file_path) return res.status(400).json({ error: 'file_path required' });

    const resolved = path.resolve(DATA_ROOT, file_path);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });

    if (bodyContent && !fs.existsSync(resolved)) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bodyContent, 'utf8');
    } else if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' });
    }

    loadExtractors();
    const text = await extractText(resolved);
    if (!text || text.trim().length < 20) return res.json({ ok: true, ingested: 0, reason: 'empty file' });

    try {
      const stat = fs.statSync(resolved);
      const relPosix = path.relative(DATA_ROOT, resolved).replace(/\\/g, '/');
      const index = readIndex();
      index.documents[relPosix] = await buildEntry(resolved, relPosix, text, stat);
      writeIndex(index);

      const manifest = readManifest();
      manifest[path.relative(DATA_ROOT, resolved)] = { hash: fileHash(stat), indexedAt: Date.now() };
      writeManifest(manifest);

      res.json({ ok: true, ingested: 1, file: relPosix });
    } catch (err) {
      console.error('[INGEST] doc error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /crn/second-brain/ingest/document — overwrite an existing file's content
  // (the counterpart to POST above, which is create-only and never clobbers a
  // file already on disk). Used by the block's own Edit Mode UI (EditorMode.jsx)
  // to save user edits back to the Vault; other blocks pushing produced content
  // in should keep using POST.
  router.put('/crn/second-brain/ingest/document', async (req, res) => {
    const { file_path, content } = req.body || {};
    if (!file_path) return res.status(400).json({ error: 'file_path required' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    const resolved = path.resolve(DATA_ROOT, file_path);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

    try {
      fs.writeFileSync(resolved, content, 'utf8');

      loadExtractors();
      const text = await extractText(resolved);
      const stat = fs.statSync(resolved);
      const relPosix = path.relative(DATA_ROOT, resolved).replace(/\\/g, '/');

      if (text && text.trim().length >= 20) {
        const index = readIndex();
        index.documents[relPosix] = await buildEntry(resolved, relPosix, text, stat);
        writeIndex(index);

        const manifest = readManifest();
        manifest[path.relative(DATA_ROOT, resolved)] = { hash: fileHash(stat), indexedAt: Date.now() };
        writeManifest(manifest);
      }

      res.json({ ok: true, file: relPosix });
    } catch (err) {
      console.error('[INGEST] update error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /crn/second-brain/ingest/document — remove a doc's ToC entry + manifest
  // entry (for UI-driven deletes; disk deletions are also caught by scan-docs)
  router.delete('/crn/second-brain/ingest/document', async (req, res) => {
    const { file_path } = req.body || {};
    if (!file_path) return res.status(400).json({ error: 'file_path required' });
    try {
      const index = readIndex();
      delete index.documents[file_path];
      writeIndex(index);

      const manifest = readManifest();
      delete manifest[file_path.replace(/\//g, path.sep)];
      writeManifest(manifest);

      res.json({ ok: true, deleted: file_path });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /crn/second-brain/ingest/scan-docs — incremental, streamed via SSE.
  // The scan itself must survive the client disconnecting early (a long scan,
  // a closed tab, a timed-out test request) — a dead res.write() shouldn't be
  // able to silently kill an in-progress rescan.
  router.post('/crn/second-brain/ingest/scan-docs', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    await runScan((ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone, scan keeps going */ } });
    try { res.end(); } catch { /* already gone */ }
  });

  // GET /crn/second-brain/index-status — for Settings ▸ Installed blocks nervous-system view
  router.get('/crn/second-brain/index-status', (_req, res) => {
    res.json(readStatus());
  });

  // Expose for internal callers (server.cjs boot check, other blocks)
  router.runSecondBrainScan = runScan;
  router.readSecondBrainStatus = readStatus;

  return router;
};
