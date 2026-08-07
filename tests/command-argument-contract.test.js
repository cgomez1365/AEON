/**
 * BO-D2e — the command surface, which is the operator's primary interface.
 *
 * NINE of BO-D's twenty-four findings land here, and they are not nine bugs.
 * They are three root causes:
 *
 *   1. NO ARGUMENT CONTRACT. Commands accept whatever is typed and fail deep
 *      inside the implementation.
 *        /read            → EXIT 1 · "ENOENT ... open ''"
 *      A raw Node error with an empty path, from fs.open(''), because the
 *      dispatcher forwarded an empty string as `filePath` without ever
 *      asking whether the command needed one.
 *
 *   2. SILENT ARGUMENT LOSS. The worst of the nine:
 *        /memory My name is cristian → EXIT 0 → {"memories":[],"count":0}
 *      The operator typed a save. /memory declares param "q", so the text
 *      became a SEARCH QUERY, matched nothing, and exited 0. Nothing was
 *      saved, nothing failed, and the screen said success. Same family as
 *      D2a's "User data saved" — a command that cannot do what it was asked
 *      must say so, never succeed quietly.
 *
 *   3. IDENTIFIER VOCABULARY IS NOT SHARED. Cookbook displays
 *      "Mistral 7B Instruct v0.3 (Q4_K_M)"; /model-pull demands a catalogue
 *      id or org/repo. The operator is shown one vocabulary and required to
 *      use another.
 *
 * The contract belongs in the registry, not in each command — one
 * declaration per command, validated BEFORE dispatch. That also gives /help
 * and the palette real usage strings for free.
 *
 * Drives the real registry. Nothing is re-implemented inline.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createRegistry = require('../src/kernel/commandRegistry.cjs');

let app;
beforeAll(() => {
  const { router } = createRegistry({ blockReadiness: {}, isVercel: false, writeOSAudit: () => {} });
  app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
});

async function dispatch(body) {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function listCommands() {
  const { createServer } = await import('http');
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands`);
    return (await res.json()).commands;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

describe('root cause 1 — a required argument is checked before dispatch', () => {
  it('/read with no argument is refused with a usage line, not ENOENT', async () => {
    const { status, body } = await dispatch({ cmd: '/read' });
    // The defect: this reached fs.open('') and returned a raw Node error.
    expect(body.error || '').not.toMatch(/ENOENT/);
    expect(status).toBe(400);
    // §08 — an error must name the remedy.
    expect(body.usage).toBe('/read <filePath>');
    expect(body.error).toMatch(/requires/i);
  });

  it('the refusal happens in the dispatcher, so no request is made at all', async () => {
    // A command refused for a missing argument must not reach its block —
    // that is what stops implementations inventing their own error shapes.
    const { body } = await dispatch({ cmd: '/read', arg: '   ' });
    expect(body.usage).toBeTruthy();
    expect(body.ok).toBe(false);
  });

  it('/read WITH an argument is not blocked by the contract', async () => {
    const { status, body } = await dispatch({ cmd: '/read', arg: 'README.md' });
    // It may still fail downstream — the block owns that — but it must not
    // be refused by the argument gate.
    expect(body.usage).toBeUndefined();
    expect(status).not.toBe(400);
  });
});

describe('root cause 2 — an argument that cannot be used is never accepted quietly', () => {
  it('a command taking no arguments says so instead of dropping them', async () => {
    // /scan declares no param. Text typed after it previously vanished.
    const { status, body } = await dispatch({ cmd: '/scan', arg: 'some text the operator typed' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/takes no argument/i);
    expect(body.usage).toBe('/scan');
  });

  it('/memory with text is not silently turned into an empty search', async () => {
    // The operator typed a save. It became a search query, matched nothing,
    // and exited 0.
    const { status, body } = await dispatch({ cmd: '/memory', arg: 'My name is cristian' });
    expect(status).not.toBe(200);
    // It must point at the command that actually saves.
    expect(`${body.error} ${body.hint || ''}`).toMatch(/remember/i);
  });

  it('/memory as a search still works when it looks like a search', async () => {
    const { body } = await dispatch({ cmd: '/memory', arg: 'cristian' });
    expect(body.usage).toBeUndefined();
  });
});

describe('every command can state its own usage', () => {
  it('the registry exposes a usage string for all of them', async () => {
    const commands = await listCommands();
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c.usage, `${c.cmd} has no usage`).toBeTruthy();
      expect(c.usage.startsWith(c.cmd), `${c.cmd} usage should start with the command`).toBe(true);
    }
  });

  it('a command with a required argument shows it', async () => {
    const read = (await listCommands()).find(c => c.cmd === '/read');
    expect(read.usage).toBe('/read <filePath>');
    expect(read.argRequired).toBe(true);
  });

  it('a command with no argument shows none', async () => {
    const scan = (await listCommands()).find(c => c.cmd === '/scan');
    expect(scan.usage).toBe('/scan');
    expect(scan.argRequired).toBe(false);
  });
});

describe('an unknown command is still an honest failure', () => {
  it('names what was typed', async () => {
    const { status, body } = await dispatch({ cmd: '/definitely-not-a-command' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/definitely-not-a-command/);
  });
});
