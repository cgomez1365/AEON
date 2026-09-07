/**
 * BO-MEM review findings — three containment defects, closed and pinned.
 *
 * Raised by an adversarial review of the branch. All three are the same shape:
 * a value that crosses a trust boundary and is then used as if it had not.
 *
 *   1. POST /crn/second-brain/ingest/chat interpolated `session_id` straight
 *      into a filesystem path while its two sibling routes twelve lines away
 *      both called resolveVaultPath() and 403'd on escape. It appended caller
 *      text to the resulting file, then read the whole file back, embedded it
 *      and indexed it — so the same call was a write primitive AND a read
 *      primitive for any .md the process could reach. Pre-existing, and
 *      harmless only while nothing called the route; BO-MEM made it the
 *      sanctioned way a conversation enters the record.
 *   2. writeSession() built a filename from the `id` INSIDE the record rather
 *      than the validated URL parameter, so the check that guarded the read
 *      path was absent on all three write paths.
 *   3. An embedding endpoint's raw response body was spliced into an error that
 *      is rendered inside the model's context block — bytes from someone else's
 *      server, positioned as AEON's own system context.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ingestFactory = require('../src/blocks/aeon_matrix/api/ingest.cjs');
beforeEach(() => { ingestFactory._resetStores(); });
const createChatRouter = require('../src/blocks/dashboard/api/chat.cjs');

let root, vault, dataRoot, servers;

const listen = (router) => new Promise((resolve) => {
  const a = express();
  a.use(express.json());
  a.use('/api', router);
  const server = a.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-containment-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  servers = [];
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const post = async (port, route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

describe('ingest/chat cannot write outside the Vault', () => {
  const TRAVERSALS = [
    '../../../../../../tmp/aeon-escape',
    '..%2F..%2Fescape',
    'a/../../b',
    'Chat_History/../../escape',
    './../escape',
  ];

  it('refuses every traversal shape, and writes nothing', async () => {
    const h = await listen(ingestFactory({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot,
      embed: async () => ({ vector: [0.1], model: 'stub' }),
    }));
    servers.push(h.server);

    const outside = path.join(os.tmpdir(), 'aeon-escape.md');
    try { fs.rmSync(outside, { force: true }); } catch {}

    for (const session_id of TRAVERSALS) {
      const r = await post(h.port, '/crn/second-brain/ingest/chat', {
        session_id,
        messages: [{ role: 'user', content: 'this is more than twenty characters of payload text' }],
      });
      expect([400, 403], `accepted traversal ${session_id}`).toContain(r.status);
    }

    expect(fs.existsSync(outside), 'a file was written outside the vault').toBe(false);
  });

  it('an ordinary session id still works', async () => {
    const h = await listen(ingestFactory({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot,
      embed: async () => ({ vector: [0.1], model: 'stub' }),
    }));
    servers.push(h.server);

    // The real shape the dashboard mints: an ISO timestamp with separators
    // replaced. If the guard rejected this, the feature would be dead.
    const r = await post(h.port, '/crn/second-brain/ingest/chat', {
      session_id: '2026-09-06T19-42-11-000Z',
      messages: [{ role: 'user', content: 'how do the vault keyslots recover if I lose the env file' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.ingested).toBe(1);
    expect(fs.existsSync(path.join(vault, 'Chat_History', '2026-09-06T19-42-11-000Z.md'))).toBe(true);
  });

  it('does not read a file outside the vault back into the index', async () => {
    // The route reads the file it just appended to, embeds it and indexes it.
    // Without containment that made it a read primitive: point it at an
    // existing .md anywhere and its contents enter the Second Brain.
    // Two levels up from <root>/Vault/Chat_History. The first draft of this
    // test went up only one and therefore never left the vault — it passed with
    // the defect present, which is the class BO-H closed.
    const secret = path.join(root, 'outside-secret.md');
    fs.writeFileSync(secret, '# Private\nthe master key lives in the env file', 'utf8');

    const h = await listen(ingestFactory({
      isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot,
      embed: async () => ({ vector: [0.1], model: 'stub' }),
    }));
    servers.push(h.server);

    await post(h.port, '/crn/second-brain/ingest/chat', {
      session_id: '../../outside-secret',
      messages: [{ role: 'user', content: 'twenty or more characters of text here' }],
    });

    const indexPath = path.join(dataRoot, 'vault_index.json');
    const raw = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    expect(raw).not.toMatch(/master key lives/);
  });
});

describe('a session record cannot smuggle an id past the write path', () => {
  it('refuses a record whose internal id disagrees with its filename', async () => {
    const sessionsDir = path.join(vault, 'Agents', 'Aeon', 'chat_sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // A file another authenticated route could have written: valid filename,
    // hostile id inside.
    fs.writeFileSync(path.join(sessionsDir, 'planted.json'), JSON.stringify({
      id: '../../../../../../tmp/aeon-session-escape',
      name: 'looks ordinary',
      messages: [{ role: 'user', content: 'hello' }],
    }), 'utf8');

    const h = await listen(createChatRouter({ isVercel: false, VAULT_ROOT: vault, kernelLLM: null }));
    servers.push(h.server);

    const r = await fetch(`http://127.0.0.1:${h.port}/api/terminal/sessions/planted`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'payload' }),
    });

    // Refused at read: the filename and the id inside it must agree.
    expect(r.status).toBe(404);
    expect(fs.existsSync(path.join(os.tmpdir(), 'aeon-session-escape.json'))).toBe(false);
  });

  it('a well-formed record still renames', async () => {
    const h = await listen(createChatRouter({ isVercel: false, VAULT_ROOT: vault, kernelLLM: null }));
    servers.push(h.server);
    const created = await post(h.port, '/terminal/sessions', {
      messages: [{ role: 'user', content: 'ordinary conversation about the vault' }],
    });
    const r = await fetch(`http://127.0.0.1:${h.port}/api/terminal/sessions/${created.body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(r.status).toBe(200);
  });
});

describe('an embedding endpoint cannot speak into the model’s context', () => {
  it('keeps the remote response body out of the operator-facing error', async () => {
    const embed = require('../src/kernel/embed.cjs');
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/kernel/embed.cjs'),
      'utf8',
    );
    // The failure message travels: embed.cjs -> retrieve.cjs unavailable.message
    // -> context.cjs, which renders it inside [AEON SECOND BRAIN CONTEXT] with
    // imperative framing. A third party's bytes must not ride that path.
    expect(src).not.toMatch(/returned \$\{res\.status\}\. \$\{body\}/);
    expect(src).toMatch(/console\.warn\(`\[EMBED\] endpoint/);
    expect(typeof embed.kernelEmbed).toBe('function');
  });
});
