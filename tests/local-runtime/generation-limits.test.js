/**
 * BO-D1b / D1c / D1d — the three limits that made a long answer impossible,
 * and the one that made a truncated answer invisible.
 *
 * THE DEFECTS THIS SUITE EXISTS FOR (2026-08-05):
 *
 *   D1b  A 180-second wall clock on the whole request. Every long generation
 *        died at ~750 tokens — 701, 730, 743 in the operator's own activity
 *        feed — while the model was still generating correctly.
 *   D1c  /chat/stop was a placeholder that returned {ok:true} and cancelled
 *        nothing. The UI said "cancelled" and the CPU kept going.
 *   D1d  finish_reason was read and thrown away, so an answer cut off at the
 *        budget looked exactly like one the model chose to end.
 *
 * These drive ServerSession against a REAL HTTP server standing in for
 * llama-server, because the defects are in request lifecycle and stream
 * handling — precisely the behaviour a mocked fetch would paper over. A fake
 * that returns a canned object cannot demonstrate that an abort reaches the
 * far end, which is the whole claim of D1c.
 *
 * §18: this provisions nothing. The stub server binds an ephemeral loopback
 * port and dies with the test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ServerSession } = require('../../services/local-runtime/server-session.cjs');

const servers = [];
afterEach(() => { while (servers.length) { try { servers.pop().close(); } catch {} } });

/** A stub speaking llama-server's /health and /v1/chat/completions. */
async function stubServer(handler) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => handler(req, res, JSON.parse(body || '{}')));
    }
    res.writeHead(404); res.end();
  });
  servers.push(srv);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return srv.address().port;
}

const sseChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ model: 'stub', choices: [{ delta: delta ? { content: delta } : {}, finish_reason: finish }] })}\n\n`;

/**
 * A session pointed at the stub. `start()` is bypassed — this suite is about
 * request behaviour, not process spawning, which paths.test.js covers.
 */
function sessionAt(port, opts = {}) {
  const s = new ServerSession({ entryAbsPath: 'x', modelAbsPath: 'y', contextSize: 8192, ...opts });
  s.state = 'ready';
  s.port = port;
  return s;
}

describe('D1b — the timeout measures silence, not duration', () => {
  it('a generation running well past 180s completes', async () => {
    // The ceiling that started BO-D. Tokens arrive steadily; total elapsed
    // time is irrelevant so long as the model keeps emitting. Simulated by
    // compressing the clock: a short idle timeout with gaps below it.
    const port = await stubServer(async (req, res, body) => {
      expect(body.stream).toBe(true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 12; i++) {
        res.write(sseChunk(`tok${i} `));
        await new Promise(r => setTimeout(r, 25));   // alive, but slow
      }
      res.write(sseChunk('', 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const s = sessionAt(port, { idleTimeoutMs: 300 });
    const seen = [];
    const r = await s.chat([{ role: 'user', content: 'write at length' }], { onToken: t => seen.push(t) });

    // Total wall time exceeded the idle bound several times over, and the
    // generation was never cancelled — the old code would have aborted.
    expect(seen.length).toBe(12);
    expect(r.complete).toBe(true);
    expect(r.text).toContain('tok11');
  });

  it('a stalled stream is cancelled, and says it stalled', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('starting '));
      // then nothing, forever — a wedged model
    });

    const s = sessionAt(port, { idleTimeoutMs: 150 });
    await expect(
      s.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} })
    ).rejects.toThrow(/stopped producing output/i);
  });

  it('the idle bound is stricter than the old wall clock on a hung model', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('x '));
    });
    const s = sessionAt(port, { idleTimeoutMs: 120 });
    const t0 = Date.now();
    await s.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} }).catch(() => {});
    expect(Date.now() - t0).toBeLessThan(180_000);
  });
});

describe('D1c — stop actually stops', () => {
  it('aborting reaches the upstream request', async () => {
    let upstreamAborted = false;
    const port = await stubServer(async (req, res) => {
      req.on('aborted', () => { upstreamAborted = true; });
      res.on('close', () => { if (!res.writableEnded) upstreamAborted = true; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => { try { res.write(sseChunk('tok ')); } catch { clearInterval(timer); } }, 20);
      res.on('close', () => clearInterval(timer));
    });

    const s = sessionAt(port, { idleTimeoutMs: 5000 });
    const ac = new AbortController();
    let count = 0;
    const p = s.chat([{ role: 'user', content: 'go' }], {
      signal: ac.signal,
      onToken: () => { if (++count === 3) ac.abort(); },
    });

    const r = await p;
    // A deliberate stop is not an error — it returns what was generated.
    expect(r.cancelled).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);

    await new Promise(r2 => setTimeout(r2, 60));
    expect(upstreamAborted).toBe(true);   // the placeholder could never do this
  });

  it('cancelActive() cancels a generation nobody holds a signal for', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => { try { res.write(sseChunk('t ')); } catch { clearInterval(timer); } }, 20);
      res.on('close', () => clearInterval(timer));
    });

    const s = sessionAt(port, { idleTimeoutMs: 5000 });
    let count = 0;
    const p = s.chat([{ role: 'user', content: 'go' }], {
      onToken: () => { if (++count === 2) s.cancelActive(); },
    });
    const r = await p;
    expect(r.cancelled).toBe(true);
  });
});

describe('D1d — truncation is reported, not hidden', () => {
  it('finish_reason "length" surfaces as truncated with a remedy', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('half an answer'));
      res.write(sseChunk('', 'length'));
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const s = sessionAt(port);
    const r = await s.chat([{ role: 'user', content: 'write a file' }], { onToken: () => {} });

    expect(r.truncated).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.finishReason).toBe('length');
    expect(r.truncationReason).toMatch(/Continue/i);
  });

  it('a complete answer is distinguishable from a truncated one', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('a whole answer'));
      res.write(sseChunk('', 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const s = sessionAt(port);
    const r = await s.chat([{ role: 'user', content: 'hi' }], { onToken: () => {} });
    expect(r.truncated).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.truncationReason).toBeUndefined();
  });

  it('the non-streaming path reports it too', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'stub',
        choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }],
        usage: { total_tokens: 42 },
      }));
    });

    const s = sessionAt(port);
    const r = await s.chat([{ role: 'user', content: 'hi' }]);
    expect(r.truncated).toBe(true);
    expect(r.finishReason).toBe('length');
  });
});

describe('D1a — the request carries a derived budget, not 512', () => {
  it('sends a max_tokens computed from the window and the prompt', async () => {
    let sent = null;
    const port = await stubServer((req, res, body) => {
      sent = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });

    const s = sessionAt(port, { contextSize: 32768 });
    await s.chat([{ role: 'user', content: 'hello' }]);

    expect(sent.max_tokens).not.toBe(512);
    expect(sent.max_tokens).toBeGreaterThan(750);   // the observed ceiling
  });

  it('refuses honestly when the prompt has consumed the window', async () => {
    const port = await stubServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const s = sessionAt(port, { contextSize: 2048 });
    await expect(
      s.chat([{ role: 'user', content: 'x'.repeat(40000) }])
    ).rejects.toThrow(/token window/i);
  });
});
