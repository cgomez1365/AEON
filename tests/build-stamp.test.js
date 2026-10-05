// A block installed while AEON runs has a backend at once but no screen until
// the interface is rebuilt. Closing and reopening AEON (or Settings → Restart)
// must do that rebuild — the launcher built only when dist/ was missing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildState, writeStamp, sourceHash, STAMP_FILE } = require('../tools/build-stamp.cjs');
const { ensureInterface } = require('../launch.js');
const tool = require('../tools/ensure-interface.cjs');

let root;
const put = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const built = () => { put('dist/index.html', '<html></html>'); writeStamp(root); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stamp-'));
  put('index.html', '<div id=root></div>'); put('package.json', '{"version":"3.3.3"}');
  put('src/blocks/notes/index.jsx', 'export default 1');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('buildState', () => {
  it('is stale when nothing was built', () => expect(buildState(root)).toEqual({ stale: true, reason: 'missing' }));
  it('is current right after a stamped build', () => { built(); expect(buildState(root)).toEqual({ stale: false, reason: null }); });
  it('treats a dist/ with no stamp as stale once', () => {
    put('dist/index.html', 'x');
    expect(buildState(root)).toEqual({ stale: true, reason: 'unstamped' });
  });
  it('goes stale when a block folder is added', () => {
    built(); put('src/blocks/voice_studio/index.jsx', 'export default 2');
    expect(buildState(root)).toEqual({ stale: true, reason: 'changed' });
  });
  it('goes stale when a block screen is edited', () => {
    built(); put('src/blocks/notes/index.jsx', 'export default 99');
    expect(buildState(root).reason).toBe('changed');
  });
  it('goes stale when a block is removed', () => {
    built(); fs.rmSync(path.join(root, 'src/blocks/notes'), { recursive: true });
    expect(buildState(root).reason).toBe('changed');
  });
  it('ignores OS junk, server code and the stamp itself', () => {
    built();
    put('src/blocks/notes/.DS_Store', 'junk'); put('src/blocks/notes/.aeon.runtime.json', '{"_generated":"a"}'); put('src/blocks/notes/._index.jsx', 'junk');
    expect(buildState(root).stale).toBe(false);
    put('src/blocks/notes/.aeon.runtime.json', '{"_generated":"later"}');
    put('server/server.js', 'changed'); put('data/x.json', '{}');
    expect(buildState(root).stale).toBe(false);
    expect(fs.existsSync(path.join(root, 'dist', STAMP_FILE))).toBe(true);
  });
  it('hashes the same tree the same way twice', () => expect(sourceHash(root)).toBe(sourceHash(root)));
});

describe('ensureInterface (launch and Restart)', () => {
  it('rebuilds a changed tree and says why', () => {
    built(); put('src/blocks/voice_studio/index.jsx', 'export default 2');
    const said = []; const ran = [];
    const r = ensureInterface(root, { run: (c) => { ran.push(c); built(); }, say: (m) => said.push(m) });
    expect(ran).toEqual(['npm run build']);
    expect(r).toMatchObject({ built: true, ok: true, reason: 'changed' });
    expect(said.join(' ')).toMatch(/rebuilding the interface/i);
    expect(buildState(root).stale).toBe(false);
  });
  it('does nothing when the build is current', () => {
    built(); const ran = [];
    expect(ensureInterface(root, { run: (c) => ran.push(c) })).toMatchObject({ built: false, ok: true });
    expect(ran).toEqual([]);
  });
  it('keeps the old interface and warns when a rebuild fails', () => {
    built(); put('src/blocks/voice_studio/index.jsx', 'export default 2');
    const warned = [];
    const r = ensureInterface(root, { run: () => { throw new Error('vite'); }, warnFn: (m) => warned.push(m) });
    expect(r).toMatchObject({ built: false, ok: false, reason: 'changed' });
    expect(warned.join(' ')).toMatch(/previous one/);
    expect(fs.existsSync(path.join(root, 'dist/index.html'))).toBe(true);
  });
  it('reports a failed first build to the caller, which stops the launch', () => {
    const r = ensureInterface(root, { run: () => { throw new Error('vite'); } });
    expect(r).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('wiring', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  it('npm run build writes the stamp last', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toMatch(/vite build && node tools\/build-stamp\.cjs --write$/);
  });
  it('the launcher checks on start and again on Restart (exit 75)', () => {
    const src = read('launch.js');
    expect(src).toMatch(/ensureInterface\(ROOT, \{ say: info, warnFn: warn \}\);\s*if \(!r\.ok/);
    expect(src).toMatch(/code === 75\) \{[\s\S]*?ensureInterface\(ROOT[\s\S]*?startServer\(\)/);
  });
  it('no notice still tells the operator that no restart is needed for a screen', () => {
    for (const f of ['src/blocks/master/InstallPanel.jsx', 'src/blocks/settings/blockLifecycle.js', 'src/kernel/routers/build.cjs']) {
      expect(read(f)).not.toMatch(/UI_NOTE = .*no restart/i);
    }
  });
});

describe('tools/ensure-interface.cjs (the carried drive starts server.cjs itself)', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  it('is the same function launch.js uses', () => expect(typeof tool.ensureInterface).toBe('function'));
  it('an install without build tools keeps the old interface and says how to fix it', () => {
    built(); put('src/blocks/voice_studio/index.jsx', 'export default 2');
    const warned = [];
    const r = tool.ensureInterface(root, { warnFn: (m) => warned.push(m) });
    expect(r).toMatchObject({ built: false, ok: false, reason: 'changed', noTools: true });
    expect(warned.join(' ')).toMatch(/npm ci && npm run build/);
  });
  it('with no interface and no build tools it is a hard stop for the launcher', () => {
    expect(tool.ensureInterface(root)).toMatchObject({ ok: false, reason: 'missing' });
  });
  it('builds through the drive\'s own npm-cli when AEON_NPM_CLI points at it', () => {
    put('node_modules/vite/package.json', '{}');
    put('npm-cli.js', "require('fs').writeFileSync(require('path').join(process.cwd(),'ran.txt'), process.argv.slice(2).join(' '))");
    const r = tool.ensureInterface(root, { env: { ...process.env, AEON_NPM_CLI: path.join(root, 'npm-cli.js') } });
    expect(r).toMatchObject({ built: true, ok: true, reason: 'missing' });
    expect(fs.readFileSync(path.join(root, 'ran.txt'), 'utf8')).toBe('run build');
  });
  it('every carried launcher builds before it serves, and again after a Restart', () => {
    const src = read('scripts/build-usb-carry.cjs');
    expect((src.match(/ensure-interface\.cjs/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(src).toMatch(/Restarting AEON\.\.\."\n  \[ -f "\$APP\/tools\/ensure-interface\.cjs" \] && \{ "\$NODE"/);
    expect(src).toMatch(/Restarting AEON\.\.\.\n  if exist "%APP%\\\\tools\\\\ensure-interface\.cjs" "%NODE%"[^\n]*\n  goto run/);
    expect((src.match(/export AEON_NPM_CLI=/g) || []).length).toBe(2);
  });
  it('the stale-screen banner no longer sends customers to npm', () => {
    expect(read('src/components/DesktopLayout.jsx')).not.toMatch(/until you run <code>npm run build/);
  });
});
