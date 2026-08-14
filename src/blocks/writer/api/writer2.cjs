/**
 * AEON Writer 2.0 — the "drop Word" layer.
 *
 * Adds on top of writer.js (docs CRUD + AI):
 *   GET  /api/writer/templates          → professional starting points
 *   GET  /api/writer/versions/:id       → snapshot history (writer.js saves them)
 *   GET  /api/writer/version/:id/:ts    → one snapshot's content
 *   POST /api/writer/restore/:id/:ts    → roll back (current state is snapshotted first)
 *   GET  /api/writer/export/:id.doc     → real download Word opens natively
 *
 * Zero dependencies: the markdown→HTML renderer below covers the subset the
 * editor produces (headings, emphasis, lists, links, quotes, code, rules).
 */
// BO-SHIP P2.2 — ported off direct `fs` onto the block's scoped surface.
// `path` stays: pure string arithmetic, reaches nothing.
const path = require('path');

// ── Mini markdown → HTML (good enough for export, no deps) ─────────────
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
function mdToHtml(md) {
  const lines = esc(md || '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// ── Templates a real business actually reuses ───────────────────────────
const TEMPLATES = [
  { id: 'blank', icon: '📄', label: 'Blank document', content: '' },
  { id: 'letter', icon: '✉️', label: 'Business letter', content: '[Your name]\n[Your address]\n\n[Date]\n\n[Recipient name]\n[Recipient address]\n\nDear [Name],\n\n**Opening** — why you are writing, in one sentence.\n\n**Body** — the facts, the ask, the timeline.\n\n**Close** — what happens next and by when.\n\nSincerely,\n\n[Your name]' },
  { id: 'proposal', icon: '📊', label: 'Business proposal', content: '# [Project name] — Proposal\n\n## The problem\nWhat hurts today, in the client\'s own words.\n\n## The solution\nWhat you will deliver. Be concrete.\n\n## Timeline\n1. Week 1 — \n2. Week 2 — \n3. Week 3 — \n\n## Investment\n| Item | Cost |\n| --- | --- |\n|  |  |\n\n## Why us\nOne short paragraph. Proof beats adjectives.\n\n## Next step\nOne sentence. One action.' },
  { id: 'report', icon: '📈', label: 'Status report', content: '# [Period] Report — [Team / Project]\n\n## TL;DR\nThree sentences max.\n\n## Wins\n- \n\n## Numbers\n- \n\n## Blockers\n- \n\n## Next period\n- ' },
  { id: 'minutes', icon: '🗓️', label: 'Meeting minutes', content: '# Meeting — [Topic]\n\n**Date:** \n**Present:** \n\n## Decisions\n1. \n\n## Action items\n- [ ] [Who] — [What] — [By when]\n\n## Notes\n' },
  { id: 'blog', icon: '📝', label: 'Blog post', content: '# [Working title]\n\n*Hook — the sentence that earns the next sentence.*\n\n## The setup\nWhat the reader already believes.\n\n## The turn\nWhat you know that they don\'t.\n\n## The payoff\nWhat to do about it.\n\n---\n*Call to action.*' },
  { id: 'press', icon: '📰', label: 'Press release', content: '# FOR IMMEDIATE RELEASE\n\n## [Company] announces [thing]\n\n**[City], [Date]** — [Company], [one-line description], today announced [news]. \n\n"[Quote from a named person]," said [Name, Title].\n\n[Second paragraph: details, availability, price.]\n\n### About [Company]\n[Boilerplate.]\n\n**Contact:** [name, email]' },
  { id: 'resume', icon: '💼', label: 'Résumé', content: '# [Your name]\n[City] · [Email] · [Phone] · [LinkedIn]\n\n## Summary\nTwo sentences: what you do and the results you produce.\n\n## Experience\n**[Title] — [Company]** · [Dates]\n- Achievement with a number\n- Achievement with a number\n\n## Skills\n[Skill] · [Skill] · [Skill]\n\n## Education\n**[Degree] — [School]** · [Year]' },
];

module.exports = (app, deps) => {
  const isVercel = require('../../../kernel/runtime.cjs').isCloud();

  // BO-SHIP P2.2 — this module and writer.js disagreed about where the block's
  // documents live, and had done since they were written:
  //
  //   writer.js   getBlockDataFile('writer')      -> data/writer/
  //   writer2.cjs deps.getVaultFile('blocks/writer') -> Vault/blocks/writer/
  //
  // The comment here claimed "must match writer.js exactly", which recorded the
  // intent while the code drifted away from it. Version history reads snapshots
  // writer.js writes, so /api/writer/versions/:id was reading a directory
  // nothing ever wrote to — it could not have worked. Export and restore had
  // the same split.
  //
  // Both modules now resolve through the one block-scoped surface, so there is
  // a single namespace and no second opinion about where it is.
  const fs = deps?.blockStorage
    ? deps.blockStorage.fs
    : require('../../../kernel/blockStorage.cjs').createRootedStorage(
        isVercel
          ? '/tmp/aeon_writer'
          : (typeof deps?.getBlockDataFile === 'function' ? deps.getBlockDataFile('writer') : null)
            || path.join(__dirname, '..', '..', '..', '..', 'data', 'writer'),
      ).fs;

  try { fs.mkdirSync(''); } catch {}

  const docTitle = (id) => {
    try {
      const idx = JSON.parse(fs.readFileSync('_index.json', 'utf8'));
      return (idx.find(d => d.id === id) || {}).title || 'Untitled';
    } catch { return 'Untitled'; }
  };

  // ── Templates ─────────────────────────────────────────────────────
  app.get('/api/writer/templates', (_req, res) => res.json({ ok: true, templates: TEMPLATES }));

  // ── Version history ───────────────────────────────────────────────
  const vDir = (id) => path.posix.join('versions', String(id).replace(/[^A-Za-z0-9_-]/g, ''));

  app.get('/api/writer/versions/:id', (req, res) => {
    const dir = vDir(req.params.id);
    let list = [];
    try {
      list = fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
        const ts = Number(f.replace('.md', ''));
        const st = fs.statSync(path.posix.join(dir, f));
        return { ts, when: new Date(ts).toISOString(), size: st.size };
      }).sort((a, b) => b.ts - a.ts);
    } catch {}
    res.json({ ok: true, versions: list });
  });

  app.get('/api/writer/version/:id/:ts', (req, res) => {
    const fp = path.posix.join(vDir(req.params.id), `${Number(req.params.ts)}.md`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Version not found' });
    res.json({ ok: true, content: fs.readFileSync(fp, 'utf8') });
  });

  app.post('/api/writer/restore/:id/:ts', (req, res) => {
    const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    const fp = path.posix.join(vDir(id), `${Number(req.params.ts)}.md`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Version not found' });
    try {
      const docPath = `${id}.md`;
      // Snapshot the current state before rolling back — restore is never destructive.
      if (fs.existsSync(docPath)) {
        fs.writeFileSync(path.posix.join(vDir(id), `${Date.now()}.md`), fs.readFileSync(docPath, 'utf8'));
      }
      const content = fs.readFileSync(fp, 'utf8');
      fs.writeFileSync(docPath, content);
      res.json({ ok: true, content });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Word export — an .doc file Word/LibreOffice/Pages open natively ──
  app.get('/api/writer/export/:id.doc', (req, res) => {
    const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    const fp = `${id}.md`;
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const title = docTitle(id);
    const body = mdToHtml(fs.readFileSync(fp, 'utf8'));
    const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Calibri,Georgia,serif;font-size:12pt;line-height:1.6;max-width:7in;margin:1in auto;color:#111}
h1{font-size:20pt}h2{font-size:15pt;color:#1f3763}h3{font-size:13pt}blockquote{border-left:3pt solid #999;margin-left:0;padding-left:12pt;color:#555}
code{font-family:Consolas,monospace;background:#f2f2f2;padding:1pt 4pt}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^A-Za-z0-9 _-]/g, '').trim() || id}.doc"`);
    res.send(html);
  });
};
