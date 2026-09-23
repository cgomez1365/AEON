/**
 * Class 4 (knowledge gap) answers from live sources when it has them.
 *
 * The retrieval router handed the citation gate `fetchDuckDuckGo`, which
 * returns markdown text; the router kept only `Array.isArray(hits)` results,
 * so every Class 4 question got "I could not reach a live source" — online or
 * not. Found by agent C2 on 2026-09-23 by reading the code after a Writer
 * draft about "this week" wrote a no-source receipt.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-class4-'));
process.env.AEON_DB_DIR = DB;

const LITE_PAGE = `
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fai-act" class='result-link'>AI Act <b>enters</b> force</a>
<td class='result-snippet'>The regulation <b>applies</b> from this week.</td>
<a rel="nofollow" href="//example.net/brief" class='result-link'>Weekly brief</a>
<td class='result-snippet'>Three rules changed.</td>`;

const search = require('../services/search.js')({ writeOSAudit() {}, kernelLLM: async () => '' });

describe('one parse, two shapes', () => {
  it('the Lite page parses to hits with real URLs', () => {
    expect(search.parseDuckDuckGoLite(LITE_PAGE)).toEqual([
      { title: 'AI Act enters force', url: 'https://example.org/ai-act', snippet: 'The regulation applies from this week.' },
      { title: 'Weekly brief', url: 'https://example.net/brief', snippet: 'Three rules changed.' },
    ]);
    expect(search.parseDuckDuckGoLite('<html>no results</html>')).toBeNull();
  });

  it('the chat still gets the same markdown, and the gate gets the hits', async () => {
    const https = require('https');
    const spy = vi.spyOn(https, 'request').mockImplementation((_url, _opts, onRes) => {
      const req = new EventEmitter();
      req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        onRes(res);
        res.emit('data', LITE_PAGE);
        res.emit('end');
      };
      return req;
    });
    try {
      expect(await search.fetchDuckDuckGo('q', 'c')).toBe(
        '- **AI Act enters force**\n  The regulation applies from this week.\n  Source: [https://example.org/ai-act](https://example.org/ai-act)'
        + '\n\n- **Weekly brief**\n  Three rules changed.\n  Source: [https://example.net/brief](https://example.net/brief)'
      );
      expect(await search.fetchDuckDuckGoHits('q', 'c')).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });
});

describe('the gate answers a Class 4 question from the hits', () => {
  let server, url;
  beforeAll(async () => {
    const createRouter = require('../src/kernel/routers/retrieval.cjs');
    const app = express();
    app.use(express.json());
    app.use('/api/retrieval', createRouter({
      kernelLLM: async () => 'The AI Act applies from this week [web:1].',
      fetchSearchHits: async () => search.parseDuckDuckGoLite(LITE_PAGE),
    }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { server?.close(); fs.rmSync(DB, { recursive: true, force: true }); });

  it('cites its sources instead of refusing', async () => {
    const r = await fetch(`${url}/api/retrieval/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'what is the latest news on AI regulation this week' }),
    }).then((x) => x.json());
    expect(r.class).toBe(4);
    expect(r.retrieved).toBe(true);
    expect(r.citations.map((c) => c.url)).toEqual(['https://example.org/ai-act', 'https://example.net/brief']);
    expect(r.answer).not.toMatch(/could not reach a live source/);
  });

  it('the server wires the hits, not the markdown, into the gate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
    expect(src).toMatch(/routers\/retrieval\.cjs'\)\(\{[^}]*fetchSearchHits: search\.fetchDuckDuckGoHits/);
  });
});
