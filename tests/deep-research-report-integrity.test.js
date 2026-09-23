/**
 * Deep Research — a report is only "done" when it is whole, the block is
 * ready when its role can serve, and a search failure names both causes.
 *
 * Measured 2026-09-23 (agent C2, throwaway install, stub model, web blocked):
 *
 *   - The write call asks for 8192 tokens; a free OpenRouter model stops at
 *     1024. The report comes back cut off mid-Findings and was filed as
 *     status "done" — the Library showed a finished report with no Discussion,
 *     Limitations or Conclusion, and no word about why.
 *   - The manifest required groq + gemini + supabase, so /api/blocks/registry
 *     reported deep_research ready:false (missingApis groq, gemini, supabase)
 *     on an install whose research role was served — the loop only ever calls
 *     kernelLLM({ role: 'research' }).
 *   - With the network down, every search came back empty and the message
 *     blamed DuckDuckGo's rate limit only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let scratch, server, base;

const RESULT = (n, q) => `- **Result ${n} for ${q}**\n  A paragraph of body text long enough to look like a real search snippet about ${q}.\n  Source: [ref](https://example.com/${n})`;
const WHOLE = '# Solar payback\n\n## Abstract\nPays back in 6-10 years [1].\n\n## Findings\nThe credit is 30% [2].\n\n## Discussion\nRates vary.\n\n## Limitations\nState data only.\n\n## Conclusion\nMost homes pay back within a decade [1].';
const CUT = '# Solar payback\n\n## Abstract\nPays back in 6-10 years [1].\n\n## Findings\nThe credit is 30% [2]. Panels degrade at about 0.5% per year, which over twenty-five years';

async function mount({ report, search = (q, n) => RESULT(n, q) }) {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-research-integrity-'));
  let n = 0;
  const s = async (q) => search(q, ++n);
  const factory = require_(path.join(ROOT, 'src', 'blocks', 'deep_research', 'api', 'index.cjs'));
  const router = factory({
    getDataFile: () => { fs.mkdirSync(scratch, { recursive: true }); return scratch; },
    kernelLLM: async (prompt) => {
      if (prompt.includes('Reconstruct the user')) return (prompt.match(/Raw input: "([^"]*)"/) || [])[1] || '';
      if (prompt.includes('JSON array of strings')) return '["a","b"]';
      if (/college-level report|well-structured research report/.test(prompt)) return report;
      if (/quantifiable data worth charting/.test(prompt)) return '[]';
      return 'finding';
    },
    fetchDuckDuckGo: s, fetchWebSearch: s, writeOSAudit: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}/api`;
}

async function run(body) {
  const r = await fetch(`${base}/research/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { session_id } = await r.json();
  const file = path.join(scratch, `${session_id}.json`);
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.status && d.status !== 'running') return { id: session_id, ...d };
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('run did not settle');
}

afterEach(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  server = null;
});

describe('a cut-off report is not a finished one', () => {
  it('a report that stops before its Conclusion is filed partial, with the reason', async () => {
    await mount({ report: CUT });
    const d = await run({ query: 'solar payback', max_rounds: 2, max_time: 60 });
    expect(d.status).toBe('partial');
    expect(d.degraded).toMatch(/output limit/);
    // Everything the model wrote is kept.
    expect(d.result).toContain('Panels degrade at about 0.5% per year');
  }, 20000);

  it('a whole report is done, and reopens from the library and as HTML', async () => {
    await mount({ report: WHOLE });
    const d = await run({ query: 'solar payback', max_rounds: 2, max_time: 60 });
    expect(d.status).toBe('done');
    expect(d.degraded).toBeUndefined();
    const lib = await (await fetch(`${base}/research/library`)).json();
    expect(lib.research.map((x) => x.id)).toContain(d.id);
    const detail = await (await fetch(`${base}/research/detail/${d.id}`)).json();
    expect(detail.result).toMatch(/## Conclusion/);
    expect(detail.result).toMatch(/## References/);
    const html = await fetch(`${base}/research/report/${d.id}`);
    expect(html.status).toBe(200);
    expect(await html.text()).toMatch(/Solar payback/);
  }, 20000);
});

describe('a failed search names both causes', () => {
  it('says the machine may be offline, not only that DuckDuckGo refused', async () => {
    await mount({ report: WHOLE, search: () => '' });
    const d = await run({ query: 'anything', max_rounds: 2, max_time: 60 });
    expect(d.status).toBe('error');
    expect(d.error).toMatch(/offline|no internet|network/i);
    expect(d.error).toMatch(/Brave, Serper, or Tavily/);
  }, 20000);
});

describe('the manifest is true to the code', () => {
  const manifest = require_(path.join(ROOT, 'src', 'blocks', 'deep_research', 'block.manifest.json'));

  it('requires no provider it does not call, and declares the role it does', () => {
    expect(manifest.requires.apis).toEqual([]);
    expect(manifest.requires.env).toEqual([]);
    expect(manifest.contract.ai.roles).toContain('research');
    const api = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'deep_research', 'api', 'index.cjs'), 'utf8');
    expect(api).toMatch(/role: 'research'/);
  });

  it('is ready on an install with no groq, gemini or supabase keys', () => {
    const std = require_(path.join(ROOT, 'src', 'kernel', 'blockStandard.cjs'));
    const r = std.checkReadiness(std.normalizeManifest('deep_research'), {});
    expect(r.missingApis).toEqual([]);
    expect(r.ready).toBe(true);
  });
});
