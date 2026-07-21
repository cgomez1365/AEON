/**
 * Second Brain Block — API Router
 * 
 * Exposes the knowledge graph: markdown documents, reading library,
 * and saved artifacts via REST endpoints for the Neural Terminal
 * and dashboard widgets.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');

module.exports = function secondBrainFactory(deps) {
  const router = express.Router();

  const DATA_ROOT = path.join(__dirname, '..', 'data');
  const BRAIN_DIR     = deps?.VAULT_ROOT || path.join(DATA_ROOT, 'Vault');
  const LIBRARY_DIR   = path.join(BRAIN_DIR, 'Reading_Library');
  const ARTIFACTS_DIR = path.join(BRAIN_DIR, 'Saved_Artifacts');

  // Guarantee data directories exist on boot — user's data must never 404.
  for (const dir of [DATA_ROOT, BRAIN_DIR, LIBRARY_DIR, ARTIFACTS_DIR]) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  // ─── Serve the 3D graph HTML (self-contained in the block) ─────
  router.get('/crn/second-brain/visualizer', (_req, res) => {
    const htmlPath = path.join(__dirname, '..', 'public', 'second_brain.html');
    if (!fs.existsSync(htmlPath)) return res.status(404).send('Visualizer HTML not found');
    res.setHeader('Content-Type', 'text/html');
    fs.createReadStream(htmlPath).pipe(res);
  });

  // ─── Vendored graph libs (local-first; CDN was a single point of failure) ─
  router.get('/crn/second-brain/vendor/:file', (req, res) => {
    const file = path.basename(req.params.file); // no traversal
    const full = path.join(__dirname, '..', 'public', 'vendor', file);
    if (!fs.existsSync(full)) return res.status(404).send('vendor file not found');
    res.setHeader('Content-Type', 'application/javascript');
    fs.createReadStream(full).pipe(res);
  });

  // ─── Narrator progress (was a ghost route — frontend called it, nothing
  //     served it, so every PDF open threw [API FAILED] /api/narrator/state) ─
  const NARRATOR_STATE = path.join(DATA_ROOT, 'narrator-state.json');
  const _loadNarrator = () => { try { return JSON.parse(fs.readFileSync(NARRATOR_STATE, 'utf8')); } catch { return {}; } };
  router.get('/narrator/state', (req, res) => {
    const nodeId = String(req.query.nodeId || '');
    res.json({ state: _loadNarrator()[nodeId] || null });
  });
  router.post('/narrator/state', (req, res) => {
    const { nodeId, state } = req.body || {};
    if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
    const all = _loadNarrator();
    all[nodeId] = state || {};
    try { fs.writeFileSync(NARRATOR_STATE, JSON.stringify(all, null, 2)); } catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true });
  });

  // ─── Health ────────────────────────────────────────────────────
  router.get('/crn/second-brain/health', (_req, res) => {
    const dirs = { Vault: BRAIN_DIR, Reading_Library: LIBRARY_DIR, Saved_Artifacts: ARTIFACTS_DIR };
    const status = {};
    for (const [key, dir] of Object.entries(dirs)) {
      status[key] = fs.existsSync(dir) ? 'online' : 'missing';
    }
    res.json({ block: 'aeon_matrix', status });
  });

  // ─── Tree: recursive listing of a vault section ───────────────
  router.get('/crn/second-brain/tree', (req, res) => {
    const section = req.query.section || 'Vault';
    const allowed = { Vault: BRAIN_DIR, Reading_Library: LIBRARY_DIR, Saved_Artifacts: ARTIFACTS_DIR };
    const root = allowed[section];
    if (!root || !fs.existsSync(root)) return res.status(404).json({ error: 'Section not found' });

    const walk = (dir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth) return [];
      try {
        return fs.readdirSync(dir).map(name => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            return { name, type: 'dir', children: walk(full, depth + 1, maxDepth) };
          }
          return { name, type: 'file', size: stat.size };
        });
      } catch { return []; }
    };

    res.json({ section, tree: walk(root) });
  });

  // ─── Search: simple filename + content grep ───────────────────
  router.get('/crn/second-brain/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.status(400).json({ error: 'Missing ?q= query' });

    const results = [];
    const NESTED_SECTION_NAMES = new Set(['Reading_Library', 'Saved_Artifacts']);
    const searchDir = (dir, isRoot = false) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (isRoot && dir === BRAIN_DIR && NESTED_SECTION_NAMES.has(name)) continue;
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { searchDir(full); continue; }
          if (name.toLowerCase().includes(q)) {
            results.push({ file: path.relative(DATA_ROOT, full), match: 'filename' });
          } else if (/\.(md|txt|json)$/i.test(name) && stat.size < 500_000) {
            try {
              const content = fs.readFileSync(full, 'utf8');
              if (content.toLowerCase().includes(q)) {
                const line = content.split('\n').find(l => l.toLowerCase().includes(q)) || '';
                results.push({ file: path.relative(DATA_ROOT, full), match: 'content', snippet: line.trim().slice(0, 200) });
              }
            } catch {}
          }
          if (results.length >= 50) return;
        }
      } catch {}
    };

    searchDir(BRAIN_DIR, true);
    searchDir(LIBRARY_DIR);
    searchDir(ARTIFACTS_DIR);
    res.json({ query: q, count: results.length, results });
  });

  // ─── Read a specific document ─────────────────────────────────
  router.get('/crn/second-brain/document', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = path.resolve(DATA_ROOT, filePath);
    // Security: ensure it stays within DATA_ROOT
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: filePath, content });
  });

  // ─── Raw file serving (images etc.) with correct mime type ────
  const RAW_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', pdf: 'application/pdf', svg: 'image/svg+xml' };
  router.get('/crn/second-brain/raw', (req, res) => {
    const filePath = req.query.path || req.query.nodeId;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = path.resolve(DATA_ROOT, filePath);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    const ext = (resolved.split('.').pop() || '').toLowerCase();
    res.setHeader('Content-Type', RAW_MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved)}"`);
    fs.createReadStream(resolved).pipe(res);
  });

  // ─── Universal extraction: any file → text (OCR fallback) ─────
  // Code, txt, md, html, json → read/stripped. PDFs → text layer, or
  // page-by-page OCR when scanned. Images → OCR. See _extract.cjs.
  router.get('/crn/second-brain/extract', async (req, res) => {
    const filePath = req.query.path || req.query.nodeId;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = path.resolve(DATA_ROOT, filePath);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    try {
      const { extractText } = require('./_extract.cjs');
      const result = await extractText(resolved);
      res.json({ path: filePath, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Extraction failed: ' + e.message });
    }
  });

  // ─── PDF text extraction: for AI Ask/Summary/Search on PDFs ───
  const pdfTextCache = new Map(); // resolved path → { mtime, text }
  router.get('/crn/second-brain/pdf-text', async (req, res) => {
    const filePath = req.query.path || req.query.nodeId;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = path.resolve(DATA_ROOT, filePath);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    try {
      const mtime = fs.statSync(resolved).mtimeMs;
      const cached = pdfTextCache.get(resolved);
      if (cached && cached.mtime === mtime) {
        return res.json({ path: filePath, text: cached.text, pages: cached.pages, cached: true });
      }
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(resolved));
      const text = (data.text || '').trim();
      pdfTextCache.set(resolved, { mtime, text, pages: data.numpages });
      if (pdfTextCache.size > 20) pdfTextCache.delete(pdfTextCache.keys().next().value);
      res.json({ path: filePath, text, pages: data.numpages });
    } catch (e) {
      res.status(500).json({ error: 'PDF text extraction failed: ' + e.message });
    }
  });

  // ─── PDF preview: serve raw PDF for iframe rendering ──────────
  router.get('/crn/second-brain/pdf', (req, res) => {
    const filePath = req.query.path || req.query.nodeId;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = path.resolve(DATA_ROOT, filePath);
    if (!resolved.startsWith(DATA_ROOT)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).send('PDF not found');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolved)}"`);
    fs.createReadStream(resolved).pipe(res);
  });

  // ─── Graph: nodes + links for the 3D visualizer ───────────────
  // Converts the file tree into { nodes, links } format expected by
  // ForceGraph3D. Also mounted at /api/second-brain/graph for the
  // iframe in public/second_brain.html.
  // Aurora palette — matches src/aurora.css (--accent cyan, --accent2 violet)
  const TYPE_COLORS = {
    dir: '#00f2ff', md: '#7fe8f2', txt: '#dce8f5', json: '#b18cff',
    pdf: '#ff6b9d', html: '#7c3aed', default: '#4a6a8a',
  };

  function treeToGraph(tree, parentId, section) {
    const nodes = [];
    const links = [];
    for (const item of tree) {
      const id = parentId ? `${parentId}/${item.name}` : `${section}/${item.name}`;
      const ext = item.type === 'file' ? (item.name.split('.').pop() || '').toLowerCase() : 'dir';
      nodes.push({
        id,
        name: item.name,
        type: item.type,
        ext,
        color: TYPE_COLORS[ext] || TYPE_COLORS.default,
        size: item.type === 'dir' ? 3 : 1,
      });
      if (parentId) links.push({ source: parentId, target: id });
      if (item.children) {
        const sub = treeToGraph(item.children, id, section);
        nodes.push(...sub.nodes);
        links.push(...sub.links);
      }
    }
    return { nodes, links };
  }

  router.get('/crn/second-brain/graph', (_req, res) => {
    const allNodes = [];
    const allLinks = [];
    const sections = { Vault: BRAIN_DIR, Reading_Library: LIBRARY_DIR, Saved_Artifacts: ARTIFACTS_DIR };
    // Reading_Library and Saved_Artifacts are nested inside Vault on disk but get
    // their own graph section — skip them at the top of the Vault walk so they
    // aren't double-counted as both a Vault child and their own section.
    const NESTED_SECTION_NAMES = new Set(['Reading_Library', 'Saved_Artifacts']);
    // Infrastructure folders blocks auto-create (state mirrors, agent memory).
    // They are plumbing, not knowledge — never graph nodes.
    const INFRA_NAMES = new Set(['blocks', '.git', 'node_modules']);
    for (const [section, dir] of Object.entries(sections)) {
      if (!fs.existsSync(dir)) continue;
      const walk = (d, depth = 0) => {
        if (depth > 4) return [];
        try {
          return fs.readdirSync(d)
            .filter(name => !(section === 'Vault' && depth === 0 && NESTED_SECTION_NAMES.has(name)))
            .filter(name => !INFRA_NAMES.has(name) && !name.startsWith('.'))
            .map(name => {
              const full = path.join(d, name);
              const stat = fs.statSync(full);
              if (stat.isDirectory()) return { name, type: 'dir', children: walk(full, depth + 1) };
              return { name, type: 'file', size: stat.size };
            })
            // Empty folders are scaffolding, not knowledge: a directory with no
            // files anywhere beneath it never becomes a node. A handpicked,
            // still-empty vault graphs as exactly ONE node — AEON VAULT.
            .filter(e => e.type === 'file' || (e.children && e.children.length > 0));
        } catch { return []; }
      };
      const tree = walk(dir);
      // Empty sections don't earn a root node either (Vault always does —
      // it's the center of the universe even when brand new).
      if (section !== 'Vault' && tree.length === 0) continue;
      // Section root id — deterministic, NOT path.relative(DATA_ROOT, dir).
      // If VAULT_PATH relocates the vault outside this block's data dir,
      // path.relative degrades to "../../.." ids: the `n.id === 'Vault'`
      // root lookup below fails and centering/doc-resolution breaks silently.
      // These fixed ids match what path.relative produced in the default
      // layout, so /document and /pdf resolution is unchanged today.
      const SECTION_IDS = { Vault: 'Vault', Reading_Library: 'Vault/Reading_Library', Saved_Artifacts: 'Vault/Saved_Artifacts' };
      const baseId = SECTION_IDS[section] || section;
      allNodes.push({ id: baseId, name: section, type: 'dir', ext: 'dir', color: '#00f2ff', size: 5 });
      const { nodes, links } = treeToGraph(tree, baseId, section);
      allNodes.push(...nodes);
      allLinks.push(...links);
    }
    // Single center of the universe: the Vault root. The section roots for
    // Reading_Library / Saved_Artifacts hang off it (they're nested inside
    // Vault on disk anyway) so the graph reads center → folders → files
    // instead of three disconnected islands.
    const vaultRoot = allNodes.find(n => n.id === 'Vault');
    if (vaultRoot) {
      vaultRoot.name = 'AEON VAULT';
      vaultRoot.color = '#7c3aed';
      vaultRoot.size = 9;
      vaultRoot.root = true;
      for (const sec of ['Vault/Reading_Library', 'Vault/Saved_Artifacts']) {
        if (allNodes.some(n => n.id === sec)) allLinks.push({ source: 'Vault', target: sec });
      }
    }
    res.json({ nodes: allNodes, links: allLinks });
  });

  return router;
};
