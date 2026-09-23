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
const { isInside } = require('../../../kernel/pathContainment.cjs');

module.exports = function secondBrainFactory(deps) {
  const router = express.Router();

  // Roots come from the storage seam through deps. Until 2026-09-14 this block
  // created src/blocks/aeon_matrix/data unconditionally and resolved every
  // document path against it, so with the Vault anywhere else (VAULT_PATH, a
  // USB bundle, the AEON home) the routes below read a folder the Vault was
  // not in. Only what the block needs is created, where it actually lives.
  const BRAIN_DIR     = deps?.VAULT_ROOT || path.join(__dirname, '..', 'data', 'Vault');
  const LIBRARY_DIR   = path.join(BRAIN_DIR, 'Reading_Library');
  const ARTIFACTS_DIR = path.join(BRAIN_DIR, 'Saved_Artifacts');
  // This block's own operational state (narrator progress, the OCR cache).
  const BLOCK_DATA    = deps?.getDataFile ? deps.getDataFile('aeon_matrix') : path.join(__dirname, '..', 'data');

  // Guarantee data directories exist on boot — user's data must never 404.
  for (const dir of [BRAIN_DIR, LIBRARY_DIR, ARTIFACTS_DIR, BLOCK_DATA]) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  // Document paths this API exchanges are "Vault/<relative>" — the shape the
  // index, the graph and the terminal have always used. Resolve them against
  // the Vault itself, contained there.
  const vaultRel = (full) => 'Vault/' + path.relative(BRAIN_DIR, full).split(path.sep).join('/');
  const resolveDoc = (p) => {
    const rel = String(p).replace(/^[\\/]?Vault(?=[\\/])[\\/]/, '');
    const full = path.resolve(BRAIN_DIR, rel);
    // Containment, not a string prefix: startsWith() let a sibling directory
    // through (…/data-backup passes a check against …/data).
    return isInside(BRAIN_DIR, full, { allowRoot: true }) ? full : null;
  };
  const { setCacheDir } = require('./_extract.cjs');
  setCacheDir(path.join(BLOCK_DATA, '.extract-cache'));

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
  const NARRATOR_STATE = path.join(BLOCK_DATA, 'narrator-state.json');
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
        // Hidden names (".DS_Store", "._note.md" sidecars) are never shown as Vault content.
        return fs.readdirSync(dir).filter(name => !name.startsWith('.')).map(name => {
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
          if (name.startsWith('.')) continue;
          if (isRoot && dir === BRAIN_DIR && NESTED_SECTION_NAMES.has(name)) continue;
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { searchDir(full); continue; }
          if (name.toLowerCase().includes(q)) {
            results.push({ file: vaultRel(full), match: 'filename' });
          } else if (/\.(md|txt|json)$/i.test(name) && stat.size < 500_000) {
            try {
              const content = fs.readFileSync(full, 'utf8');
              if (content.toLowerCase().includes(q)) {
                const line = content.split('\n').find(l => l.toLowerCase().includes(q)) || '';
                results.push({ file: vaultRel(full), match: 'content', snippet: line.trim().slice(0, 200) });
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

  // ─── /doc <name> — open a document the way an operator names it ─
  //
  // CEO, 2026-09-22: `/recall pestle` found blocks/research/state.md, and the
  // very next line, `/doc state.md`, answered 404 "Not found" in 44 ms — and lit
  // the global "[API FAILED]" banner. /doc wanted the exact Vault path, which
  // nothing had shown him. A saved chat, `/doc 2026-09-20T…json`, same.
  //
  // The terminal's /doc (manifest route /crn/second-brain/document?resolve=1)
  // now gets /ask-doc's rules
  // (retrieve.cjs resolveDocument): the exact path wins; then the exact file
  // name (or, when a "/" was typed, the path suffix); then titles and file
  // names that CONTAIN the text. One match opens. Two or more are listed and
  // none is opened — never a guess (§08). None says what was searched.
  //
  // It walks the Vault's FILES, not only the index: saved chats are kept out of
  // the index on purpose (R09) but they are the operator's files and he can
  // name one. The graph and the Matrix search keep the strict route below —
  // a clicked node must open that node or fail, never a namesake.
  //
  // Not-found is HTTP 200 with ok:false, not a 404. The dispatcher forwards the
  // status verbatim and every non-2xx from /api/commands/dispatch raises the
  // app-wide red banner — a second, louder rendering of a failure the chip
  // already shows, labelled as a broken API when the API answered perfectly.
  const DATA_ROOT  = deps?.DATA_ROOT || path.join(__dirname, '..', 'data');
  const INDEX_FILE = path.join(DATA_ROOT, 'vault_index.json');
  // Security's own state is never offered up by a fuzzy name; its exact path
  // still reads as it always has.
  const NAME_SKIP  = new Set(['blocks/security']);
  const MAX_WALK   = 50000;
  const TERMINAL_TEXT_CHARS = 20000;

  function walkVaultFiles() {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 16 || out.length >= MAX_WALK) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(BRAIN_DIR, full).split(path.sep).join('/');
        if (NAME_SKIP.has(rel)) continue;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) out.push(rel);
        if (out.length >= MAX_WALK) return;
      }
    };
    walk(BRAIN_DIR, 0);
    return out;
  }

  function indexedTitles() {
    try {
      const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      return Object.values(idx?.documents || {}).filter((d) => d && d.path);
    } catch { return []; }
  }

  function resolveByName(typed) {
    const q = typed.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^Vault\//i, '');
    const ql = q.toLowerCase();
    const files = walkVaultFiles();
    const docs = indexedTitles();
    const titleOf = new Map(docs.map((d) => [d.path, d.title]));
    const searched = { files: files.length, titles: docs.length };
    if (!ql) return { hits: [], by: null, searched, titleOf };

    const exact = files.filter((f) => f.toLowerCase() === ql);
    if (exact.length) return { hits: exact, by: 'path', searched, titleOf };

    const named = ql.includes('/')
      ? files.filter((f) => f.toLowerCase().endsWith(`/${ql}`))
      : files.filter((f) => path.posix.basename(f).toLowerCase() === ql);
    if (named.length) return { hits: named, by: ql.includes('/') ? 'partial path' : 'file name', searched, titleOf };

    // Containment needs a few characters, or "a" would match the whole Vault.
    if (ql.length < 3) return { hits: [], by: null, searched, titleOf };
    const onDisk = new Set(files);
    const byTitle = docs.filter((d) => onDisk.has(d.path) && String(d.title || '').toLowerCase().includes(ql)).map((d) => d.path);
    const byName = files.filter((f) => path.posix.basename(f).toLowerCase().includes(ql));
    return { hits: [...new Set([...byTitle, ...byName])], by: 'title or file name', searched, titleOf };
  }

  const argFor = (rel) => (/\s/.test(rel) ? `"${rel}"` : rel);

  async function openByName(typed, res) {
    const { hits, by, searched, titleOf } = resolveByName(typed);

    if (!hits.length) {
      const text = `Nothing in the Vault matches "${typed}". Searched: the exact path, `
        + `${searched.files.toLocaleString()} file names in every Vault folder (saved chats included), `
        + `and ${searched.titles.toLocaleString()} indexed titles. `
        + 'Try /recall <words from the document> to search by meaning — it prints each match\'s path for /doc.';
      return res.json({ ok: false, found: false, reason: 'not_found', error: text, text, searched });
    }

    if (hits.length > 1) {
      const shown = hits.slice(0, 15);
      const text = `"${typed}" matches ${hits.length} documents — say which one:\n`
        + shown.map((p) => `- ${p}${titleOf.get(p) ? ` — ${titleOf.get(p)}` : ''}`).join('\n')
        + (hits.length > shown.length ? `\n…and ${hits.length - shown.length} more — type more of the path.` : '')
        + `\nThen: /doc ${argFor(shown[0])}`;
      return res.json({ ok: true, found: false, reason: 'ambiguous', candidates: shown.map((p) => ({ path: p, title: titleOf.get(p) || null })), total: hits.length, text });
    }

    const rel = hits[0];
    const full = resolveDoc(rel);
    if (!full || !fs.existsSync(full)) {
      const text = `${rel} could not be opened.`;
      return res.json({ ok: false, found: false, reason: 'unreadable', error: text, text });
    }
    try {
      const { extractText } = require('./_extract.cjs');
      const { text: content, ...meta } = await extractText(full);
      const body = String(content || '');
      const how = by === 'path' ? '' : ` — matched "${typed}" by ${by}`;
      const clipped = body.length > TERMINAL_TEXT_CHARS
        ? `${body.slice(0, TERMINAL_TEXT_CHARS)}\n\n… showing the first ${TERMINAL_TEXT_CHARS.toLocaleString()} of ${body.length.toLocaleString()} characters. Ask about the rest with /ask-doc ${argFor(rel)} <question>, or open it in Aeon Matrix.`
        : (body || '(this file has no readable text)');
      res.json({
        ok: true, found: true, path: `Vault/${rel}`, matchedBy: by, content: body, ...meta,
        text: `${rel}${how}\n\n${clipped}`,
      });
    } catch (e) {
      const text = `${rel} was found but could not be read: ${e.message}`;
      res.json({ ok: false, found: true, reason: 'extraction_failed', path: `Vault/${rel}`, error: text, text });
    }
  }

  // ─── Read a specific document ─────────────────────────────────
  //
  // Was `fs.readFileSync(resolved, 'utf8')` — a raw byte read decoded as
  // text. For a PDF (or any binary format) that returns mojibake with
  // `ok: 200`, not an error: /doc looked like it worked and handed the
  // operator garbage. /pdf-text a few routes down already does this right;
  // this route just never got the fix. Response field stays `content` (not
  // `_extract.cjs`'s `text`) — index.jsx and SecondBrainVisualizer.jsx both
  // read `data.content` and would silently show "(empty)" for every
  // document, PDFs included, if the field were renamed here.
  router.get('/crn/second-brain/document', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });
    if (String(req.query.resolve || '') === '1') return openByName(String(filePath), res);

    const resolved = resolveDoc(filePath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    try {
      const { extractText } = require('./_extract.cjs');
      const { text, ...meta } = await extractText(resolved);
      res.json({ path: filePath, content: text, ...meta });
    } catch (e) {
      res.status(500).json({ error: 'Extraction failed: ' + e.message });
    }
  });

  // ─── Raw file serving (images etc.) with correct mime type ────
  const RAW_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', pdf: 'application/pdf', svg: 'image/svg+xml' };
  router.get('/crn/second-brain/raw', (req, res) => {
    const filePath = req.query.path || req.query.nodeId;
    if (!filePath) return res.status(400).json({ error: 'Missing ?path=' });

    const resolved = resolveDoc(filePath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
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

    const resolved = resolveDoc(filePath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
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

    const resolved = resolveDoc(filePath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
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

    const resolved = resolveDoc(filePath);
    if (!resolved) return res.status(403).json({ error: 'Access denied' });
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
      // `contains` = the folder hierarchy. Kept distinct from `link` below so
      // the graph can show structure and meaning as different things.
      if (parentId) links.push({ source: parentId, target: id, kind: 'contains' });
      if (item.children) {
        const sub = treeToGraph(item.children, id, section);
        nodes.push(...sub.nodes);
        links.push(...sub.links);
      }
    }
    return { nodes, links };
  }

  // ── Wikilinks and refs → real graph edges ─────────────────────────────────
  //
  // The graph used to be built from the folder tree alone: every edge meant
  // "lives inside", never "relates to". That renders like Obsidian's graph
  // while encoding something quite different — containment, not knowledge.
  //
  // The ingredients were already on disk and unread. memory_core's mdMirror
  // writes a `refs: [...]` array into every memory's YAML frontmatter, and
  // markdown notes carry [[wikilinks]]. Nothing parsed either one.
  //
  // Text-ish files only, size-capped, and failures are skipped rather than
  // fatal: the graph must still render if one file is unreadable.
  const LINKABLE_EXT = new Set(['md', 'mdx', 'markdown', 'txt']);
  const MAX_LINK_SCAN_BYTES = 512 * 1024;

  const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

  /** `refs: ["a", "b"]` or `refs: [a, b]` from YAML frontmatter. */
  function parseFrontmatterRefs(text) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) return [];
    const line = /^refs:\s*\[(.*)\]\s*$/m.exec(fm[1]);
    if (!line) return [];
    return line[1].split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  /**
   * Resolve a link target to a node id.
   * Obsidian matches by note NAME, not path, so we do the same: compare the
   * basename without extension, case-insensitively. Ambiguous names resolve to
   * the first match — same as Obsidian, and better than dropping the edge.
   */
  /**
   * Normalise a note name for matching.
   *
   * Separators are collapsed because people do not type filenames — they type
   * titles. A note saved as `recovery-codes.md` is referred to as
   * [[recovery codes]] or [[Recovery_Codes]], and treating those as three
   * different notes produces a graph with no edges and no explanation. Strict
   * filename matching found ZERO links on the first live run for exactly this
   * reason.
   */
  const normaliseName = (s) => String(s)
    .replace(/\.[^.]+$/, '')          // drop extension
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')         // space, underscore, hyphen are the same
    .trim();

  function buildNameIndex(nodes) {
    const byName = new Map();
    for (const n of nodes) {
      if (n.type !== 'file') continue;
      const base = normaliseName(n.name);
      if (!byName.has(base)) byName.set(base, n.id);
    }
    return byName;
  }

  function addKnowledgeLinks(allNodes, allLinks, sections) {
    const byName = buildNameIndex(allNodes);
    const nodeIds = new Set(allNodes.map(n => n.id));
    let added = 0, scanned = 0;

    for (const node of allNodes) {
      if (node.type !== 'file') continue;
      if (!LINKABLE_EXT.has(node.ext)) continue;

      // node.id is `<SectionId>/<relative path>` — map back to disk.
      let full = null;
      for (const [sectionId, dir] of Object.entries(sections)) {
        if (node.id === sectionId || node.id.startsWith(sectionId + '/')) {
          const rel = node.id.slice(sectionId.length).replace(/^\//, '');
          full = path.join(dir, ...rel.split('/'));
          break;
        }
      }
      if (!full || !fs.existsSync(full)) continue;

      let text;
      try {
        if (fs.statSync(full).size > MAX_LINK_SCAN_BYTES) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      scanned++;

      const targets = new Set();
      let m;
      WIKILINK_RE.lastIndex = 0;
      while ((m = WIKILINK_RE.exec(text))) targets.add(m[1].trim());
      for (const r of parseFrontmatterRefs(text)) targets.add(r);

      for (const t of targets) {
        if (!t) continue;
        // A ref may already be a full node id, or a bare note name.
        const direct = nodeIds.has(t) ? t : null;
        const byBase = byName.get(normaliseName(t));
        const target = direct || byBase;
        if (!target || target === node.id) continue;
        allLinks.push({ source: node.id, target, kind: 'link' });
        added++;
      }
    }
    return { added, scanned };
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
    // BO-MEM T1 — saved conversations are not knowledge until the operator says
    // so (R09). Matched on the relative path, not the bare name, because
    // Agents/ itself must stay in the graph: agent memories and council
    // debates are written to the shared Vault deliberately (P0-07).
    const INFRA_PATHS = new Set(['Agents/Aeon/chat_sessions']);
    for (const [section, dir] of Object.entries(sections)) {
      if (!fs.existsSync(dir)) continue;
      const walk = (d, depth = 0) => {
        if (depth > 4) return [];
        try {
          return fs.readdirSync(d)
            .filter(name => !(section === 'Vault' && depth === 0 && NESTED_SECTION_NAMES.has(name)))
            .filter(name => !INFRA_NAMES.has(name) && !name.startsWith('.'))
            .filter(name => !INFRA_PATHS.has(
              path.relative(BRAIN_DIR, path.join(d, name)).split(path.sep).join('/')))
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

    // Knowledge edges last, so a parsing failure can never cost the structural
    // graph. This is what turns a folder picture into a knowledge graph.
    let linkStats = { added: 0, scanned: 0 };
    try {
      linkStats = addKnowledgeLinks(allNodes, allLinks, {
        Vault: BRAIN_DIR,
        'Vault/Reading_Library': LIBRARY_DIR,
        'Vault/Saved_Artifacts': ARTIFACTS_DIR,
      });
    } catch (e) {
      console.warn('[GRAPH] knowledge-link pass failed, structure still served:', e.message);
    }

    res.json({
      nodes: allNodes,
      links: allLinks,
      stats: {
        nodes: allNodes.length,
        containsLinks: allLinks.filter(l => l.kind !== 'link').length,
        knowledgeLinks: linkStats.added,
        filesScannedForLinks: linkStats.scanned,
      },
    });
  });

  return router;
};
