/**
 * No two blocks may claim the same slash command.
 *
 * BO-SHIP P8, 2026-08-12.
 *
 * The architecture is exactly as designed: a block declares its commands in
 * contract.commands, commandRegistry.cjs discovers them from the manifests, and
 * the terminal populates itself from GET /api/commands. Remove the block and
 * the command leaves with it. Terminal2.jsx even says so — "Block commands come
 * from GET /api/commands (manifest-discovered); add nothing here." Nothing is
 * hardcoded except four UI-only commands that act on the terminal itself.
 *
 * What was missing was a gate. §20 #6 requires that no ROUTE is claimed by two
 * blocks, and there is a collision test for it. Nothing said the same about
 * COMMAND NAMES, and commandRegistry resolves a clash with "first declaration
 * wins" — where "first" means whatever readdir returns, i.e. alphabetical.
 *
 * So `/write` belonged to host_os (h < w), not to Writer:
 *
 *   host_os  /write -> POST /api/fs/write        params filePath, content
 *   writer   /write -> POST /api/writer/generate param  prompt
 *
 * Typing `/write a draft to the it guy saying thank you` therefore reached the
 * dangerous filesystem write with no filePath, and the operator got
 * `The "path" argument must be of type string. Received undefined` — operator
 * finding F-04. Writer's own /write was unreachable by name and had been since
 * both blocks shipped.
 *
 * A silent winner is the problem. Two blocks may legitimately want a verb; what
 * is not acceptable is the product picking one by directory order and telling
 * nobody.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const BLOCKS = path.join(__dirname, '..', 'src', 'blocks');

/** Every declared command, with the block that declared it. */
function declaredCommands() {
  const out = [];
  for (const block of fs.readdirSync(BLOCKS)) {
    const file = path.join(BLOCKS, block, 'block.manifest.json');
    if (!fs.existsSync(file)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const c of (manifest.contract?.commands || [])) {
      if (!c.cmd || !c.route) continue;
      out.push({ block, cmd: c.cmd, route: c.route, dangerous: !!c.dangerous });
    }
  }
  return out;
}

describe('slash command namespace', () => {
  it('no command name is claimed by two blocks', () => {
    const seen = new Map();
    const collisions = [];

    for (const d of declaredCommands()) {
      if (seen.has(d.cmd)) {
        const first = seen.get(d.cmd);
        collisions.push(
          `${d.cmd}: ${first.block} (${first.route}) shadows ${d.block} (${d.route})`
        );
      } else {
        seen.set(d.cmd, d);
      }
    }

    expect(
      collisions,
      'a slash command resolves by directory order, so the loser is unreachable '
      + 'by name and the operator is never told which one they got',
    ).toEqual([]);
  });

  it('every declared command names a route and a cmd', () => {
    for (const block of fs.readdirSync(BLOCKS)) {
      const file = path.join(BLOCKS, block, 'block.manifest.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const c of (manifest.contract?.commands || [])) {
        expect(c.cmd, `${block} declares a command with no cmd`).toBeTruthy();
        expect(c.route, `${block} declares ${c.cmd} with no route`).toBeTruthy();
        expect(c.cmd.startsWith('/'), `${block}: ${c.cmd} must start with /`).toBe(true);
      }
    }
  });

  // The specific regression. Named, because a generic collision test going
  // green would not tell anyone that THIS pairing was the operator-visible bug.
  it('/write belongs to writer, not to the filesystem', () => {
    const write = declaredCommands().filter((d) => d.cmd === '/write');
    expect(write).toHaveLength(1);
    expect(write[0].block).toBe('writer');
    expect(write[0].route).toBe('/api/writer/generate');
  });

  it('the filesystem write kept a command, under a name that says what it does', () => {
    const wf = declaredCommands().filter((d) => d.cmd === '/writefile');
    expect(wf).toHaveLength(1);
    expect(wf[0].block).toBe('host_os');
    expect(wf[0].dangerous, 'a filesystem write must stay marked dangerous').toBe(true);
  });

  // A command that shadows a UI-only command is the same defect one layer up:
  // the terminal merges its own four with the registry, and its own win.
  it('no block claims a terminal-local command name', () => {
    const UI_ONLY = ['/clear', '/help', '/open', '/model'];
    const clashes = declaredCommands()
      .filter((d) => UI_ONLY.includes(d.cmd))
      .map((d) => `${d.block} declares ${d.cmd}, which the terminal handles itself`);
    expect(clashes).toEqual([]);
  });
});

/**
 * A block may not advertise a command another block implements.
 *
 * BO-SHIP P9b. dashboard declared /note, /push and /pull and implemented NONE
 * of them: /api/notes lives in files/api/notes.js, and /sync/bulk-push and
 * /sync/bulk-pull live in aeon_matrix/api/sync.cjs.
 *
 * That is not cosmetic. The dispatcher gates a command on the readiness of the
 * block that DECLARES it, so all three were gated on dashboard's requirements
 * — supabase, groq, gemini AND local — while their handlers needed only
 * supabase. /note was unavailable for want of an AI provider it never calls.
 *
 * §12: a block is a product boundary. A command is part of that boundary, so
 * it belongs to whoever serves it.
 *
 * This check is deliberately narrow. A broader "is this route mounted at all"
 * gate was attempted and NOT shipped — routes mounted behind a router prefix
 * (/api/autopilot/*, /api/console/*, /api/build/*) are invisible to a scanner
 * and it produced seven false positives against commands that demonstrably
 * work. §19: a gate that cries wolf gets skipped. Routes served by the KERNEL
 * are therefore accepted here; only a route implemented inside a DIFFERENT
 * block's api/ directory is a violation, and that is unambiguous.
 */
describe('a command belongs to the block that serves it', () => {
  function apiSources(block) {
    const dir = path.join(BLOCKS, block, 'api');
    const out = [];
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(cjs|js)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(dir);
    return out;
  }

  it('no block declares a command another block implements', () => {
    const blocks = fs.readdirSync(BLOCKS).filter((b) => !b.startsWith('_')
      && fs.existsSync(path.join(BLOCKS, b, 'block.manifest.json')));
    const cache = {};
    const sourcesOf = (b) => (cache[b] ||= apiSources(b));

    const foreign = [];
    for (const b of blocks) {
      const m = JSON.parse(fs.readFileSync(path.join(BLOCKS, b, 'block.manifest.json'), 'utf8'));
      for (const c of (m.contract?.commands || [])) {
        if (!c.route) continue;
        const tail = c.route.replace(/^\/api/, '');
        const serves = (s) => s.includes(tail) || s.includes(c.route);
        if (sourcesOf(b).some(serves)) continue;               // own block serves it
        const owner = blocks.find((o) => o !== b && sourcesOf(o).some(serves));
        if (owner) foreign.push(`${b} declares ${c.cmd} but ${owner} implements ${c.route}`);
        // else: kernel-served. Accepted — see the note above.
      }
    }

    expect(
      foreign,
      'the dispatcher gates a command on the DECLARING block\'s readiness, so a '
      + 'misplaced command is gated on requirements its handler does not have',
    ).toEqual([]);
  });
});

/**
 * The lifecycle the CEO described, asserted rather than assumed:
 * a block declares a command, the terminal discovers it, and removing the
 * block takes the command with it.
 *
 * This is the property that makes blocks a product boundary (§12) instead of a
 * folder convention. It was believed to work and had never been tested, so the
 * command namespace could drift without anything noticing — which is how a
 * collision shipped.
 */
describe('a command lives and dies with its block', () => {
  const created = [];
  afterEach(() => {
    for (const d of created.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    delete process.env.AEON_BLOCKS_DIR;
  });

  /** A scratch blocks tree containing copies of real manifests. */
  function scratchBlocks(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cmds-'));
    created.push(dir);
    for (const n of names) {
      fs.mkdirSync(path.join(dir, n), { recursive: true });
      fs.copyFileSync(
        path.join(BLOCKS, n, 'block.manifest.json'),
        path.join(dir, n, 'block.manifest.json'),
      );
    }
    return dir;
  }

  /** Build the registry against `dir` and return { api, list }. */
  function registryOver(dir) {
    process.env.AEON_BLOCKS_DIR = dir;
    // Both resolve their root at module scope, so clear them before requiring.
    delete require.cache[require.resolve('../src/kernel/blocksDir.cjs')];
    delete require.cache[require.resolve('../src/kernel/commandRegistry.cjs')];
    const api = require('../src/kernel/commandRegistry.cjs')({ blockReadiness: {} });
    const app = express();
    app.use('/api', api.router);

    const list = async () => {
      const server = await new Promise((r) => { const i = app.listen(0, '127.0.0.1', () => r(i)); });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/commands`);
        const body = await res.json();
        return (body.commands || []).map((c) => c.cmd).sort();
      } finally {
        await new Promise((r) => server.close(r));
      }
    };
    return { api, list };
  }

  it('serves the commands a present block declares', async () => {
    const dir = scratchBlocks(['writer', 'orion_search']);
    const { list } = registryOver(dir);
    const cmds = await list();
    expect(cmds).toContain('/write');
    expect(cmds).toContain('/docs');
    expect(cmds).toContain('/orion');
  });

  it('drops them when the block is removed and the registry rescans', async () => {
    const dir = scratchBlocks(['writer', 'orion_search']);
    const { api, list } = registryOver(dir);
    expect(await list()).toContain('/write');

    fs.rmSync(path.join(dir, 'writer'), { recursive: true, force: true });
    api.rescan();

    const after = await list();
    expect(after, 'writer commands survived the block being removed').toEqual(['/orion']);
  });

  it('scaffolds contribute no commands', async () => {
    // _blank and _template are skipped by the leading underscore. If that ever
    // changed, every install would grow placeholder commands.
    const dir = scratchBlocks(['orion_search']);
    fs.mkdirSync(path.join(dir, '_template'), { recursive: true });
    fs.copyFileSync(
      path.join(BLOCKS, 'writer', 'block.manifest.json'),
      path.join(dir, '_template', 'block.manifest.json'),
    );
    const { list } = registryOver(dir);
    expect(await list()).toEqual(['/orion']);
  });
});
