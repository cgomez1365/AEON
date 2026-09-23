/**
 * A failure is reported once, where it happened, in words that name it.
 *
 * Found by the block agents on 2026-09-23:
 *   - `/memory remember …` answered its own 4xx in the chip AND raised the red
 *     "[API FAILED] /api/commands/dispatch …" banner. The self-reported header
 *     suppressed the banner only for 401/403; a 4xx is a state the caller
 *     explains (not found, missing input, missing block). A 5xx is a defect
 *     and still banners.
 *   - With Aeon Matrix removed, every page raised "[API FAILED]
 *     /api/sync/quick_links" — the Quick Links page already explains it.
 *   - The CLI judged a command by HTTP status alone, so a block's own
 *     `ok:false` ("no document matches…") printed as success.
 *   - With the Dashboard block removed, "/" rendered an empty viewport and the
 *     terminal's chat failed as "chat/stream 404".
 *   - Saving a reclassified block ignored the response: a failed save showed
 *     as saved until reload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { shouldBannerResponse, SELF_REPORTED_HEADER } from '../src/utils/interceptorPolicy.js';
import { loadLinks, saveLinks } from '../src/kernel/contexts/linksStore.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the banner is for defects, not for states a caller explains', () => {
  const url = '/api/commands/dispatch';
  it('a self-reporting caller\'s 4xx does not banner', () => {
    for (const status of [400, 404, 409, 422]) {
      expect(shouldBannerResponse({ url, ok: false, status, selfReported: true })).toBe(false);
    }
  });
  it('its 5xx still does, and an ordinary caller\'s 4xx still does', () => {
    expect(shouldBannerResponse({ url, ok: false, status: 500, selfReported: true })).toBe(true);
    expect(shouldBannerResponse({ url, ok: false, status: 404, selfReported: false })).toBe(true);
  });
});

describe('callers that show their own failure say so', () => {
  it('the terminal marks its dispatch and chat requests self-reported', () => {
    const src = read('src', 'components', 'Terminal2.jsx');
    const dispatch = src.slice(src.indexOf("fetch('/api/commands/dispatch'"), src.indexOf("fetch('/api/commands/dispatch'") + 300);
    const chat = src.slice(src.indexOf("fetch('/api/chat/stream'"), src.indexOf("fetch('/api/chat/stream'") + 300);
    expect(dispatch).toMatch(/SELF_REPORTED_HEADER|x-aeon-self-reported/);
    expect(chat).toMatch(/SELF_REPORTED_HEADER|x-aeon-self-reported/);
  });

  it('the terminal names the Dashboard block when chat is not served', () => {
    expect(read('src', 'components', 'Terminal2.jsx')).toMatch(/Dashboard block/);
  });

  it('the links store marks both its reads and its writes', async () => {
    const seen = [];
    const fetcher = async (url, init = {}) => {
      seen.push(init.headers?.[SELF_REPORTED_HEADER]);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const storage = { getItem: () => null, setItem: () => {} };
    await loadLinks({ fetcher, storage });
    await saveLinks([{ id: 'a', name: 'A', url: 'https://a.example/' }], { fetcher, storage });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((h) => h === '1')).toBe(true);
  });
});

describe('the layout never shows an unsaved state as saved, and "/" always lands somewhere', () => {
  const src = read('src', 'components', 'DesktopLayout.jsx');
  it('a failed layout save reverts', () => {
    const save = src.slice(src.indexOf('const saveBlockLayout'), src.indexOf('const saveBlockLayout') + 700);
    expect(save).toMatch(/r\.ok|res\.ok/);
    expect(save).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
  it('with no block on "/", the catch-all goes to the first installed block', () => {
    expect(src).toMatch(/HOME_ROUTE/);
    expect(src).toMatch(/<Navigate to=\{HOME_ROUTE\}/);
  });
});

describe('the CLI reads a block\'s own verdict, not just the HTTP status', () => {
  let server, url;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/ping', (_q, r) => r.json({ ok: true }));
    app.post('/api/commands/dispatch', (_q, r) => r.json({
      ok: true, text: 'No document matches "nothing-here.md".',
      data: { ok: false, error: 'No document matches "nothing-here.md" (searched paths, names and titles).' },
    }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  it('`aeon run /doc nothing-here.md` exits 1 and prints the reason', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cli-verdict-'));
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'run', '/doc', 'nothing-here.md'], {
        env: { ...process.env, AEON_URL: url, AEON_HOME: tmp, DATA_PATH: '' },
      });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      const t = setTimeout(() => c.kill('SIGKILL'), 20000);
      c.on('close', (status) => { clearTimeout(t); resolve({ status, out }); });
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/No document matches/);
  });
});
