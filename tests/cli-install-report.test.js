/**
 * What `aeon install` and `aeon update` tell the operator.
 *
 * The server rebuilds the interface itself when a block goes live and sends
 * back `uiRebuilt`. The CLI must say three different things for it (rebuilt /
 * not rebuilt / ran and FAILED — never "did not run" for a build that ran),
 * say the block landed stopped and how to start it, show a compact summary of
 * an install instead of ~250 lines of JSON (with the next step LAST), leave
 * --json output alone, and wait long enough for a build.
 *
 * The pure wording is checked directly; the CLI itself is run against a
 * stand-in server for the human and --json shapes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'aeon-cli.cjs');
const { uiRebuildReport, startHint, installFacts } = require('../tools/terminal/install-report.cjs');
const renderers = require('../tools/terminal/renderers.cjs');
const plain = (s) => renderers.strip(s);

describe('uiRebuildReport — three outcomes', () => {
  it('rebuilt: says how long and to reload the tab', () => {
    expect(uiRebuildReport({ ok: true, ms: 7500 }, 'calendar')).toEqual({
      kind: 'rebuilt', text: 'interface rebuilt in 8s — reload the tab to see calendar',
    });
  });

  it('skipped: says it was NOT rebuilt, why, and the manual step', () => {
    const r = uiRebuildReport({ ok: false, skipped: true, reason: 'this install cannot rebuild the interface (no build tooling)' }, 'calendar');
    expect(r.kind).toBe('skipped');
    expect(r.text).toBe('the interface was not rebuilt (this install cannot rebuild the interface (no build tooling)) — run npm run build by hand, then reload the tab');
  });

  it('failed: says the build FAILED with the reason, that the block is installed, and never "did not run"', () => {
    const r = uiRebuildReport({ ok: false, code: 1, signal: null, error: "Error: Cannot find module './widget'" }, 'calendar');
    expect(r.kind).toBe('failed');
    expect(r.text).toBe("the interface build FAILED (Error: Cannot find module './widget') — calendar is installed; fix the error above or run npm run build by hand, then reload the tab");
    expect(r.text).not.toMatch(/did not run/);
  });

  it('a timed-out or signal-killed build is a failure, not a skip', () => {
    expect(uiRebuildReport({ ok: false, timedOut: true, error: 'the interface build timed out after 600 s' }, 'x').kind).toBe('failed');
    expect(uiRebuildReport({ ok: false, signal: 'SIGKILL', error: 'killed by SIGKILL' }, 'x').kind).toBe('failed');
  });

  it('no answer at all (an older server) is "not rebuilt", with the manual step', () => {
    const r = uiRebuildReport(undefined, 'calendar');
    expect(r.kind).toBe('skipped');
    expect(r.text).toMatch(/not rebuilt/);
    expect(r.text).toMatch(/npm run build/);
  });

  it('a block lands stopped and the hint says how to start it', () => {
    expect(startHint('calendar')).toBe('calendar landed stopped — start it with: aeon block start calendar');
  });
});

describe('the install summary', () => {
  // The shape of a real result: verdict with every reason, the boot probes, the approval, the purchase.
  const queued = {
    ok: true, text: 'queued', data: {
      ok: true, stage: 'queued', blockId: 'calendar', sha: 'abc123', from: 'store:calendar-0.3.0.aeon',
      purchase: { id: 'calendar', label: 'Calendar', version: '0.3.0', warnings: ['Needs your API keys'] },
      verdict: {
        score: 'MEDIUM', behavior: 'single-click',
        reasons: Array.from({ length: 8 }, (_, i) => ({ sev: 'MEDIUM', rule: `r${i}`, why: `reason number ${i}` })),
        findings: Array.from({ length: 40 }, (_, i) => ({ check: 'x', file: `f${i}`, why: 'y' })),
      },
      boot: { ok: true, probes: Array.from({ length: 120 }, (_, i) => ({ route: `/api/calendar/${i}`, status: 200 })) },
      approval: { id: 'APR-1761-abcde', blockId: 'calendar', score: 'MEDIUM', status: 'pending' },
    },
  };

  it('facts: block, stage, risk, at most five reasons, the approval id when queued', () => {
    const f = installFacts(queued.data);
    expect(f).toMatchObject({ head: 'Calendar v0.3.0 (calendar)', stage: 'queued', score: 'MEDIUM', moreReasons: 3, approvalId: 'APR-1761-abcde' });
    expect(f.reasons).toHaveLength(5);
    expect(f.reasons[0]).toBe('[MEDIUM] reason number 0');
  });

  it('renders as a handful of lines, not the whole result', () => {
    const out = plain(renderers.auto(queued, { renderer: 'install' }));
    const lines = out.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(out).toMatch(/Calendar v0\.3\.0 \(calendar\)/);
    expect(out).toMatch(/queued/);
    expect(out).toMatch(/risk MEDIUM/);
    expect(out).toMatch(/reason number 4/);
    expect(out).not.toMatch(/reason number 5/);
    expect(out).toMatch(/and 3 more/);
    expect(out).toMatch(/approval\s+APR-1761-abcde/);
    expect(out).not.toMatch(/probes|"route"/);
  });

  it('a pipeline result is summarised even when no renderer is named (aeon run /install, the shell)', () => {
    expect(plain(renderers.auto(queued)).split('\n').length).toBeLessThanOrEqual(10);
  });

  it('--json is the raw result, untouched', () => {
    expect(renderers.auto(queued, { renderer: 'install', json: true })).toBe(JSON.stringify(queued, null, 2));
  });

  it('a live install shows no approval line', () => {
    const live = { ok: true, data: { ok: true, stage: 'live', blockId: 'clients', verdict: { score: 'LOW', reasons: [] }, approval: undefined } };
    const out = plain(renderers.auto(live, { renderer: 'install' }));
    expect(out).toMatch(/\(clients\)/);
    expect(out).toMatch(/live/);
    expect(out).toMatch(/risk LOW/);
    expect(out).not.toMatch(/approval/);
  });
});

describe('the CLI against a stand-in server', () => {
  let server, url, tmp, answer;
  const liveResult = (uiRebuilt) => ({
    ok: true, id: 'master.install', text: 'installed',
    data: { ok: true, stage: 'live', blockId: 'clients', verdict: { score: 'LOW', reasons: [] }, boot: { ok: true, probes: [{ route: '/api/clients/x' }] }, uiRebuilt },
  });
  const queuedResult = () => ({
    ok: true, id: 'master.install', text: 'queued',
    data: {
      ok: true, stage: 'queued', blockId: 'calendar', purchase: { id: 'calendar', label: 'Calendar', version: '0.3.0' },
      verdict: { score: 'MEDIUM', reasons: [{ sev: 'MEDIUM', why: 'writes outside its own scope' }] },
      approval: { id: 'APR-7', blockId: 'calendar', score: 'MEDIUM' },
    },
  });

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cli-install-'));
    const app = express();
    app.use(express.json());
    app.get('/api/ping', (_q, r) => r.json({ ok: true }));
    app.post('/api/commands/dispatch', (_q, r) => r.json(answer.dispatch));
    app.post('/api/store/update', (_q, r) => r.json(answer.update));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  // Async on purpose: the stand-in server lives in THIS process.
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, AEON_URL: url, AEON_HOME: tmp, DATA_PATH: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout: plain(stdout), stderr: plain(stderr) }); });
  });
  const lastLine = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);

  it('install, live and rebuilt: a compact summary, the rebuild line, then how to start it', async () => {
    answer = { dispatch: liveResult({ ok: true, ms: 7400 }) };
    const r = await run('install', 'clients');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\(clients\) · live · risk LOW/);
    expect(r.stdout).not.toMatch(/probes|"route"/);
    expect(r.stdout.indexOf('interface rebuilt in 7s')).toBeGreaterThan(r.stdout.indexOf('(clients)'));
    expect(lastLine(r.stdout)).toBe('clients landed stopped — start it with: aeon block start clients');
  });

  it('install, live but the build FAILED: says FAILED with the reason, never "did not run"', async () => {
    answer = { dispatch: liveResult({ ok: false, code: 1, signal: null, error: 'Error: Unexpected token' }) };
    const r = await run('install', 'clients');
    expect(r.stdout).toMatch(/the interface build FAILED \(Error: Unexpected token\) — clients is installed/);
    expect(r.stdout).not.toMatch(/did not run/);
    expect(lastLine(r.stdout)).toMatch(/aeon block start clients/);
  });

  it('install, live but skipped: says it was not rebuilt and why', async () => {
    answer = { dispatch: liveResult({ ok: false, skipped: true, reason: 'this install cannot rebuild the interface (no build tooling)' }) };
    const r = await run('install', 'clients');
    expect(r.stdout).toMatch(/the interface was not rebuilt \(this install cannot rebuild the interface \(no build tooling\)\)/);
  });

  it('install, queued: the summary names the approval, and the hint is the LAST line', async () => {
    answer = { dispatch: queuedResult() };
    const r = await run('install', 'calendar');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Calendar v0\.3\.0 \(calendar\) · queued · risk MEDIUM/);
    expect(r.stdout).toMatch(/writes outside its own scope/);
    expect(r.stdout).toMatch(/approval\s+APR-7/);
    expect(lastLine(r.stdout)).toMatch(/^calendar needs review — approve it in Settings → Agent/);
    expect(lastLine(r.stdout)).toMatch(/aeon block start calendar/);
  });

  it('install --json prints the raw result, none of the human summary', async () => {
    answer = { dispatch: liveResult({ ok: true, ms: 1000 }) };
    const r = await run('install', 'clients', '--json');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))).toEqual(answer.dispatch);
    expect(r.stdout).not.toMatch(/landed stopped|interface rebuilt|risk LOW/);
  });

  it('update: reports the rebuild outcome and, when the pack is stopped, how to start it', async () => {
    answer = { update: { ok: true, updated: true, id: 'calendar', message: 'calendar updated 0.2.0 → 0.3.0', running: false, uiRebuilt: { ok: false, error: 'killed by SIGKILL' } } };
    const r = await run('update', 'calendar');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/the interface build FAILED \(killed by SIGKILL\) — calendar is installed/);
    expect(lastLine(r.stdout)).toBe('calendar landed stopped — start it with: aeon block start calendar');
  });

  it('update of a running pack does not tell the operator to start it', async () => {
    answer = { update: { ok: true, updated: true, id: 'calendar', message: 'calendar updated', running: true, uiRebuilt: { ok: true, ms: 3000 } } };
    const r = await run('update', 'calendar');
    expect(r.stdout).toMatch(/interface rebuilt in 3s/);
    expect(r.stdout).not.toMatch(/aeon block start/);
  });

  it('the store footer is true now: approve queued packs in Settings, start the block, the interface rebuilds itself', async () => {
    const cli = fs.readFileSync(CLI, 'utf8');
    expect(cli).not.toMatch(/then: aeon block start <id>, npm run build, reload/);
    expect(cli).toMatch(/if it waits for review, approve it in Settings → Agent/);
    expect(cli).toMatch(/the interface rebuilds by itself after an install or update/);
  });

  it('install and update wait 10 minutes for the build; other commands keep their timeouts', () => {
    const cli = fs.readFileSync(CLI, 'utf8');
    expect(cli).toMatch(/const BUILD_WAIT_MS = 600000;/);
    expect(cli).toMatch(/renderer: 'install', timeout: BUILD_WAIT_MS/);
    expect(cli).toMatch(/'\/api\/store\/update', \{ name: arg \}, \{ timeout: BUILD_WAIT_MS \}/);
    expect(cli).toMatch(/timeout = 180000 \} = \{\}\) \{/);          // dispatchAndRender's default is unchanged
    const client = fs.readFileSync(path.join(ROOT, 'tools', 'terminal', 'client.cjs'), 'utf8');
    expect(client).toMatch(/async function request\(method, route, body, \{ timeout = 120000, raw = false \} = \{\}\)/);
  });
});
