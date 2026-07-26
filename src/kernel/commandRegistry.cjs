/**
 * AEON Command Registry — the kernel's command bus (Terminal 2.0).
 *
 * Manifest-as-truth: every block declares commands in block.manifest.json
 * under contract.commands[]. This registry scans manifests at boot (and on
 * kernel.rescan), namespaces each command by its owning block, and exposes:
 *
 *   GET  /api/commands           → full registry (palette renders records)
 *   POST /api/commands/dispatch  → { cmd, arg } → validate → gate → invoke
 *
 * The dispatcher owns confirmation gates (dangerous: true) and when-clause
 * checks centrally — no block implements its own. Invocation proxies to the
 * block's declared route via internal fetch, so blocks keep their own
 * handlers and permissions sandbox. mode:'stream' pipes SSE through.
 *
 * CommandSpec (manifest, legacy fields still accepted):
 *   { cmd:"/gpu", desc, route, method, param?, display?,   ← legacy
 *     mode?: "instant"|"stream"|"view", dangerous?: bool,
 *     when?: "ready", template?: "GPU: {name}", category? }
 *
 * Response envelope (every dispatch): { ok, id, text, data, meta }
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

function scanCommands(readiness = {}) {
  const registry = new Map(); // "/cmd" → spec
  let folders = [];
  try {
    folders = fs.readdirSync(BLOCKS_DIR).filter(f =>
      !f.startsWith('_') && fs.existsSync(path.join(BLOCKS_DIR, f, 'block.manifest.json')));
  } catch { return registry; }

  for (const folder of folders) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(BLOCKS_DIR, folder, 'block.manifest.json'), 'utf8')); }
    catch { continue; }
    const cmds = manifest?.contract?.commands || [];
    for (const c of cmds) {
      if (!c.cmd || !c.route) continue;
      const name = c.cmd.replace(/^\//, '');
      const spec = {
        id: `${folder}.${name}`,          // host-enforced namespacing
        cmd: c.cmd,
        blockId: folder,
        blockLabel: manifest.label || folder,
        title: c.title || c.desc || name,
        desc: c.desc || '',
        category: c.category || manifest.nav?.group || 'block',
        route: c.route,
        method: (c.method || 'POST').toUpperCase(),
        param: c.param || null,
        display: c.display || null,
        mode: c.mode || 'instant',
        dangerous: !!c.dangerous,
        when: c.when || null,
        template: c.template || null,
      };
      // First declaration wins on a cmd collision; both remain reachable by id.
      if (!registry.has(c.cmd)) registry.set(c.cmd, spec);
      registry.set(spec.id, spec);
    }
  }
  return registry;
}

// Minimal when-clause evaluator: "ready", "!ready", "runtime==local" etc.
function evalWhen(expr, ctx) {
  if (!expr) return true;
  return expr.split('&&').every(clause => {
    const c = clause.trim();
    if (c.includes('==')) {
      const [k, v] = c.split('==').map(s => s.trim());
      return String(ctx[k]) === v;
    }
    if (c.startsWith('!')) return !ctx[c.slice(1).trim()];
    return !!ctx[c];
  });
}

function renderTemplate(tpl, data) {
  return tpl.replace(/\{([\w.]+)\}/g, (_, key) => {
    const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    return val == null ? '—' : String(val);
  });
}

module.exports = function ({ blockReadiness = {}, isVercel = false, writeOSAudit } = {}) {
  const router = express.Router();
  let registry = scanCommands(blockReadiness);
  const rescan = () => { registry = scanCommands(blockReadiness); return registry.size; };

  // ── GET /commands — the palette's data source ──
  router.get('/commands', (req, res) => {
    const seen = new Set();
    const list = [];
    for (const spec of registry.values()) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      const ready = blockReadiness[spec.blockId]?.ready !== false;
      list.push({ ...spec, available: ready && evalWhen(spec.when, { ready, runtime: isVercel ? 'cloud' : 'local' }) });
    }
    res.json({ ok: true, count: list.length, commands: list });
  });

  // ── POST /commands/dispatch — { cmd | id, arg, confirmed } ──
  router.post('/commands/dispatch', async (req, res) => {
    const { cmd, id, arg = '', confirmed = false } = req.body || {};
    const spec = registry.get(id) || registry.get(cmd);
    if (!spec) return res.status(404).json({ ok: false, error: `Unknown command: ${id || cmd}` });

    const ready = blockReadiness[spec.blockId]?.ready !== false;
    if (!evalWhen(spec.when, { ready, runtime: isVercel ? 'cloud' : 'local' })) {
      return res.status(409).json({ ok: false, id: spec.id, error: `${spec.cmd} unavailable (when: ${spec.when})` });
    }

    // Central confirmation gate — the dispatcher asks, never the block.
    if (spec.dangerous && !confirmed) {
      return res.status(428).json({
        ok: false, id: spec.id, requiresConfirmation: true,
        prompt: `${spec.blockLabel}: ${spec.title}${arg ? ` "${arg}"` : ''} — confirm to execute.`,
      });
    }

    const port = Number(process.env.PORT) || 3001;
    const base = `http://127.0.0.1:${port}`;
    let url = spec.route.startsWith('http') ? spec.route : base + spec.route;
    const init = { method: spec.method, headers: { 'Content-Type': 'application/json' } };
    // The internal fetch below is a brand-new HTTP request from the server to
    // itself — it carries none of the caller's session unless forwarded
    // explicitly. Without this, the guard (authGate.cjs) 401s the internal
    // call for any non-preauth route, and a fully authenticated terminal
    // session sees every such command fail with UNAUTHORIZED_SESSION. Found
    // by the settings/terminal stress test (2026-07-26): 17 of 21 registered
    // commands route to non-preauth endpoints and were all silently broken
    // whenever guardEnabled was on.
    if (req.headers.authorization) init.headers.Authorization = req.headers.authorization;
    if (req.headers.cookie) init.headers.Cookie = req.headers.cookie;
    if (spec.method === 'GET') {
      if (spec.param && arg) url += `${url.includes('?') ? '&' : '?'}${spec.param}=${encodeURIComponent(arg)}`;
    } else {
      init.body = JSON.stringify(spec.param ? { [spec.param]: arg } : (arg ? { arg } : {}));
    }

    try {
      const upstream = await fetch(url, init);

      // Stream mode: pipe SSE straight through to the terminal.
      if (spec.mode === 'stream' && upstream.ok && upstream.body) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        return res.end();
      }

      const data = await upstream.json().catch(() => ({}));
      const text = spec.template ? renderTemplate(spec.template, data)
        : spec.display ? data[spec.display]
        : (data.text ?? data.answer ?? data.content ?? data.message ?? null);

      if (writeOSAudit) { try { writeOSAudit('CMD', spec.id, upstream.status, 0, req.correlationId || 'AEON-SYS'); } catch {} }

      res.status(upstream.ok ? 200 : upstream.status).json({
        ok: upstream.ok,
        id: spec.id,
        text: text ?? (upstream.ok ? null : (data.error || `Command failed (${upstream.status})`)),
        data,
        meta: { block: spec.blockLabel, cmd: spec.cmd, mode: spec.mode },
      });
    } catch (e) {
      res.status(502).json({ ok: false, id: spec.id, error: `${spec.blockLabel}: ${e.message}` });
    }
  });

  router.post('/commands/rescan', (req, res) => res.json({ ok: true, count: rescan() }));

  return { router, rescan };
};
