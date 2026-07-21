// routes/compare.js — Model Comparison Arena: parallel blind A/B comparison
// Ported from compare_routes.py. Uses file-based JSON persistence.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createCompareRouter(deps) {
  const router = express.Router();
  const { getLocalFile, getDataFile, kernelLLM, writeOSAudit, VAULT_ROOT } = deps;

  // Manifest declares filesystem:'none' but this block always wrote to the
  // repo-relative path directly — on Vercel that's a read-only FS, and the
  // unguarded mkdirSync below ran at module-load time (outside any
  // try/catch), which could throw during the block's own mount. Redirect to
  // /tmp on Vercel (ephemeral, but writable) same as deep_research does.
  // Was also a depth-miscalculation bug: '../src/blocks/compare/data' from
  // council/api/ resolved to council/src/blocks/compare/data (nested garbage),
  // not the intended top-level location — getDataFile() fixes that structurally.
  const isVercel = !!process.env.VERCEL;
  const COMPARE_DIR = getDataFile ? getDataFile('council/compare') : path.join(__dirname, '../src/blocks/compare/data');
  const HISTORY_FILE = path.join(COMPARE_DIR, 'history.json');
  try { if (!fs.existsSync(COMPARE_DIR)) fs.mkdirSync(COMPARE_DIR, { recursive: true }); } catch {}

  function readHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
  }

  function writeHistory(data) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
  }

  // ── Council roster — persistent members the operator builds/edits ──────
  const DATA_DIR = getDataFile ? getDataFile('council') : path.join(__dirname, '..', 'data');
  const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
  // Debates persist to the Second Brain vault, so the debate history is a
  // first-class part of the brain (searchable, on every device via sync).
  // On Vercel this falls back to /tmp — ephemeral, but at least writable;
  // the vault mirror is the durable copy there, same pattern as deep_research.
  const DEBATES_DIR = isVercel
    ? path.join('/tmp', 'council_debates')
    : path.join(VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'), 'Agents', 'council', 'debates');
  for (const d of [DATA_DIR, DEBATES_DIR]) { try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {} }
  const crypto = require('crypto');
  const COLORS = ['#00f2ff', '#f59e0b', '#3ecf8e', '#b565d6', '#ff6b9d', '#7c3aed', '#ffb454'];

  // First-run seed is built from models AEON can ACTUALLY reach (Settings
  // roles + live keys + what Ollama reports pulled) — never a hardcoded
  // roster. No reachable models → empty roster, and the UI says so.
  const PERSONAS = [
    'A pragmatic generalist who takes clear stances.',
    'A skeptic who stress-tests every claim.',
    'A systems thinker focused on second-order effects.',
    'A first-principles reasoner who values rigor.',
  ];
  async function buildSeed() {
    let avail = [];
    try { avail = await liveModels(); } catch {}
    const picks = avail.slice(0, 4);
    const seed = picks.map((m, i) => ({
      id: 'm' + (i + 1), label: m.name || m.id, persona: PERSONAS[i % PERSONAS.length],
      provider: m.engine, model: m.id, color: COLORS[i % COLORS.length], chair: false,
    }));
    if (picks[0]) seed.push({ id: 'chair', label: `${picks[0].name || picks[0].id} (chair)`, persona: 'The chair — synthesizes the debate into a verdict.', provider: picks[0].engine, model: picks[0].id, color: COLORS[seed.length % COLORS.length], chair: true });
    return seed;
  }
  const loadMembers = () => {
    try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); }
    catch { return null; }
  };
  const saveMembers = (m) => { try { fs.writeFileSync(MEMBERS_FILE, JSON.stringify(m, null, 2)); } catch {} };

  // GET /council/members — seeds from live models on first run
  router.get('/council/members', async (_req, res) => {
    let members = loadMembers();
    if (!members) { members = await buildSeed(); saveMembers(members); }
    res.json({ members });
  });

  // GET /council/models — what AEON can actually reach (alias of live scan)
  router.get('/council/models', async (_req, res) => res.json({ models: await liveModels() }));

  // POST /council/members — add a councilor
  router.post('/council/members', (req, res) => {
    const { label, persona, provider, model, chair } = req.body || {};
    if (!label || !provider || !model) return res.status(400).json({ error: 'label, provider, model required' });
    const members = loadMembers() || [];
    const m = { id: crypto.randomBytes(4).toString('hex'), label, persona: persona || '', provider, model, color: COLORS[members.length % COLORS.length], chair: !!chair };
    members.push(m); saveMembers(members);
    res.json({ ok: true, member: m });
  });

  // PUT /council/members/:id — edit
  router.put('/council/members/:id', (req, res) => {
    const members = loadMembers() || [];
    const m = members.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    for (const k of ['label', 'persona', 'provider', 'model', 'chair']) if (req.body[k] !== undefined) m[k] = req.body[k];
    saveMembers(members);
    res.json({ ok: true, member: m });
  });

  // DELETE /council/members/:id
  router.delete('/council/members/:id', (req, res) => {
    let members = loadMembers() || [];
    const before = members.length;
    members = members.filter(x => x.id !== req.params.id);
    if (members.length === before) return res.status(404).json({ error: 'not found' });
    saveMembers(members);
    res.json({ ok: true });
  });

  // POST /council/debate/save — persist a completed debate to the vault
  router.post('/council/debate/save', (req, res) => {
    const { question, opinions, verdict } = req.body || {};
    if (!question || !verdict) return res.status(400).json({ error: 'question and verdict required' });
    const ts = new Date();
    const id = ts.toISOString().replace(/[:.]/g, '-');
    const lines = [
      `# Council debate — ${ts.toLocaleString()}`, '',
      `**Question:** ${question}`, '',
      '## Voices', '',
    ];
    for (const o of (opinions || [])) {
      lines.push(`### ${o.label}`, `*Opening:* ${o.opening || ''}`, '', `*Final:* ${o.revised || o.opening || ''}`, '');
    }
    lines.push('## Verdict', '', verdict, '');
    try { fs.writeFileSync(path.join(DEBATES_DIR, `${id}.md`), lines.join('\n')); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, id });
  });

  // GET /council/debates — history from the vault (newest first)
  router.get('/council/debates', (_req, res) => {
    let files = [];
    try {
      files = fs.readdirSync(DEBATES_DIR).filter(f => f.endsWith('.md'))
        .map(f => ({ f, mtime: fs.statSync(path.join(DEBATES_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    } catch {}
    const debates = files.map(({ f }) => {
      const body = fs.readFileSync(path.join(DEBATES_DIR, f), 'utf8');
      const q = (body.match(/\*\*Question:\*\* (.+)/) || [])[1] || f;
      return { id: f.replace('.md', ''), question: q, at: (body.match(/# Council debate — (.+)/) || [])[1] || '' };
    });
    res.json({ debates });
  });

  // GET /council/debate/:id — full transcript
  router.get('/council/debate/:id', (req, res) => {
    const p = path.join(DEBATES_DIR, `${path.basename(req.params.id)}.md`);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    res.json({ id: req.params.id, markdown: fs.readFileSync(p, 'utf8') });
  });

  // Per-provider menus shown ONLY when that provider is actually alive.
  // The old static AVAILABLE_MODELS (3 gemini + 4 groq, hardcoded) kept
  // offering dead providers no matter what Settings said.
  const PROVIDER_MENUS = {
    gemini: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
    ],
  };

  // Live-provider truth: env keys for cloud, /api/tags for ollama, plus
  // whatever models the operator's settings roles + endpoint registry name.
  async function liveModels() {
    const models = [];
    const seen = new Set();
    // Daemon truth for ollama: a settings role or registry entry can name a
    // model that was never pulled (or was deleted) — only offer what the
    // daemon actually reports.
    // Unreachable daemon means zero available models, not "unfiltered" — an
    // env var merely NAMING a host (OLLAMA_HOST in .env) is not proof
    // anything is actually listening there.
    let ollamaTags = [];
    try {
      const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      ollamaTags = (d.models || []).map(m => m.name);
    } catch {}
    const add = (id, name, engine) => {
      // A model is only offered if its provider is actually alive right now —
      // settings roles and registry entries can name dead/keyless providers.
      if (!engineAlive(engine)) return;
      if (engine === 'ollama' && !ollamaTags.includes(id)) return;
      const k = engine + '|' + id;
      if (!id || seen.has(k)) return;
      seen.add(k);
      models.push({ id, name: name || id, engine });
    };

    // Settings roles — the operator's actual choices come first
    try {
      const SETTINGS_FILE = path.join(__dirname, '..', '..', '..', 'aeon-settings.json');
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      for (const cfg of Object.values(s.models || {})) {
        if (cfg && cfg.provider && cfg.model) add(cfg.model, cfg.model, cfg.provider);
      }
    } catch {}

    // Endpoint registry role mappings
    try {
      const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const reg = await endpointsMod.load(null);
      const byId = Object.fromEntries((reg.endpoints || []).map(e => [e.id, e]));
      for (const m of Object.values(reg.roles || {})) {
        const ep = byId[m.endpoint_id];
        if (ep && m.model) add(m.model, m.model, ep.provider);
      }
    } catch {}

    // Cloud menus, gated on live keys
    if (process.env.GEMINI_FREE_KEY_1 || process.env.GEMINI_PAID_KEY)
      PROVIDER_MENUS.gemini.forEach(m => add(m.id, m.name, 'gemini'));
    if (process.env.GROQ_API_KEY)
      PROVIDER_MENUS.groq.forEach(m => add(m.id, m.name, 'groq'));

    // Ollama — whatever the daemon reported pulled (fetched once above)
    ollamaTags.forEach(t => add(t, `Ollama ${t}`, 'ollama'));
    return models;
  }

  // Filter dead engines: a model only survives if its provider has a live key
  // (ollama always counts as live — it's the local floor).
  let readLocalRuntime;
  try { ({ readLocalRuntime } = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'storage.js'))); }
  catch { readLocalRuntime = () => null; }
  const engineAlive = (engine) => {
    if (engine === 'ollama') {
      // OLLAMA_HOST merely NAMES a target — it's not proof anything is
      // listening there (this exact mistake shipped once already this
      // session). OLLAMA_MODEL similarly just names a tag someone wants,
      // not evidence it's installed. Actual liveness is decided by the real
      // /api/tags fetch in liveModels() (ollamaTags), which is what actually
      // gates which models get added — this flag only needs to answer
      // "is local a viable floor at all," which the Cookbook registry
      // (updated on every install/pull/delete) answers honestly.
      const rt = readLocalRuntime();
      return !!(rt?.runtimes?.ollama?.installed || rt?.models?.some(m => m.backend === 'ollama'));
    }
    if (engine === 'gemini') return !!(process.env.GEMINI_FREE_KEY_1 || process.env.GEMINI_PAID_KEY);
    if (engine === 'groq') return !!process.env.GROQ_API_KEY;
    if (engine === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
    if (engine === 'claude') return !!process.env.ANTHROPIC_API_KEY;
    return false;
  };

  async function callModel(engine, model, prompt) {
    const start = Date.now();
    let text = '';
    let error = null;
    try {
      if (!kernelLLM) throw new Error('kernelLLM unavailable');
      // kernelLLM dispatches every provider (incl. openrouter) and applies
      // health tracking — no per-provider request functions needed here.
      // Deliberation rounds and chair synthesis are long-form — the default
      // 4096-token cap (services/ai.js) can truncate a full synthesis reply.
      // (The request-timeout side of this bug class is already covered by
      // services/ai.js's global 240s fetchTimeout default — see deep_research.)
      text = await kernelLLM(prompt, { provider: engine, model, max_tokens: 6144 });
    } catch (e) {
      error = e.message;
    }
    const elapsed = Date.now() - start;
    return { text: text || '', error, elapsed_ms: elapsed, model, engine };
  }

  // GET /compare/models — available models, live providers only
  router.get('/compare/models', async (req, res) => {
    res.json({ models: await liveModels() });
  });

  // POST /compare/start — send prompt to multiple models in parallel
  router.post('/compare/start', async (req, res) => {
    const { prompt, models, is_blind = true } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (!Array.isArray(models) || models.length < 2) {
      return res.status(400).json({ error: 'At least 2 models required' });
    }
    if (models.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 models' });
    }

    const compId = crypto.randomUUID();
    const blind = is_blind !== false;

    let order = models.map((_, i) => i);
    if (blind) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }

    const shuffledModels = order.map(i => models[i]);

    const promises = shuffledModels.map(m => {
      // No hardcoded fallback engine: ollama is the only always-live floor.
      const engine = m.engine && engineAlive(m.engine) ? m.engine : 'ollama';
      const modelId = m.id || m.model;
      if (!modelId) return Promise.resolve({ text: '', error: 'model id required', elapsed_ms: 0, model: '?', engine });
      return callModel(engine, modelId, prompt);
    });

    const results = await Promise.allSettled(promises);

    const panes = results.map((r, i) => {
      const result = r.status === 'fulfilled' ? r.value : { text: '', error: r.reason?.message || 'Failed', elapsed_ms: 0, model: shuffledModels[i].id, engine: shuffledModels[i].engine };
      return {
        index: i,
        label: blind ? `Model ${String.fromCharCode(65 + i)}` : (shuffledModels[i].name || shuffledModels[i].id),
        text: result.text,
        error: result.error,
        elapsed_ms: result.elapsed_ms,
        model_id: blind ? null : result.model,
        engine: blind ? null : result.engine,
      };
    });

    let fastestIdx = 0;
    let fastestTime = Infinity;
    panes.forEach((p, i) => {
      if (!p.error && p.elapsed_ms < fastestTime) {
        fastestTime = p.elapsed_ms;
        fastestIdx = i;
      }
    });
    panes[fastestIdx].fastest = true;

    const comparison = {
      id: compId,
      prompt: prompt.slice(0, 500),
      models: shuffledModels.map(m => m.id || m.model),
      model_names: shuffledModels.map(m => m.name || m.id || m.model),
      is_blind: blind,
      order,
      created_at: new Date().toISOString(),
      winner: null,
      voted_at: null,
    };

    const history = readHistory();
    history.unshift(comparison);
    if (history.length > 200) history.length = 200;
    writeHistory(history);

    if (writeOSAudit) {
      writeOSAudit('COMPARE', `Started comparison: ${models.length} models, blind=${blind}`);
    }

    res.json({
      id: compId,
      panes,
      is_blind: blind,
      models: blind ? null : comparison.model_names,
    });
  });

  // POST /compare/:compId/vote — record winner and reveal models
  router.post('/compare/:compId/vote', (req, res) => {
    const { compId } = req.params;
    const { winner } = req.body;
    if (!winner) return res.status(400).json({ error: 'winner is required (pane index or "tie")' });

    const history = readHistory();
    const comp = history.find(c => c.id === compId);
    if (!comp) return res.status(404).json({ error: 'Comparison not found' });
    if (comp.winner) return res.status(400).json({ error: 'Already voted' });

    comp.winner = winner;
    comp.voted_at = new Date().toISOString();
    writeHistory(history);

    res.json({
      winner: comp.winner,
      models: comp.model_names,
      revealed: comp.model_names.map((name, i) => ({
        index: i,
        name,
        model_id: comp.models[i],
      })),
    });
  });

  // POST /compare/record — lightweight vote record from frontend
  router.post('/compare/record', (req, res) => {
    const { prompt, models, winner, is_blind = true } = req.body;
    if (!Array.isArray(models) || !winner) {
      return res.status(400).json({ error: 'models array and winner required' });
    }

    const compId = crypto.randomUUID();
    const comparison = {
      id: compId,
      prompt: (prompt || '').slice(0, 500),
      models,
      model_names: models,
      is_blind: !!is_blind,
      winner,
      voted_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const history = readHistory();
    history.unshift(comparison);
    if (history.length > 200) history.length = 200;
    writeHistory(history);

    res.json({ status: 'ok', id: compId });
  });

  // GET /compare/history — list past comparisons
  router.get('/compare/history', (req, res) => {
    const history = readHistory();
    const limit = parseInt(req.query.limit) || 50;
    res.json(history.slice(0, limit).map(c => ({
      id: c.id,
      prompt: (c.prompt || '').slice(0, 100),
      models: c.model_names || c.models,
      winner: c.winner,
      is_blind: c.is_blind,
      voted_at: c.voted_at,
      created_at: c.created_at,
    })));
  });

  // DELETE /compare/:compId — delete a comparison
  router.delete('/compare/:compId', (req, res) => {
    const { compId } = req.params;
    const history = readHistory();
    const idx = history.findIndex(c => c.id === compId);
    if (idx < 0) return res.status(404).json({ error: 'Comparison not found' });
    history.splice(idx, 1);
    writeHistory(history);
    res.json({ status: 'deleted' });
  });

  // GET /compare/scoreboard — aggregated model stats
  router.get('/compare/scoreboard', (req, res) => {
    const history = readHistory().filter(c => c.winner);
    const stats = {};

    for (const comp of history) {
      const names = comp.model_names || comp.models || [];
      for (const name of names) {
        if (!stats[name]) stats[name] = { wins: 0, losses: 0, ties: 0, games: 0 };
        stats[name].games++;
        if (comp.winner === 'tie') stats[name].ties++;
        else if (comp.winner === name) stats[name].wins++;
        else stats[name].losses++;
      }
    }

    const sorted = Object.entries(stats)
      .map(([name, s]) => ({
        name,
        ...s,
        win_pct: s.games ? Math.round(s.wins / s.games * 100) : 0,
      }))
      .sort((a, b) => b.win_pct - a.win_pct || b.games - a.games);

    res.json({ models: sorted, total_votes: history.length });
  });

  return router;
};
