'use strict';
// Rebuild the interface (dist/) when the blocks or screens it was built from
// have changed, so "close AEON and open it again" shows a freshly installed
// block. Every way of starting AEON calls this: launch.js, and the carried
// drive's launchers (which start server.cjs themselves and used to skip the
// build entirely — a block installed on the drive never got a screen).
//
// Never stops a boot over a failed rebuild unless there is no interface at all.
//   node tools/ensure-interface.cjs        exit 0 always, except 1 when there is no interface to serve

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { buildState } = require('./build-stamp.cjs');

const WHY = {
  missing: 'Building the interface (one time)...',
  unstamped: 'Refreshing the interface...',
  changed: 'New or changed blocks found — rebuilding the interface (a minute)...',
};

// The drive carries its own Node and npm and has no `npm` on PATH, so a
// launcher points AEON_NPM_CLI at its npm-cli.js; elsewhere plain `npm` works.
function defaultRun(root, env = process.env) {
  const cli = env.AEON_NPM_CLI;
  if (cli && fs.existsSync(cli)) {
    const sep = process.platform === 'win32' ? ';' : ':';
    execFileSync(process.execPath, [cli, 'run', 'build'], {
      cwd: root, stdio: 'inherit',
      env: { ...env, PATH: path.dirname(process.execPath) + sep + (env.PATH || '') },
    });
  } else {
    execSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
  }
}

/** The build tool is a dev dependency; a drive installed with --omit=dev cannot rebuild. */
function canBuild(root) {
  return fs.existsSync(path.join(root, 'node_modules', 'vite', 'package.json'));
}

function ensureInterface(root, { run, say = () => {}, warnFn = () => {}, env = process.env } = {}) {
  const state = buildState(root);
  if (!state.stale) return { built: false, ok: true, reason: null };
  if (!run && !canBuild(root)) {
    if (state.reason === 'missing') return { built: false, ok: false, reason: state.reason };
    warnFn('A new or changed block needs the interface rebuilt, but this install has no build tools '
      + '(it was installed without dev dependencies). Run "npm ci && npm run build" in the AEON folder, '
      + 'with internet. Using the previous interface for now.');
    return { built: false, ok: false, reason: state.reason, noTools: true };
  }
  say(WHY[state.reason]);
  try { (run || ((cmd) => defaultRun(root, env)))('npm run build'); }
  catch {
    if (state.reason === 'missing') return { built: false, ok: false, reason: state.reason };
    warnFn('Could not rebuild the interface — using the previous one. Run "npm run build" to see why.');
    return { built: false, ok: false, reason: state.reason };
  }
  return { built: true, ok: true, reason: state.reason };
}

module.exports = { ensureInterface, canBuild, defaultRun };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const r = ensureInterface(root, {
    say: (m) => console.log('  [--] ' + m),
    warnFn: (m) => console.log('  [!!] ' + m),
  });
  process.exit(!r.ok && r.reason === 'missing' ? 1 : 0);
}
