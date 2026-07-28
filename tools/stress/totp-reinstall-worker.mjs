// Worker: boots the given clone's OWN security.js + sessionValidator.cjs
// (not a shared in-process module — each invocation is a separate Node
// process against a fresh temp Vault dir), creates an account, enables
// 2FA, and prints the resulting {secret, uri, qrDataUrl} as JSON on stdout.
// Invoked by verify-totp-reinstalls.mjs, one process per clone.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const cloneDir = process.argv[2];
if (!cloneDir) { console.error('usage: node totp-reinstall-worker.mjs <cloneDir>'); process.exit(1); }

const require = createRequire(import.meta.url);
const express = require(path.join(cloneDir, 'node_modules', 'express'));
const mountSecurity = require(path.join(cloneDir, 'src', 'blocks', 'security', 'api', 'security.js'));
const { createSessionValidator } = require(path.join(cloneDir, 'src', 'kernel', 'server-utils', 'sessionValidator.cjs'));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-totp-reinstall-'));
const app = express();
app.use(express.json());
const sessionValidator = createSessionValidator({
  securityDir: path.join(tempDir, 'Vault', 'blocks', 'security'),
  legacyUserFile: path.join(tempDir, 'legacy-user.json'),
  bootTime: Date.now() - 1,
  mobileSecret: null,
});
mountSecurity(app, { sessionValidator, writeOSAudit: () => {} });

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

try {
  const setup = await post('/api/auth/setup', {
    username: 'reinstall-check',
    password: 'CorrectHorse9!',
    recoveryQuestions: [
      { questionId: 'q01', answer: 'Pine Street School' },
      { questionId: 'q02', answer: 'Portland' },
      { questionId: 'q03', answer: 'Comet' },
    ],
  });
  if (setup.status !== 200) throw new Error(`account setup failed: ${JSON.stringify(setup.body)}`);

  const login = await post('/api/auth/login', { username: 'reinstall-check', password: 'CorrectHorse9!' });
  if (login.status !== 200 || !login.body.token) throw new Error(`login failed: ${JSON.stringify(login.body)}`);

  const start = await post('/api/auth/2fa/setup', {}, login.body.token);
  if (start.status !== 200) throw new Error(`2fa/setup failed: ${JSON.stringify(start.body)}`);

  console.log(JSON.stringify({
    ok: true,
    secret: start.body.secret,
    uri: start.body.uri,
    qrDataUrl: start.body.qrDataUrl,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
} finally {
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
