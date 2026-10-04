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
 *     when?: "ready", template?: "GPU: {name}", category?,
 *     takesLocalOnly?: bool,    ← the route keeps its model calls on this
 *                                 computer when its body says localOnly
 *     takesAgent?: bool,        ← the body carries `agent` (the terminal's agent)
 *     takesHistory?: bool }     ← the body carries `history` (the terminal's
 *                                 recent turns, capped)
 *
 * Response envelope (every dispatch): { ok, id, text, data, meta }
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const { BLOCKS_DIR } = require('./blocksDir.cjs');

// What a takesHistory command may receive of the terminal's conversation.
const HISTORY_MAX_TURNS = 20;
const HISTORY_MAX_CHARS_PER_TURN = 4000;

/** The terminal's turns, capped: the last 20, 4,000 characters each. */
function capHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-HISTORY_MAX_TURNS)
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({
      role: String(t.role || 'user').slice(0, 20),
      content: String(t.content ?? '').slice(0, HISTORY_MAX_CHARS_PER_TURN),
      ...(typeof t.agent === 'string' ? { agent: t.agent.slice(0, 64) } : {}),
    }));
}

/**
 * The usage line for a command, derived from what it already declares.
 *
 * BO-D2e. Every command in the registry can state how to call it without a
 * block author writing anything new: a `param` names the single argument,
 * `params` names the structured fields, and neither means the command takes
 * nothing. `argHint` overrides the derived name where a friendlier one helps
 * ("<path>" rather than "<filePath>").
 */
function buildUsage(c) {
  const cmd = c.cmd;
  if (c.argHint) return `${cmd} ${c.argHint}`;
  if (c.param) return `${cmd} <${c.param}>`;
  if (Array.isArray(c.params) && c.params.length) {
    return `${cmd} ${c.params.map(p => `<${typeof p === 'string' ? p : p.name}>`).join(' ')}`;
  }
  return cmd;
}

/** Strip one layer of "…", '…' or <…> from a typed value. */
function unwrap(v) {
  const t = String(v ?? '').trim();
  const m = t.match(/^(?:"(.*)"|'(.*)'|<(.*)>)$/s);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : t;
}

/**
 * Split typed arguments on whitespace, keeping quoted and <bracketed> groups whole and unwrapped.
 *
 * One linear pass. The regex this replaced (/"([^"]*)"|'([^']*)'|<([^>]*)>|(\S+)/g)
 * rescanned the rest of the line for every unclosed "<", so "<= <= <= …"
 * took quadratic time (CodeQL, 2026-10-03). The next closing character after
 * every position is found once, from the right; the tokens are the same.
 */
function tokenizeArgs(text) {
  const s = String(text || '');
  const nextOf = {};
  for (const ch of ['"', "'", '>']) {
    const at = new Array(s.length + 1).fill(-1);
    for (let i = s.length - 1; i >= 0; i--) at[i] = s[i] === ch ? i : at[i + 1];
    nextOf[ch] = at;
  }
  const isSpace = (c) => /\s/.test(c);
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (isSpace(s[i])) { i++; continue; }
    const close = s[i] === '<' ? '>' : (s[i] === '"' || s[i] === "'") ? s[i] : null;
    const j = close ? nextOf[close][i + 1] : -1;
    if (j !== -1) { out.push(s.slice(i + 1, j).trim()); i = j + 1; continue; }
    let k = i;
    while (k < s.length && !isSpace(s[k])) k++;
    out.push(s.slice(i, k).trim());
    i = k;
  }
  return out;
}

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
        // Multi-field commands (fs/write needs {filePath, content}) can't be
        // expressed by the single `param`. `params` names the fields a caller
        // must supply via the dispatch `body`; it is descriptive only — the
        // block's own handler still validates. Consumed by the agent loop and
        // by `aeon commands` so a caller knows what to fill in.
        params: Array.isArray(c.params) ? c.params : null,
        display: c.display || null,
        mode: c.mode || 'instant',
        dangerous: !!c.dangerous,
        when: c.when || null,
        template: c.template || null,
        // ── BO-D2e: the argument contract ──────────────────────────────
        // Declared once, here, and enforced by the dispatcher before a
        // command ever reaches its block. Nine of BO-D's findings came from
        // its absence: /read with no argument reached fs.open('') and
        // returned "ENOENT ... open ''", and text typed after a command that
        // takes none simply vanished.
        //
        // `argRequired` defaults to false so no existing command changes
        // behaviour by being scanned. A block opts in.
        argRequired: !!c.argRequired,
        argHint: c.argHint || null,
        // An input shape this command cannot serve, with the remedy. Used
        // where a command's argument is valid syntax but the wrong INTENT —
        // /memory searching for a sentence the operator meant to save.
        rejectArg: (c.rejectArg && c.rejectArg.pattern && c.rejectArg.error) ? c.rejectArg : null,
        // What the operator should have typed. Derivable for every command
        // in the registry, which is why /help and the palette get usage
        // strings for free rather than each command inventing one.
        usage: buildUsage(c),
        // The route honours `localOnly: true` in its body (embeds and asks
        // only models on this computer or the LAN). The dispatcher sets it
        // when the terminal's agent is set to Local only.
        takesLocalOnly: !!c.takesLocalOnly,
        // The route acts for the terminal's agent (`agent` in its body), and
        // reads the conversation so far (`history`, capped). /handoff takes
        // both. Only routes that declare them get the fields.
        takesAgent: !!c.takesAgent,
        takesHistory: !!c.takesHistory,
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
  if (!expr) return !!ctx.ready;
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

module.exports = function ({ blockReadiness = {}, isVercel = false, writeOSAudit, kernelLLM = null, isCloudLinked = null, hasEmbedding = null, vaultRoot = null } = {}) {
  // The agent a terminal command runs for — the one the terminal names, else
  // the operator's own AEON (the chat stream's rule) — when it is set to
  // Local only in Memory Core; else null. Read per request: the switch can
  // change while AEON runs.
  const localOnlyAgent = (ref) => {
    if (!vaultRoot) return null;
    try {
      const agentsKernel = require('./agents.cjs');
      const all = agentsKernel.list(vaultRoot, { withStats: false });
      const a = agentsKernel.ownerOf(vaultRoot, ref, all);
      return a && a.privacy === 'local-only' ? a : null;
    } catch { return null; }
  };
  // Live, not cached: the operator can link Supabase in Settings without a restart.
  const cloudLinked = () => { try { return typeof isCloudLinked === 'function' ? !!isCloudLinked() : false; } catch { return false; } };
  // Live as well: the vault commands (/ask /recall /scan /index-brain /upload)
  // declare `when: "embed"`. They used to vanish from the palette whenever
  // their block was not ready and, when the block WAS ready but no embedding
  // model existed, ran and died three layers down with "no_embed_model". The
  // gate asks the same resolver the indexer uses, at request time, so the
  // moment Cookbook finishes downloading nomic-embed the command is back —
  // no restart, no rescan.
  const embedReady = () => {
    try {
      if (typeof hasEmbedding === 'function') return !!hasEmbedding();
      const ep = require('./endpoints.cjs');
      return !!ep.describeRoleLocal(ep.EMBED_ROLE).ok;
    } catch { return false; }
  };
  const ctxFor = (ready) => ({ ready, runtime: isVercel ? 'cloud' : 'local', supabase: cloudLinked(), embed: embedReady() });

  // One sentence naming the cause AND the remedy. Shared by the palette (so an
  // unavailable command is shown dimmed with its reason instead of hidden) and
  // by dispatch (the 409). BO-SHIP P8e wrote the first two branches.
  const explainUnavailable = (spec, readinessInfo, ready) => {
    const missing = [
      ...(readinessInfo.missingApis || []),
      ...(readinessInfo.localMissing || []),
    ];
    const when = String(spec.when || '');
    const why = !ready && missing.length
      ? `${spec.blockLabel} needs: ${missing.join(', ')}. Add them in Settings → Keys.`
      : !ready
        ? `${spec.blockLabel} is not ready.`
        : /\bsupabase\b/.test(when)
          // A cloud command on a local install said "unavailable (when: …)"
          // or, worse, ran and reported success having synced nothing. It
          // names the dependency and the remedy, and says nothing is lost.
          ? `${spec.cmd} syncs with Supabase, and this install is not linked to one. Add SUPABASE_URL and a key to .env and restart, or stay local — nothing is lost.`
          : /\bembed\b/.test(when)
            ? `${spec.cmd} needs an embedding model and none is available. Download one in Cookbook (nomic-embed, about 150 MB, runs on CPU), or assign an endpoint that serves embeddings to the Embedding role in Settings → Model Assignment.`
            : `${spec.cmd} is unavailable in this runtime (requires: ${spec.when}).`;
    return { why, missing };
  };

  const router = express.Router();
  const narrator = require('./commandNarrator.cjs');
  let registry = scanCommands(blockReadiness);
  const rescan = () => { registry = scanCommands(blockReadiness); return registry.size; };

  // ── GET /commands — the palette's data source ──
  router.get('/commands', (req, res) => {
    const seen = new Set();
    const list = [];
    for (const spec of registry.values()) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      const readinessInfo = blockReadiness[spec.blockId] || {};
      const ready = readinessInfo.ready !== false;
      const available = ready && evalWhen(spec.when, ctxFor(ready));
      // `reason` rides along so the palette can SAY why, not just grey out.
      list.push({ ...spec, available, reason: available ? null : explainUnavailable(spec, readinessInfo, ready).why });
    }
    res.json({ ok: true, count: list.length, commands: list });
  });

  // ── POST /commands/narrate — read a command result back as a sentence ──
  //
  // BO-SHIP P7. Separate from dispatch, and opt-in, for three reasons:
  //   - narrating every command would spend tokens the operator did not ask
  //     for, on a free tier that throttles after a few calls;
  //   - a slow model must never delay the result itself. The payload arrives
  //     first and the sentence catches up;
  //   - a narration failure must not be able to fail a command that succeeded.
  //
  // The raw payload is returned alongside the prose so the UI can reveal it.
  // R-05: the payload stays the source of truth; the sentence is a rendering.
  router.post('/commands/narrate', async (req, res) => {
    const { cmd = '/command', ok = false, text = null, data = null, error = null, title = null, agent = null } = req.body || {};
    // A Local only agent's command result is narrated by a local model or
    // not at all (the narrator falls back to its own sentence).
    const privateTo = localOnlyAgent(agent);
    const llm = privateTo && typeof kernelLLM === 'function'
      ? (prompt, opts = {}) => {
        const { localOnly, localOnlyReason, localOnlyRemedy } = require('./agents.cjs').callOptions(privateTo);
        return kernelLLM(prompt, { ...opts, localOnly, localOnlyReason, localOnlyRemedy });
      }
      : kernelLLM;
    try {
      const out = await narrator.narrate({ cmd, ok, text, data, error, title }, llm);
      res.json({ ok: true, ...out });
    } catch (e) {
      // Even the narrator failing is narrated honestly rather than 500ing.
      res.json({
        ok: true,
        narration: narrator.deterministicNarration({ cmd, ok, text, data, error }),
        source: 'deterministic',
        raw: { ok, text, data, error },
        narratorError: e.message,
      });
    }
  });

  // ── POST /commands/dispatch — { cmd | id, arg, body?, confirmed } ──
  // `arg` is the single-string form every command has always used. `body` is
  // the structured form for commands whose route needs more than one field
  // (fs/write: {filePath, content}) — declared as `params` in the manifest.
  // When both are present `body` wins; `arg` alone keeps working unchanged.
  router.post('/commands/dispatch', async (req, res) => {
    const { cmd, id, arg = '', confirmed = false, body = null, agent = null, history = null } = req.body || {};
    const structured = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    const spec = registry.get(id) || registry.get(cmd);
    if (!spec) return res.status(404).json({ ok: false, error: `Unknown command: ${id || cmd}` });

    const readinessInfo = blockReadiness[spec.blockId] || {};
    const ready = readinessInfo.ready !== false;
    if (!evalWhen(spec.when, ctxFor(ready))) {
      // BO-SHIP P8e — this answered `"/push unavailable (when: null)"`: an
      // internal expression, printed at the operator, naming no cause and no
      // remedy. `when` is null for most commands, so the one thing the message
      // showed was the one thing that meant nothing.
      //
      // checkReadiness() already computes exactly what is missing
      // (missingApis, localMissing) and the dispatcher already had it in hand.
      const { why, missing } = explainUnavailable(spec, readinessInfo, ready);

      return res.status(409).json({
        ok: false,
        id: spec.id,
        error: `${spec.cmd} unavailable — ${why}`,
        blockId: spec.blockId,
        missing,
      });
    }

    // ── BO-D2e — the argument contract, enforced before the block sees it ──
    //
    // Deliberately here and not in each command. A command that validates
    // its own arguments fails in its own vocabulary, deep inside its own
    // implementation: /read reached fs.open('') and answered "ENOENT ...
    // open ''", a raw Node error naming no remedy and not even the command.
    const argText = typeof arg === 'string' ? arg.trim() : '';
    const takesArg = !!(spec.param || (spec.params && spec.params.length));

    if (spec.argRequired && !argText && !structured) {
      return res.status(400).json({
        ok: false, id: spec.id, usage: spec.usage,
        error: `${spec.cmd} requires an argument. Usage: ${spec.usage}`,
      });
    }

    // Silent argument loss — the worst of the nine. Text typed after a
    // command that cannot use it must never simply disappear into a
    // successful-looking run.
    if (argText && !takesArg && !structured) {
      return res.status(400).json({
        ok: false, id: spec.id, usage: spec.usage,
        error: `${spec.cmd} takes no arguments, but "${argText.slice(0, 60)}" was supplied. Usage: ${spec.usage}`,
      });
    }

    // A command may declare that some inputs are not questions it can answer.
    // /memory searches; an operator typing a fact at it meant to SAVE one,
    // and got an empty search reported as success.
    if (argText && spec.rejectArg) {
      const rx = new RegExp(spec.rejectArg.pattern, 'i');
      if (rx.test(argText)) {
        return res.status(400).json({
          ok: false, id: spec.id, usage: spec.usage,
          error: spec.rejectArg.error,
          hint: spec.rejectArg.hint || null,
        });
      }
    }

    // Central confirmation gate — the dispatcher asks, never the block.
    if (spec.dangerous && !confirmed) {
      // Show the actual target. A structured command (/write) carries no
      // `arg`, so without this the operator would be asked to confirm a
      // destructive action with a blank subject.
      const subject = arg
        ? ` "${arg}"`
        : structured
          ? ` ${Object.entries(structured).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ')}`
          : '';
      return res.status(428).json({
        ok: false, id: spec.id, requiresConfirmation: true,
        prompt: `${spec.blockLabel}: ${spec.title}${subject} — confirm to execute.`,
      });
    }

    // ── BO-SHIP P8d — multi-field commands, typed as one line ──────────
    //
    // A command declaring `params` (plural) could not be invoked from the
    // terminal at all. The payload below falls through to `{ arg }` when
    // `spec.param` (singular) is absent, so /writefile — params
    // ["filePath","content"] — reached POST /api/fs/write with BOTH fields
    // undefined and answered:
    //
    //     The "path" argument must be of type string. Received undefined
    //
    // That is the operator's F-04 error, reproduced exactly. `params` was
    // documented as "descriptive only — the caller must supply the fields via
    // the dispatch body", but the terminal has no way to build a body: it
    // sends what was typed. So every multi-field command was terminal-dead.
    //
    // Split positionally, with the LAST field absorbing the remainder — which
    // is how a person types it: `/writefile notes.txt some longer content`.
    // An explicit `body` still wins, so structured callers are unaffected.
    let fields = structured;
    if (!fields && Array.isArray(spec.params) && spec.params.length && argText) {
      const names = spec.params
        .map((p) => (typeof p === 'string' ? p : p?.name))
        .filter(Boolean);
      // Tokenise the way a person types: a value in "quotes", 'quotes' or
      // <angle brackets> is ONE value even with spaces, and the wrapper is
      // not part of it. The usage line prints placeholders as <filePath>;
      // an operator who typed them literally got a folder named
      // "<C:\\Users\\…" and an ENOENT from mkdir (2026-09-07).
      const parts = tokenizeArgs(argText);
      if (names.length) {
        fields = {};
        names.forEach((n, i) => {
          fields[n] = i === names.length - 1 ? parts.slice(i).join(' ') : (parts[i] ?? '');
        });
        const missing = names.filter((n) => !String(fields[n] || '').trim());
        if (missing.length) {
          // Name the fields. The block would otherwise fail in its own
          // vocabulary, deep inside its own implementation — the exact defect
          // the argument contract exists to prevent.
          return res.status(400).json({
            ok: false, id: spec.id, usage: spec.usage,
            error: `${spec.cmd} needs ${names.length} values (${names.join(', ')}); `
              + `missing: ${missing.join(', ')}. Usage: ${spec.usage} — the angle brackets mark placeholders; `
              + `type the values without them, and put quotes around a value that has spaces.`,
          });
        }
      }
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
      const qs = fields
        ? Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)
        : (spec.param && arg ? [[spec.param, arg]] : []);
      for (const [k, v] of qs) url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
    } else {
      const payload = fields || (spec.param ? { [spec.param]: unwrap(arg) } : (arg ? { arg } : {}));
      // Run for an agent set to Local only: a command whose route can keep
      // its model calls local is told to. Only routes that declare it get
      // the field, so it never lands in a body a route saves as given.
      if (spec.takesLocalOnly && localOnlyAgent(agent)) payload.localOnly = true;
      if (spec.takesAgent) payload.agent = typeof agent === 'string' && agent ? agent : null;
      if (spec.takesHistory && Array.isArray(history)) payload.history = capHistory(history);
      init.body = JSON.stringify(payload);
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

// Exposed for tests (the factory above is the module).
module.exports.tokenizeArgs = tokenizeArgs;
module.exports.capHistory = capHistory;
module.exports.HISTORY_MAX_TURNS = HISTORY_MAX_TURNS;
module.exports.HISTORY_MAX_CHARS_PER_TURN = HISTORY_MAX_CHARS_PER_TURN;
