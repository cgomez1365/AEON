/**
 * AEON Terminal — interactive shell (BO-TGM)
 *
 *   aeon shell
 *
 * Persistent session: history across runs, tab completion over the live
 * command registry, and enough turn context that "open 2" or "grade it
 * against this one instead" resolve against what just happened.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const client = require('./client.cjs');
const render = require('./renderers.cjs');
const router = require('./router.cjs');
const { c } = client;

const HISTORY_LIMIT = 500;

function historyFile() {
  const dataRoot = process.env.DATA_PATH || path.join(client.ROOT, 'data');
  return path.join(dataRoot, 'terminal', 'history');
}

function loadHistory() {
  try {
    return fs.readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT).reverse();
  } catch { return []; }
}

function appendHistory(line) {
  if (!line || !line.trim()) return;
  try {
    const f = historyFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, line + '\n');
  } catch {}
}

async function start({ json = false } = {}) {
  const status = await client.ping();
  let { commands } = await client.getCommands();

  // ── banner ──
  const modelLine = status.portable ? 'portable · local model' : (status.connected ? 'connected' : 'standalone');
  console.log('');
  console.log(render.box([
    c.neon(c.bold('AEON Terminal · God Mode')),
    null,
    status.connected
      ? `${c.dim('server ')} ${c.green('●')} ${client.baseUrl()}`
      : `${c.dim('server ')} ${c.yellow('○')} not running ${c.dim('(standalone)')}`,
    `${c.dim('vault  ')} ${status.authRequired ? c.yellow('locked — some commands need `login`') : c.green('unlocked')}`,
    `${c.dim('mode   ')} ${modelLine}`,
    `${c.dim('cmds   ')} ${commands.length} across ${new Set(commands.map((s) => s.blockId)).size} blocks`,
  ]));
  console.log(c.dim('\n  help  ·  status  ·  blocks  ·  exit        or just say what you want\n'));

  const history = loadHistory();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history,
    historySize: HISTORY_LIMIT,
    prompt: c.neon('aeon> '),
    completer(line) {
      const builtins = ['help', 'status', 'blocks', 'login', 'logout', 'clear', 'exit', 'quit', 'refresh'];
      const pool = [...builtins, ...commands.map((s) => s.cmd), ...commands.map((s) => s.id)];
      const hits = pool.filter((c0) => c0.startsWith(line));
      return [hits.length ? hits : pool, line];
    },
  });

  // Last result, so a follow-up turn can refer to it.
  let last = null;

  const builtin = {
    async help() {
      const byBlock = {};
      for (const s of commands) (byBlock[s.blockLabel] ||= []).push(s);
      console.log(`\n  ${c.bold('BUILT-IN')}`);
      for (const [cmd, desc] of [
        ['help', 'this list'], ['status', 'server, vault, and model state'],
        ['blocks', 'mounted blocks and readiness'], ['login', 'authenticate this terminal'],
        ['logout', 'discard the stored session'], ['refresh', 'rescan the command registry'],
        ['clear', 'clear the screen'], ['exit', 'leave the shell'],
      ]) console.log(`    ${c.neon(cmd.padEnd(10))} ${c.dim(desc)}`);

      console.log(`\n  ${c.bold('COMMANDS')} ${c.dim(`(${commands.length})`)}`);
      for (const [label, list] of Object.entries(byBlock).sort()) {
        console.log(`\n    ${c.bold(label)}`);
        for (const s of list) {
          const flag = s.available === false ? c.dim(' (unavailable)') : s.dangerous ? c.yellow(' ⚠') : '';
          console.log(`      ${c.neon(s.cmd.padEnd(18))} ${c.dim(s.title)}${flag}`);
        }
      }
      console.log(`\n  ${c.dim('Anything else is routed by intent — try: "what did I save about pricing"')}\n`);
    },

    async status() {
      const s = await client.ping();
      console.log('');
      console.log(render.box([
        `${c.dim('server  ')} ${s.connected ? c.green('● running') : c.red('○ not running')}`,
        `${c.dim('url     ')} ${client.baseUrl()}`,
        `${c.dim('version ')} ${s.version || c.dim('—')}`,
        `${c.dim('uptime  ')} ${s.uptime ? fmtUptime(s.uptime) : c.dim('—')}`,
        `${c.dim('portable')} ${s.portable ? c.neon('yes — offline, local model') : c.dim('no')}`,
        `${c.dim('vault   ')} ${s.authRequired ? c.yellow('locked') : c.green('unlocked')}`,
        `${c.dim('session ')} ${client.loadSession() ? c.green('stored') : c.dim('none')}`,
        `${c.dim('commands')} ${commands.length}`,
      ], { title: 'STATUS' }));
      console.log('');
    },

    async blocks() {
      const res = await client.withAuth(() => client.request('GET', '/api/god/blocks'));
      if (!res.ok) {
        // Standalone or locked — the manifests on disk still answer this.
        const ids = [...new Set(commands.map((s) => s.blockId))];
        console.log(`\n${render.table(ids.map((id) => ({ block: id, commands: commands.filter((s) => s.blockId === id).length })))}\n`);
        return;
      }
      const list = res.data?.blocks || res.data || [];
      console.log(`\n${render.table(list.map((b) => ({
        block: b.id || b.name,
        label: b.label || '',
        ready: b.ready !== false,
        routes: b.api_routes ?? b.routes ?? '',
      })))}\n`);
    },

    async login()  { console.log(''); await client.login(); console.log(''); },
    async logout() { console.log(client.clearSession() ? `\n  ${c.green('✓')} session discarded\n` : `\n  ${c.dim('no session stored')}\n`); },
    async refresh() {
      ({ commands } = await client.getCommands());
      console.log(`\n  ${c.green('✓')} ${commands.length} commands\n`);
    },
    async clear() { process.stdout.write('\x1b[2J\x1b[H'); },
  };

  const run = async (line) => {
    const input = line.trim();
    if (!input) return;
    appendHistory(input);

    if (['exit', 'quit', ':q'].includes(input.toLowerCase())) { rl.close(); return; }
    const bi = builtin[input.toLowerCase()];
    if (bi) return bi();

    // "open 2" / "2" after a search — act on the previous result.
    const pick = input.match(/^(?:open\s+)?(\d{1,2})$/);
    if (pick && last?.results?.length) {
      const idx = Number(pick[1]) - 1;
      const hit = last.results[idx];
      if (!hit) { console.log(`\n  ${c.yellow('!')} no result ${pick[1]}\n`); return; }
      console.log(`\n${render.markdown(hit.content || hit.text || hit.snippet || JSON.stringify(hit, null, 2))}\n`);
      return;
    }

    const spin = render.spinner('routing');
    let route;
    try { route = await router.routeCommand(input, commands); }
    finally { spin.stop(); }

    if (!route || route.ok === false) {
      console.log(`\n  ${c.yellow('?')} nothing matched ${c.dim(`"${input}"`)}`);
      if (route?.suggestions?.length) {
        console.log(`\n  ${c.dim('did you mean:')}`);
        for (const s of route.suggestions) console.log(`    ${c.neon(s.cmd.padEnd(18))} ${c.dim(s.title)}`);
      }
      console.log(`\n  ${c.dim('`help` lists everything available.')}\n`);
      return;
    }

    console.log(`  ${c.dim('→')} ${c.bold(route.blockLabel)} ${c.dim('/')} ${route.cmd}${route.via === 'llm' ? c.dim('  (routed)') : ''}`);

    // Confirmation is the kernel's call, not ours — it returns 428 and we ask.
    let res = await client.dispatch(route.id || route.cmd, route.arg, { timeout: 180000 });
    if (res.status === 428 && res.data?.requiresConfirmation) {
      const answer = await client.prompt(`  ${c.yellow('⚠')} ${res.data.prompt} ${c.dim('[y/N] ')}`);
      if (!/^y(es)?$/i.test(answer.trim())) { console.log(`  ${c.dim('cancelled')}\n`); return; }
      res = await client.dispatch(route.id || route.cmd, route.arg, { confirmed: true, timeout: 180000 });
    }

    if (!res.ok) {
      console.log(`\n  ${c.red('✗')} ${res.data?.error || `failed (${res.status})`}\n`);
      return;
    }

    const payload = res.data;
    const d = payload?.data || {};
    last = { results: d.results || d.hits || d.matches || null, payload };
    console.log('');
    console.log(render.auto(payload, { query: route.arg, json }));
    console.log('');
  };

  rl.prompt();
  rl.on('line', async (line) => {
    try { await run(line); }
    catch (e) { console.error(`\n  ${c.red('✗')} ${e.message}\n`); }
    rl.prompt();
  });

  return new Promise((resolve) => {
    rl.on('close', () => { console.log(c.dim('\n  bye\n')); resolve(); });
  });
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

module.exports = { start };
