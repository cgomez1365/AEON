#!/usr/bin/env node
/**
 * aeon CLI — two surfaces behind one binary.
 *
 * DX1 (block authoring, Ship Plan v2 Month 1) — deterministic, never an LLM:
 *   aeon lint <id|path>   deterministic gate checks (schema + code) — run BEFORE submitting
 *   aeon pack <id>        lint + bundle a store-ready .aeon cartridge into dist-blocks/
 *   aeon promote <id>     staging/<id> → src/blocks/<id> through the lint airlock
 *   aeon dev <id>         isolated dev server on :3002 (staging/ or src/blocks/), hot-remount on save
 *   aeon new <id>         copy _template into staging/<id> and personalize
 *
 * BO-TGM (God Mode terminal) — operate a running AEON without a browser:
 *   aeon "<natural language>"   intent-routed, falls back to the model
 *   aeon shell                  interactive REPL
 *   aeon status | blocks | commands | run | login | logout
 *
 * God Mode is a CLIENT of the kernel's existing command bus
 * (src/kernel/commandRegistry.cjs → /api/commands, /api/commands/dispatch).
 * It deliberately owns no dispatch logic of its own: confirmation gates,
 * when-clauses and permissions stay enforced server-side, so the terminal
 * cannot become a way around them.
 */
const path = require('path');
const fs   = require('fs');
const { lintBlock, promoteBlock, ensureStagingDir, BLOCKS_DIR, STAGING_DIR } = require('../src/kernel/staging.cjs');

const argv = process.argv.slice(2);
const [cmd, arg] = argv;
const ROOT = path.join(__dirname, '..');

const flags = {
  json:  argv.includes('--json'),
  noLlm: argv.includes('--no-llm'),
  yes:   argv.includes('--yes') || argv.includes('-y'),
};
function flagValue(...names) {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  }
  return null;
}

function resolveBlockDir(idOrPath) {
  if (!idOrPath) return null;
  for (const candidate of [
    path.resolve(idOrPath),
    path.join(STAGING_DIR, idOrPath),
    path.join(BLOCKS_DIR, idOrPath),
  ]) {
    if (fs.existsSync(path.join(candidate, 'block.manifest.json'))) return candidate;
  }
  return null;
}

function printLint(result, dir) {
  console.log(`\naeon lint — ${dir}`);
  console.log(`score: ${result.score}`);
  if (result.errors.length) { console.log('ERRORS:'); result.errors.forEach(e => console.log(`  ✗ ${e}`)); }
  if (result.findings.length) {
    console.log('FINDINGS:');
    result.findings.forEach(f => console.log(`  [${f.sev}] ${f.check} in ${f.file} — ${f.why}`));
  }
  if (!result.errors.length && !result.findings.length) console.log('  ✓ clean');
}

const commands = {
  lint() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg} (looked in staging/, src/blocks/, and as a path)`); process.exit(1); }
    const result = lintBlock(dir);
    printLint(result, dir);
    process.exit(result.errors.length || result.findings.some(f => f.sev === 'HIGH') ? 1 : 0);
  },

  pack() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg}`); process.exit(1); }
    const result = lintBlock(dir);
    if (result.errors.length || result.findings.some(f => f.sev === 'HIGH')) {
      printLint(result, dir);
      console.error('\npack refused — fix lint first. Nothing goes to the store without passing pack.');
      process.exit(1);
    }
    const AdmZip = require('adm-zip');
    const m = result.manifest;
    const outDir = path.join(ROOT, 'dist-blocks');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${m.id}-${m.version || '0.0.0'}.aeon`);
    const zip = new AdmZip();
    zip.addLocalFolder(dir, m.id, (p) => !/(^|[\/\\])(data|node_modules|\.aeon\.runtime\.json)([\/\\]|$)/.test(p));
    zip.writeZip(outFile);
    console.log(`✓ packed ${outFile} (score ${result.score})`);
  },

  promote() {
    const r = promoteBlock(arg);
    if (!r.ok) {
      console.error(`✗ ${r.error}`);
      if (r.lint) printLint(r.lint, path.join(STAGING_DIR, arg));
      process.exit(1);
    }
    console.log(`✓ promoted ${r.promoted} → src/blocks/ (score ${r.score}). ${r.note}`);
  },

  new() {
    if (!arg || !/^[a-z0-9_]+$/.test(arg) || arg.startsWith('_')) {
      console.error('usage: aeon new <id>  (lowercase a-z0-9_, no leading underscore)');
      process.exit(1);
    }
    ensureStagingDir();
    const dst = path.join(STAGING_DIR, arg);
    if (fs.existsSync(dst)) { console.error(`staging/${arg} already exists`); process.exit(1); }
    fs.cpSync(path.join(BLOCKS_DIR, '_template'), dst, { recursive: true });
    const mPath = path.join(dst, 'block.manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    m.id = arg; m.route = `/${arg}`; m.label = arg.replace(/_/g, ' ');
    m.nav.hidden = false; m.nav.label = m.label;
    m.routes = [{ method: 'ALL', path: `/${arg}/*`, auth: true }];
    m.description = '';
    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
    console.log(`✓ staging/${arg} created from _template. Edit it, then: aeon lint ${arg} && aeon promote ${arg}`);
  },

  dev() {
    const dir = resolveBlockDir(arg);
    if (!dir) { console.error(`block not found: ${arg}`); process.exit(1); }
    const express = require('express');
    const app = express();
    app.use(express.json());
    let mounted = [];

    const mount = () => {
      app._router && (app._router.stack = app._router.stack.filter(l => !l._aeonDev));
      mounted = [];
      const apiDir = path.join(dir, 'api');
      if (fs.existsSync(apiDir)) {
        for (const f of fs.readdirSync(apiDir).filter(f => /\.(cjs|js)$/.test(f) && !f.startsWith('_'))) {
          const full = path.join(apiDir, f);
          delete require.cache[require.resolve(full)]; // hot-remount = full module cache purge (B6)
          try {
            const factory = require(full);
            // dev deps are deliberately empty-ish: isolated block sees no production state (DX2)
            const devDeps = { isVercel: false, fs, path, getLocalFile: (n) => path.join(dir, 'data', n) };
            if (typeof factory === 'function') {
              if (factory.length === 1) { const r = factory(devDeps); if (r) { const layer = app.use('/api', r); } }
              else factory(app, devDeps);
              mounted.push(f);
            }
          } catch (e) { console.error(`  mount failed ${f}: ${e.message}`); }
        }
      }
      console.log(`[aeon dev] mounted: ${mounted.join(', ') || '(no api files)'}`);
    };

    mount();
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.watch(dir, { recursive: true }, (_evt, file) => {
      if (file && /\.(cjs|js|jsx|json)$/.test(file) && !file.includes('data')) {
        console.log(`[aeon dev] change: ${file} → remounting`);
        try { mount(); } catch (e) { console.error(e.message); }
      }
    });
    app.get('/', (_req, res) => res.json({ dev: true, block: path.basename(dir), apis: mounted, note: 'isolated dev server — sees its own data/ only (DX2)' }));
    app.listen(3002, () => console.log(`[aeon dev] ${path.basename(dir)} on http://localhost:3002 (isolated, staging-safe)`));
  },

  // ── God Mode (BO-TGM) ────────────────────────────────────────────────────
  shell() {
    return require('./terminal/repl.cjs').start({ json: flags.json });
  },

  async status() {
    const client = require('./terminal/client.cjs');
    const render = require('./terminal/renderers.cjs');
    const { c } = client;
    const s = await client.ping();
    if (flags.json) return console.log(JSON.stringify(s, null, 2));

    const { commands, source } = await client.getCommands();
    console.log('');
    console.log(render.box([
      `${c.dim('server  ')} ${s.connected ? c.green('● running') : c.red('○ not running')}`,
      `${c.dim('url     ')} ${client.baseUrl()}`,
      `${c.dim('version ')} ${s.version || c.dim('—')}`,
      `${c.dim('uptime  ')} ${s.uptime ? `${Math.floor(s.uptime / 60)}m ${s.uptime % 60}s` : c.dim('—')}`,
      `${c.dim('portable')} ${s.portable ? c.neon('yes — offline, local model') : c.dim('no')}`,
      `${c.dim('vault   ')} ${s.authRequired ? c.yellow('locked') : c.green('unlocked')}`,
      `${c.dim('session ')} ${client.loadSession() ? c.green('stored') : c.dim('none')}`,
      `${c.dim('commands')} ${commands.length} ${c.dim(`(via ${source})`)}`,
    ], { title: 'AEON STATUS' }));
    console.log('');
    if (!s.connected) console.log(c.dim(`  Start a server with \`npm run server\`, or set AEON_URL.\n`));
  },

  async commands() {
    const client = require('./terminal/client.cjs');
    const render = require('./terminal/renderers.cjs');
    const { c } = client;
    const { commands, source } = await client.getCommands();
    if (flags.json) return console.log(JSON.stringify(commands, null, 2));

    console.log(`\n  ${c.bold(String(commands.length))} commands ${c.dim(`(via ${source})`)}\n`);
    const byBlock = {};
    for (const s of commands) (byBlock[s.blockLabel || s.blockId] ||= []).push(s);
    for (const [label, list] of Object.entries(byBlock).sort()) {
      console.log(`  ${c.bold(label)}`);
      for (const s of list) {
        const flag = s.available === false ? c.dim(' (unavailable)') : s.dangerous ? c.yellow(' ⚠') : '';
        console.log(`    ${c.neon(s.cmd.padEnd(18))} ${c.dim(s.title || s.desc || '')}${flag}`);
      }
      console.log('');
    }
  },

  async blocks() {
    const client = require('./terminal/client.cjs');
    const render = require('./terminal/renderers.cjs');
    const res = await client.withAuth(() => client.request('GET', '/api/god/blocks'));
    if (flags.json) return console.log(JSON.stringify(res.data, null, 2));
    if (!res.ok) {
      // Fall back to what the manifests say — works with no server at all.
      const { commands } = await client.getCommands();
      const ids = [...new Set(commands.map((s) => s.blockId))];
      console.log(`\n${render.table(ids.map((id) => ({ block: id, commands: commands.filter((s) => s.blockId === id).length })))}\n`);
      return;
    }
    const list = res.data?.blocks || res.data || [];
    console.log(`\n${render.table(list.map((b) => ({
      block: b.id || b.name, label: b.label || '', ready: b.ready !== false,
    })))}\n`);
  },

  async login()  { const c1 = require('./terminal/client.cjs'); console.log(''); await c1.login(); console.log(''); },
  async logout() {
    const c1 = require('./terminal/client.cjs');
    console.log(c1.clearSession() ? `\n  ${c1.c.green('✓')} session discarded\n` : `\n  ${c1.c.dim('no session stored')}\n`);
  },

  /**
   * aeon agent "<goal>" [--steps N] [-y]
   *
   * Multi-step: the model plans, calls one registered command, reads the real
   * result, and decides the next step — until the goal is met or the cap is
   * hit. Every dangerous step still hits the kernel's confirmation gate.
   */
  async agent() {
    const agent = require('./terminal/agent.cjs');
    const client = require('./terminal/client.cjs');
    const { c } = client;
    const goal = argv.slice(1).filter((a) => !a.startsWith('-') && a !== flagValue('--steps')).join(' ').trim();
    if (!goal) {
      console.error(`usage: aeon agent "<goal>" [--steps N] [-y]\n\n  ${c.dim('aeon agent "save a note about tonight\'s build and show me my memories"')}`);
      process.exit(1);
    }
    await client.requireConnected();
    const maxSteps = Number(flagValue('--steps')) || agent.DEFAULT_MAX_STEPS;
    console.log(`\n  ${c.neon('●')} ${c.bold('AEON')} ${c.dim('· agent')}  ${c.dim(goal)}\n`);
    const out = await agent.run(goal, {
      maxSteps,
      yes: flags.yes,
      json: flags.json,
      confirm: async (prompt) => {
        const answer = await client.prompt(`\n  ${c.yellow('⚠')} ${prompt} ${c.dim('[y/N] ')}`);
        return /^y(es)?$/i.test(answer.trim());
      },
    });
    if (flags.json) console.log(JSON.stringify(out, null, 2));
    else if (!out.ok && out.reason && out.reason !== 'needs-input') {
      console.log(`\n  ${c.yellow('!')} stopped: ${out.reason}${out.at ? ` at ${out.at}` : ''}\n`);
    }
    process.exitCode = out.ok ? 0 : 1;
  },

  /**
   * aeon install <https-url | cartridge-name>
   *
   * "Here's a link to a block I bought — install it." Routes through the
   * SAME command bus as everything else (master.install → /api/store/install),
   * so the cartridge still goes through the airlock: lint gate → staging →
   * approval queue → promote → rescan. The CLI adds no install logic of its
   * own and cannot skip a step; the 428 confirmation is the kernel's.
   */
  async install() {
    const client = require('./terminal/client.cjs');
    const render = require('./terminal/renderers.cjs');
    const { c } = client;
    if (!arg) {
      console.error(`usage: aeon install <https-url | cartridge-name>

  ${c.dim('aeon install https://store.example.com/my-block-1.0.0.aeon')}
  ${c.dim('aeon install my-block')}          ${c.dim('# from dist-blocks/')}
  ${c.dim('aeon run /catalog')}              ${c.dim('# what is already available locally')}`);
      process.exit(1);
    }
    // https:// is enforced server-side too (store.cjs) — this is just a
    // clearer message than a 422 round trip.
    if (/^https?:\/\//i.test(arg) && !/^https:\/\//i.test(arg)) {
      console.error(`\n  ${c.red('✗')} cartridge URLs must be https\n`);
      process.exit(1);
    }
    const source = /^https:\/\//i.test(arg) ? { url: arg } : { name: arg };
    await dispatchAndRender(client, render, 'master.install', '', {
      json: flags.json, yes: flags.yes, body: source, label: 'installing',
    });
  },

  // aeon run <block.cmd|/cmd> [arg…] — explicit, no routing, no model.
  async run() {
    const client = require('./terminal/client.cjs');
    const render = require('./terminal/renderers.cjs');
    const { c } = client;
    if (!arg) { console.error('usage: aeon run <command> [arg…]   (see: aeon commands)'); process.exit(1); }
    const rest = argv.slice(argv.indexOf(arg) + 1).filter((a) => !a.startsWith('--')).join(' ');
    await dispatchAndRender(client, render, arg, rest, { json: flags.json, yes: flags.yes });
  },
};

// Shared dispatch + render path for `run` and for NL routing.
async function dispatchAndRender(client, render, cmdOrId, argText, { json, yes, renderer, label, body } = {}) {
  const { c } = client;
  const spin = render.spinner(label || 'working');
  let res;
  try { res = await client.dispatch(cmdOrId, argText, { timeout: 180000, body }); }
  finally { spin.stop(); }

  // The kernel owns the confirmation gate (428). The CLI only relays it —
  // --yes pre-confirms, it does not bypass the check.
  if (res.status === 428 && res.data?.requiresConfirmation) {
    if (!yes) {
      const answer = await client.prompt(`\n  ${c.yellow('⚠')} ${res.data.prompt} ${c.dim('[y/N] ')}`);
      if (!/^y(es)?$/i.test(answer.trim())) { console.log(`  ${c.dim('cancelled')}\n`); return null; }
    }
    const spin2 = render.spinner(label || 'working');
    try { res = await client.dispatch(cmdOrId, argText, { confirmed: true, timeout: 180000, body }); }
    finally { spin2.stop(); }
  }

  if (!res.ok) {
    if (json) console.log(JSON.stringify(res.data, null, 2));
    else console.error(`\n  ${c.red('✗')} ${res.data?.error || `failed (${res.status})`}\n`);
    process.exitCode = 1;
    return res;
  }
  console.log('');
  console.log(render.auto(res.data, { renderer, query: argText, json }));
  console.log('');
  return res;
}

// Natural language: `aeon "grade my resume"`. Anything that is not a known
// subcommand and is not a flag lands here.
async function naturalLanguage(input) {
  const client = require('./terminal/client.cjs');
  const render = require('./terminal/renderers.cjs');
  const router = require('./terminal/router.cjs');
  const { c } = client;

  const { commands } = await client.getCommands();
  const spin = render.spinner('routing');
  let route;
  try { route = await router.routeCommand(input, commands, { noLlm: flags.noLlm }); }
  finally { spin.stop(); }

  if (!route || route.ok === false) {
    console.error(`\n  ${c.yellow('?')} nothing matched ${c.dim(`"${input}"`)}`);
    if (route?.suggestions?.length) {
      console.error(`\n  ${c.dim('did you mean:')}`);
      for (const s of route.suggestions) console.error(`    ${c.neon(s.cmd.padEnd(18))} ${c.dim(s.title)}`);
    }
    console.error(`\n  ${c.dim('`aeon commands` lists everything available.')}\n`);
    process.exit(1);
  }

  if (!flags.json) {
    console.log(`\n  ${c.neon('●')} ${c.bold('AEON')} ${c.dim('· God Mode')}`);
    console.log(c.dim('  ' + '─'.repeat(45)));
    console.log(`  ${c.dim('Routing →')} ${c.bold(route.blockLabel)} ${c.dim('/')} ${route.cmd}`
      + (route.via === 'llm' ? c.dim('   (model-routed)') : ''));
  }
  await dispatchAndRender(client, render, route.id || route.cmd, route.arg, {
    json: flags.json, yes: flags.yes, label: route.title || 'working',
  });
}

function usage() {
  const { c } = require('./terminal/client.cjs');
  console.log(`
${c.neon(c.bold('aeon'))} ${c.dim('— AEON terminal')}

${c.bold('GOD MODE')} ${c.dim('(operate a running AEON, no browser)')}
  aeon ${c.dim('"<natural language>"')}   route by intent, model as fallback
  aeon shell                interactive REPL — history, tab complete, context
  aeon status               server, vault, model, portable state
  aeon commands             every command the manifests declare
  aeon blocks               mounted blocks and readiness
  aeon run ${c.dim('<cmd> [arg…]')}     dispatch one command, no routing
  aeon agent ${c.dim('"<goal>"')}       multi-step: plan → act → read → repeat
  aeon install ${c.dim('<url|name>')}   install a block cartridge via the airlock
  aeon login ${c.dim('|')} logout       manage this terminal's session

${c.bold('BLOCK AUTHORING')} ${c.dim('(deterministic, never calls a model)')}
  aeon new <id>             scaffold into staging/
  aeon lint <id>            deterministic gate checks
  aeon dev <id>             isolated dev server :3002
  aeon pack <id>            build .aeon cartridge
  aeon promote <id>         staging → src/blocks via airlock

${c.bold('FLAGS')}
  --json                    machine-readable output
  --no-llm                  intent matching only, never call a model
  -y, --yes                 pre-confirm dangerous commands

${c.dim('Examples')}
  ${c.dim('$')} aeon status
  ${c.dim('$')} aeon ${c.dim('"what did I save about competitor pricing"')}
  ${c.dim('$')} aeon shell
`);
}

(async () => {
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
  }
  // A quoted sentence, or anything that isn't a known subcommand, is intent.
  // Bare flags are never treated as natural language.
  if (!commands[cmd]) {
    if (cmd.startsWith('-')) { usage(); process.exit(1); }
    const input = argv.filter((a) => !a.startsWith('--') && a !== '-y').join(' ');
    await naturalLanguage(input);
    return;
  }
  await commands[cmd]();
})().catch((e) => {
  const { c } = require('./terminal/client.cjs');
  console.error(`\n  ${c.red('✗')} ${e.stack || e.message}\n`);
  process.exit(1);
});
