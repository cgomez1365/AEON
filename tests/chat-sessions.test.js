/**
 * BO-MEM M2/M3/M4 — saved conversations: update, name, remember.
 *
 * Doctrine R09 (a conversation enters the record by operator decision, and the
 * model's own words are not stored as ordinary sources) and R10 (a name the
 * operator set is never overwritten by a model).
 *
 * What was here before: POST minted a fresh id on every call, so save-after-load
 * forked and the unload beacon wrote a new record on every page refresh; there
 * was no update path and no rename; `name` existed but no caller ever supplied
 * one, so every chat in the list was a locale-formatted timestamp; and GET and
 * DELETE interpolated req.params.id into a path with no validation before
 * DELETE unlinked it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createChatRouter = require('../src/blocks/dashboard/api/chat.cjs');

let tmp;
let app;
let matrixServer;
let kernelLLM;
let ingestCalls;

/** Drive the router over real HTTP so route params and status codes are real. */
async function listen(router) {
  const a = express();
  a.use(express.json());
  a.use('/api', router);
  return new Promise((resolve) => {
    const server = a.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let handle;
const api = async (method, route, body) => {
  const r = await fetch(`http://127.0.0.1:${handle.port}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sessions-'));
  ingestCalls = [];
  kernelLLM = vi.fn(async () => 'Vault Keyslot Recovery');

  // Stand in for the Aeon Matrix ingest route the "remember" action calls.
  const matrix = express();
  matrix.use(express.json());
  matrix.post('/api/crn/second-brain/ingest/chat', (req, res) => {
    ingestCalls.push(req.body);
    res.json({ ok: true, ingested: (req.body.messages || []).length, file: 'Chat_History/x.md' });
  });
  const m = await new Promise((resolve) => {
    const server = matrix.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  process.env.AEON_KERNEL_URL = `http://127.0.0.1:${m.port}`;
  matrixServer = m.server;

  const router = createChatRouter({
    isVercel: false,
    supabase: null,
    VAULT_ROOT: tmp,
    kernelLLM,
    getLocalFile: () => null,
    getDailyCost: () => 0,
    addRunCost: () => {},
    KILL_SWITCH_THRESHOLD: 999,
    writeOSAudit: () => {},
  });
  handle = await listen(router);
  app = handle.server;
});

afterEach(() => {
  try { app.close(); } catch {}
  try { matrixServer.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.AEON_KERNEL_URL;
});

const conversation = [
  { type: 'msg', role: 'user', content: 'how do the vault keyslots recover if I lose the env file' },
  { type: 'msg', role: 'assistant', content: 'There is a recovery slot; here is how it works.' },
];

describe('a saved conversation updates in place', () => {
  it('POST with an existing id updates rather than forking', async () => {
    const first = await api('POST', '/terminal/sessions', { messages: conversation });
    expect(first.body.id).toBeTruthy();

    const second = await api('POST', '/terminal/sessions', {
      id: first.body.id,
      messages: [...conversation, { type: 'msg', role: 'user', content: 'and on a USB install?' }],
    });
    expect(second.body.updated).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const list = await api('GET', '/terminal/sessions');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].messageCount).toBe(3);
  });

  it('refuses to update a session that does not exist, rather than creating one', async () => {
    const r = await api('POST', '/terminal/sessions', { id: 'not-a-real-session', messages: conversation });
    expect(r.status).toBe(404);
  });

  it('keeps the original savedAt and moves updatedAt', async () => {
    const first = await api('POST', '/terminal/sessions', { messages: conversation });
    const before = (await api('GET', `/terminal/sessions/${first.body.id}`)).body;
    await new Promise(r => setTimeout(r, 5));
    await api('POST', '/terminal/sessions', { id: first.body.id, messages: conversation });
    const after = (await api('GET', `/terminal/sessions/${first.body.id}`)).body;
    expect(after.savedAt).toBe(before.savedAt);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before.updatedAt).getTime());
  });
});

describe('R10 — a name the operator set is never overwritten', () => {
  it('gives a new chat a deterministic title from the first thing said', async () => {
    // Tier 1: free, offline, available before any model is asked.
    const r = await api('POST', '/terminal/sessions', { messages: conversation });
    expect(r.body.name).toMatch(/vault keyslots/i);
    expect(r.body.nameSetBy).toBe('auto');
  });

  it('lets the model refine an auto title', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    const named = await api('POST', `/terminal/sessions/${s.body.id}/name`);
    expect(named.body.name).toBe('Vault Keyslot Recovery');
    expect(named.body.nameSetBy).toBe('model');
    expect(kernelLLM).toHaveBeenCalledOnce();
  });

  it('REFUSES to rename a chat the operator named, and says why', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    await api('PATCH', `/terminal/sessions/${s.body.id}`, { name: 'Keyslot bridge — decided' });

    const named = await api('POST', `/terminal/sessions/${s.body.id}/name`);
    expect(named.status).toBe(409);
    expect(named.body.code).toBe('operator_named');
    // And it spent nothing finding that out.
    expect(kernelLLM).not.toHaveBeenCalled();

    const after = (await api('GET', `/terminal/sessions/${s.body.id}`)).body;
    expect(after.name).toBe('Keyslot bridge — decided');
  });

  it('a later save does not quietly replace an operator name', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    await api('PATCH', `/terminal/sessions/${s.body.id}`, { name: 'Mine' });
    await api('POST', '/terminal/sessions', { id: s.body.id, name: 'Something else', messages: conversation });
    const after = (await api('GET', `/terminal/sessions/${s.body.id}`)).body;
    expect(after.name).toBe('Mine');
    expect(after.nameSetBy).toBe('operator');
  });

  it('leaves the existing title alone when the model answers with a sentence', async () => {
    kernelLLM.mockResolvedValueOnce('I am sorry, but I cannot title this conversation for you today.');
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    const named = await api('POST', `/terminal/sessions/${s.body.id}/name`);
    expect(named.body.unchanged).toBe(true);
    expect(named.body.name).toBe(s.body.name);
  });

  it('naming never fails the operator when no model is available', async () => {
    const router = createChatRouter({ isVercel: false, VAULT_ROOT: tmp, kernelLLM: null });
    const h = await listen(router);
    try {
      const s = await fetch(`http://127.0.0.1:${h.port}/api/terminal/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversation }),
      }).then(r => r.json());
      const r = await fetch(`http://127.0.0.1:${h.port}/api/terminal/sessions/${s.id}/name`, { method: 'POST' });
      const body = await r.json();
      expect(r.status).toBe(503);
      expect(body.code).toBe('no_model');
      // §08 — an error names its remedy, cheapest first.
      expect(body.remedy).toMatch(/rename the chat yourself/i);
    } finally { h.server.close(); }
  });
});

describe('R09 — remembering a conversation is a decision, and stores the operator only', () => {
  it('sends the operator’s turns to the record and none of the model’s', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    const r = await api('POST', `/terminal/sessions/${s.body.id}/remember`);
    expect(r.status).toBe(200);
    expect(ingestCalls).toHaveLength(1);
    const roles = ingestCalls[0].messages.map(m => m.role);
    expect(roles).toEqual(['user']);
    expect(JSON.stringify(ingestCalls[0])).not.toMatch(/here is how it works/i);
  });

  it('marks the session as in the record, so the UI can say so', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    await api('POST', `/terminal/sessions/${s.body.id}/remember`);
    const list = await api('GET', '/terminal/sessions');
    expect(list.body[0].inRecord).toBe(true);
  });

  it('nothing is remembered until the operator asks', async () => {
    await api('POST', '/terminal/sessions', { messages: conversation });
    expect(ingestCalls).toHaveLength(0);
  });

  it('refuses a conversation with nothing of the operator’s in it', async () => {
    const s = await api('POST', '/terminal/sessions', {
      messages: [{ type: 'msg', role: 'assistant', content: 'unprompted' }],
    });
    const r = await api('POST', `/terminal/sessions/${s.body.id}/remember`);
    expect(r.status).toBe(400);
  });
});

describe('a session id is validated before it becomes a path', () => {
  const NASTY = ['../../../etc/passwd', 'a/../../b', 'x'.repeat(200)];

  it('rejects traversal shapes on delete rather than unlinking', async () => {
    for (const id of NASTY) {
      const r = await api('DELETE', `/terminal/sessions/${encodeURIComponent(id)}`);
      expect(r.status, `delete accepted ${id}`).not.toBe(200);
    }
  });

  it('rejects traversal shapes on read', async () => {
    for (const id of NASTY) {
      const r = await api('GET', `/terminal/sessions/${encodeURIComponent(id)}`);
      expect([400, 404]).toContain(r.status);
    }
  });
});

describe('rename', () => {
  it('requires a name and says what to send', async () => {
    const s = await api('POST', '/terminal/sessions', { messages: conversation });
    const r = await api('PATCH', `/terminal/sessions/${s.body.id}`, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/\{ name \}/);
  });

  it('404s on a session that is not there', async () => {
    const r = await api('PATCH', '/terminal/sessions/nope', { name: 'x' });
    expect(r.status).toBe(404);
  });
});
