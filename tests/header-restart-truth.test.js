/**
 * The header's RESTART says what AEON answered.
 *
 * host_os's restart now refuses with 501, a reason and a remedy when nothing
 * would bring AEON back (launch.command, launch.sh; agent C4, 2026-09-23).
 * Both header buttons ignored the answer and reloaded once /api/health
 * answered — at once, since the server never went down — so a refused restart
 * looked like a finished one. SYSTEM HEALTH had no handler at all.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requestRestart } from '../src/utils/restartRequest.js';
import { shouldBannerResponse, SELF_REPORTED_HEADER } from '../src/utils/interceptorPolicy.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const reply = (status, body) => async (_url, init) => {
  reply.last = init;
  return { ok: status < 400, status, json: async () => body };
};

describe('requestRestart', () => {
  it('a refusal comes back as the server\'s reason and remedy, not a restart', async () => {
    const r = await requestRestart(reply(501, {
      ok: false, restarting: false,
      error: 'AEON cannot restart itself in this launch mode — nothing would bring it back up.',
      remedy: 'Stop AEON and start it again with your launcher.',
    }));
    expect(r.restarting).toBe(false);
    expect(r.message).toMatch(/cannot restart itself/);
    expect(r.message).toMatch(/start it again with your launcher/);
    expect(reply.last.headers[SELF_REPORTED_HEADER]).toBe('1');
  });

  it('an accepted restart, or a server that dies before answering, is a restart', async () => {
    expect((await requestRestart(reply(200, { ok: true, restarting: true }))).restarting).toBe(true);
    expect((await requestRestart(async () => { throw new TypeError('Failed to fetch'); })).restarting).toBe(true);
  });

  it('with Host OS removed, it names the block', async () => {
    const r = await requestRestart(reply(404, {}));
    expect(r.restarting).toBe(false);
    expect(r.message).toMatch(/Host OS block/);
  });

  it('the 501 it explains does not also raise the red banner', () => {
    expect(shouldBannerResponse({ url: '/api/system/restart', ok: false, status: 501, selfReported: true })).toBe(false);
    expect(shouldBannerResponse({ url: '/api/system/restart', ok: false, status: 500, selfReported: true })).toBe(true);
  });
});

describe('the header uses it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'components', 'DesktopLayout.jsx'), 'utf8');
  it('neither RESTART button fires the request and ignores the answer', () => {
    expect(src).not.toMatch(/fetch\('\/api\/system\/restart'/);
    expect(src.match(/await requestRestart\(\)/g) || []).toHaveLength(2);
  });
  it('SYSTEM HEALTH opens the Host OS screen', () => {
    expect(src).toMatch(/onClick=\{\(\) => navigate\('\/host'\)\}[^>]*>\s*<span[^>]*>●<\/span> SYSTEM HEALTH/);
  });
});
