/**
 * An embedding longer than 512 tokens must not 500.
 *
 * Found 2026-10-05: a chat message of ~830 tokens that tripped the recall gate
 * came back as "vault: embed failed" — llama-server /v1/embeddings returned
 * 500, "input (827 tokens) is too large to process. increase the physical
 * batch size (current batch size: 512)". Measured on the shipped binary
 * (b10216) and nomic-embed-text-q8 with the args this file's subject builds:
 *
 *   --batch-size 2048                 400 tokens 200, 636 tokens 500, 1096 tokens 500
 *   --batch-size 2048 --ubatch-size 2048   up to 2048 tokens 200, 2049+ 500
 *
 * An embedding input has to fit ONE physical batch (-ub, default 512), and
 * with --embeddings llama-server lowers --batch-size back to it ("setting
 * n_batch = n_ubatch = 512"), so --batch-size alone never helped.
 *
 * The stand-in is a real process that follows those measured rules: it clamps
 * n_batch to n_ubatch, refuses an input over n_ubatch with llama-server's own
 * error, and tokenises on whitespace. A mocked fetch would paper over exactly
 * what failed: the arguments the child is started with.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ServerSession } = require(path.join(ROOT, 'services', 'local-runtime', 'server-session.cjs'));

let tmp;
let session;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-batch-')); });
afterEach(() => {
  if (session) session.stop();
  session = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubSession(opts = {}) {
  const rt = path.join(tmp, 'runtime');
  fs.mkdirSync(rt);
  const stub = path.join(tmp, 'stub.cjs');
  const argvFile = path.join(tmp, 'argv.json');
  const hitsFile = path.join(tmp, 'hits.txt');
  fs.writeFileSync(stub, `
    const fs = require('fs');
    const argv = process.argv.slice(2);
    const arg = (n, d) => (argv.includes(n) ? Number(argv[argv.indexOf(n) + 1]) : d);
    fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
    const ub = arg('--ubatch-size', 512);
    const vocab = [];
    const words = (s) => String(s).split(/\\s+/).filter(Boolean);
    const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    require('http').createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        fs.appendFileSync(${JSON.stringify(hitsFile)}, req.url + '\\n');
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/health') return send(res, 200, { status: 'ok' });
        if (req.url === '/tokenize') {
          return send(res, 200, { tokens: words(body.content).map((w) => { let i = vocab.indexOf(w); if (i < 0) i = vocab.push(w) - 1; return i; }) });
        }
        if (req.url === '/detokenize') return send(res, 200, { content: body.tokens.map((i) => vocab[i]).join(' ') });
        if (req.url === '/v1/embeddings') {
          if (/unloaded/.test(body.input)) return send(res, 503, { error: { message: 'model not loaded' } });
          const n = words(body.input).length + 2;   // BOS + EOS, as llama-server adds
          if (n > ub) {
            return send(res, 500, { error: { code: 500, type: 'server_error',
              message: 'input (' + n + ' tokens) is too large to process. increase the physical batch size (current batch size: ' + ub + ')' } });
          }
          return send(res, 200, { data: [{ embedding: [n, 0.5] }], usage: { prompt_tokens: n } });
        }
        send(res, 404, {});
      });
    }).listen(arg('--port', 0), '127.0.0.1');
  `);
  const bin = path.join(rt, 'llama-server');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const model = path.join(tmp, 'model.gguf');
  fs.writeFileSync(model, 'gguf');
  session = new ServerSession({
    entryAbsPath: path.join(rt, 'entry'), modelAbsPath: model, contextSize: 2048, embeddings: true, ...opts,
  });
  return {
    argv: () => JSON.parse(fs.readFileSync(argvFile, 'utf8')),
    hits: () => fs.readFileSync(hitsFile, 'utf8').split('\n').filter((l) => l && l !== '/health'),
  };
}

const prose = (n) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');

it.skipIf(process.platform === 'win32')('embedding mode sets the physical batch to the window, not only the logical one', async () => {
  const stub = stubSession();
  await session.start();
  const a = stub.argv();
  const val = (flag) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  expect(val('--batch-size')).toBe('2048');
  expect(val('--ubatch-size')).toBe('2048');
}, 40000);

it.skipIf(process.platform === 'win32')('an 830-token input embeds', async () => {
  stubSession();
  const vec = await session.embed(prose(828));
  expect(vec[0]).toBe(830);
}, 40000);

it.skipIf(process.platform === 'win32')('an input over the whole window is cut to it, once, instead of refused', async () => {
  const stub = stubSession();
  const vec = await session.embed(prose(3000));
  expect(vec[0]).toBe(2048);   // 2046 tokens + BOS/EOS
  expect(stub.hits()).toEqual(['/v1/embeddings', '/tokenize', '/detokenize', '/v1/embeddings']);
}, 40000);

it.skipIf(process.platform === 'win32')('a cut input is said so in the log, with both sizes', async () => {
  stubSession();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await session.embed(prose(3000));
    const line = warn.mock.calls.map((c) => c.join(' ')).find((l) => /\[EMBED\]/.test(l));
    expect(line).toMatch(/3000 tokens/);
    expect(line).toMatch(/2046/);
    expect(line).toMatch(/not embedded/);
  } finally { warn.mockRestore(); }
}, 40000);

it.skipIf(process.platform === 'win32')('an input that fits is not warned about', async () => {
  stubSession();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await session.embed(prose(300));
    expect(warn.mock.calls.some((c) => /\[EMBED\]/.test(c.join(' ')))).toBe(false);
  } finally { warn.mockRestore(); }
}, 40000);

it.skipIf(process.platform === 'win32')('an input that fits costs exactly one request', async () => {
  const stub = stubSession();
  await session.embed(prose(300));
  expect(stub.hits()).toEqual(['/v1/embeddings']);
}, 40000);

it.skipIf(process.platform === 'win32')('a server that fails for another reason still fails loudly', async () => {
  const stub = stubSession();
  // Not a length problem, so it is reported as it came and not retried as one.
  await expect(session.embed('unloaded')).rejects.toThrow(/returned 503: .*model not loaded/);
  expect(stub.hits()).toEqual(['/v1/embeddings']);
}, 40000);
