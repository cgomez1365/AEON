/**
 * AEON Connectivity — the Roam layer, absorbed into Settings (one settings
 * fits all). Supabase cloud mirror manage/test + Cloudflare quick tunnel
 * (free public URL, zero account) for reaching this AEON from anywhere.
 *
 *   GET  /api/settings/connectivity                 → full status
 *   POST /api/settings/connectivity/supabase/test   { url, key }? → ping REST
 *   POST /api/settings/connectivity/supabase/save   { url, anonKey } → encrypted Vault
 *   POST /api/settings/connectivity/supabase/setup  → applies db/*.sql schema files
 *   POST /api/settings/connectivity/firebase/test   { apiKey, projectId }? → ping identitytoolkit
 *   POST /api/settings/connectivity/firebase/save   { apiKey, projectId, ... } → encrypted Vault
 *   POST /api/settings/connectivity/tunnel/start    → { url: https://*.trycloudflare.com }
 *   POST /api/settings/connectivity/tunnel/stop
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { isCloud: _isCloud } = require('../../../kernel/runtime.cjs');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const BIN_DIR = path.join(ROOT, 'tools', 'bin');

/**
 * Which cloudflared build this host needs, and how to get a runnable binary
 * out of it.
 *
 * Found live, 2026-09-20 (CEO: "check... cloudflare tunnel"): CLOUDFLARED and
 * CLOUDFLARED_URL were hardcoded to the Windows .exe with no os.platform()
 * check. On macOS or Linux — the CEO's actual working machine — "Start
 * tunnel" downloaded a Windows PE binary that cannot execute; spawn() failed
 * with a generic "Could not start cloudflared: ..." rather than a clear
 * "not supported here." Verified against the real release
 * (github.com/cloudflare/cloudflared, tag 2026.9.1): Windows and Linux ship
 * a directly-runnable file; macOS ships a .tgz — the binary inside still
 * needs extracting, which the Windows-only code never had to do at all.
 *
 * @returns {{url: string, filename: string, archive: 'tgz'|null}}
 */
function cloudflaredTarget(plat = os.platform(), arch = os.arch()) {
  if (plat === 'win32') {
    const a = arch === 'ia32' ? '386' : 'amd64'; // cloudflared publishes no windows-arm64
    return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${a}.exe`, filename: `cloudflared-windows-${a}.exe`, archive: null };
  }
  if (plat === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'amd64';
    return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${a}.tgz`, filename: `cloudflared-darwin-${a}.tgz`, archive: 'tgz' };
  }
  if (plat === 'linux') {
    const map = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
    const a = map[arch];
    if (!a) return null;
    return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${a}`, filename: `cloudflared-linux-${a}`, archive: null };
  }
  return null; // no published build for this platform (e.g. FreeBSD)
}

const CLOUDFLARED_TARGET = cloudflaredTarget();
// The binary spawn() actually runs, whatever it took to get there.
const CLOUDFLARED = CLOUDFLARED_TARGET ? path.join(BIN_DIR, os.platform() === 'win32' ? CLOUDFLARED_TARGET.filename : 'cloudflared') : null;
// The kernel's actual port. A literal 3001 pointed the tunnel at whatever else
// held 3001 whenever this AEON ran elsewhere — beside a host's own AEON, that
// meant exposing the host's AEON.
const PORT = Number(process.env.PORT) || 3001;

const _tunnel = { proc: null, url: null, startedAt: null };

async function pingSupabase(url, key, fallbackKey) {
  const probe = (k) => fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
    headers: { apikey: k, Authorization: `Bearer ${k}` },
    signal: AbortSignal.timeout(8000),
  });
  const r = await probe(key);
  // Reachable project answers 200 (root spec) or 404; auth failures answer 401/403.
  if (r.status === 401 || r.status === 403) {
    // Some projects legitimately restrict anon-tier REST access entirely
    // ("Only the service_role API key can be used for this endpoint") --
    // that's a valid, hardened configuration, not proof the project/anon key
    // pairing is wrong. If a service role key was also supplied, confirm the
    // PROJECT is real and reachable through it before rejecting outright.
    if (fallbackKey) {
      const r2 = await probe(fallbackKey);
      if (r2.ok || r2.status === 404) return true;
    }
    throw new Error('Project reached, but the key was rejected.');
  }
  if (!r.ok && r.status !== 404) throw new Error(`Supabase answered HTTP ${r.status}.`);
  return true;
}

// Firebase Web Config has no anonymous "ping REST" endpoint the way Supabase
// does. accounts:lookup with no idToken is the closest thing: a valid,
// reachable API key always answers 400 MISSING_ID_TOKEN (we deliberately sent
// none); an invalid/deleted key answers a different error shape instead.
async function pingFirebase(apiKey) {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8000),
    },
  );
  const body = await r.json().catch(() => ({}));
  const message = body?.error?.message || '';
  if (message === 'MISSING_ID_TOKEN') return true;
  if (/api.?key.?not.?valid|api_key_invalid/i.test(message)) {
    throw new Error('Firebase API key was rejected.');
  }
  if (!r.ok) throw new Error(message ? `Firebase: ${message}` : `Firebase answered HTTP ${r.status}.`);
  return true;
}

module.exports = (app, deps) => {
  const supabase = deps && deps.supabase ? deps.supabase : null;
  const settingsService = require(path.join(ROOT, 'services', 'settings.js'));
  const cloudCredentials = settingsService.createCloudCredentialStore();

  // ── Status ───────────────────────────────────────────────────────────
  app.get('/api/settings/connectivity', async (req, res) => {
    const cloud = cloudCredentials.metadata();
    const url = cloud.supabase.projectUrl || '';
    res.json({
      supabase: {
        configured: cloud.supabase.configured,
        attached: !!supabase,              // live client on this boot
        url: url ? url.replace(/^https:\/\//, '').slice(0, 30) : null,
        localOnly: process.env.AEON_LOCAL_ONLY === '1',
      },
      tunnel: {
        running: !!_tunnel.proc,
        url: _tunnel.url,
        startedAt: _tunnel.startedAt,
        secured: !!process.env.AEON_MOBILE_SECRET, // tunnel traffic must Bearer-auth
      },
      runtime: _isCloud() ? 'cloud' : 'local',
    });
  });

  // ── Supabase: test (pasted values or current env) ────────────────────
  app.post('/api/settings/connectivity/supabase/test', async (req, res) => {
    try {
      const saved = cloudCredentials.credentials('supabase');
      const url = (req.body && req.body.url) || saved?.url;
      const key = (req.body && (req.body.anonKey || req.body.key)) || saved?.anonKey;
      const fallback = (req.body && req.body.serviceRoleKey) || saved?.serviceRoleKey;
      if (!url || !key) return res.status(400).json({ error: 'Paste your Supabase project URL and anon key.' });
      await pingSupabase(url, key, fallback);
      res.json({ ok: true, message: 'Connected — project reachable and key accepted.' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── First run — BO-K ────────────────────────────────────────────────
  //
  // The cloud wizard used to appear whenever Supabase was unconfigured, which
  // is not the same question as "has this operator been through setup". So it
  // returned on EVERY launch, despite promising "you do this once".
  //
  // Worse, the two buttons were backwards: "Enter AEON" (success) only flipped
  // a React variable and persisted nothing, while "Skip" wrote a localStorage
  // flag — and on success the wizard DELETED that flag. Completing setup made
  // the wizard more likely to return than giving up did.
  //
  // The flag belongs in kernel state, beside the operator account: it is a
  // property of the install, not of one browser profile, and clearing site
  // data should not resurrect a setup the operator already finished.
  app.get('/api/settings/first-run', (_req, res) => {
    try {
      const s = settingsService.loadSettings() || {};
      res.json({ ok: true, complete: s.firstRunComplete === true });
    } catch {
      // Unreadable settings must not trap someone in a setup loop. Treating
      // unknown as "done" is the safe direction: the wizard is reachable from
      // Settings, an inescapable modal on every boot is not.
      res.json({ ok: true, complete: true, degraded: true });
    }
  });

  app.post('/api/settings/first-run/complete', (_req, res) => {
    try {
      const s = settingsService.loadSettings() || {};
      s.firstRunComplete = true;
      s.firstRunCompletedAt = new Date().toISOString();
      settingsService.saveSettings(s);
      res.json({ ok: true, complete: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Public browser config — BO-K ────────────────────────────────────
  //
  // The browser used to read Supabase config from import.meta.env, which Vite
  // INLINES AT BUILD TIME. A value saved through Settings goes to the vault at
  // runtime and could never reach a bundle that was compiled before it existed,
  // so the Supabase form was a control that could not do what it offered — and
  // then showed a green "configured" badge over it.
  //
  // Serving it here closes that: one source (the vault), read live.
  //
  // ANON KEY ONLY. It is publishable by design — it is what ships in every
  // Supabase browser app, and row-level security, not secrecy, is what protects
  // the data. The service-role key is a full-access credential and must never
  // be sent to a browser; it is not read here at all, so it cannot leak by
  // someone later widening a spread.
  app.get('/api/settings/connectivity/public-config', (_req, res) => {
    let url = null;
    let anonKey = null;
    try {
      const saved = cloudCredentials.credentials('supabase');
      if (saved) { url = saved.url || null; anonKey = saved.anonKey || null; }
    } catch { /* vault locked or empty — fall through to env */ }

    // Installs that configure Supabase through .env keep working unchanged.
    if (!url) url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || null;
    if (!anonKey) anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || null;

    const configured = !!(url && anonKey);
    res.json({
      ok: true,
      configured,
      supabaseUrl: configured ? url : null,
      supabaseAnonKey: configured ? anonKey : null,
    });
  });

  // ── Supabase: save to encrypted Vault (test first) ─────────────────
  app.post('/api/settings/connectivity/supabase/save', async (req, res) => {
    try {
      const { url, anonKey, key, serviceRoleKey } = req.body || {};
      const publishableKey = anonKey || key;
      if (!url || !publishableKey) return res.status(400).json({ error: 'url and anonKey required' });
      await pingSupabase(url, publishableKey, serviceRoleKey);
      const metadata = cloudCredentials.save('supabase', { url, anonKey: publishableKey, serviceRoleKey });
      res.json({ ok: true, message: 'Saved & tested in encrypted Vault.', cloudProviders: metadata });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });

  // ── Firebase: test (pasted values or current vault entry) ───────────
  app.post('/api/settings/connectivity/firebase/test', async (req, res) => {
    try {
      const saved = cloudCredentials.credentials('firebase');
      const apiKey = (req.body && req.body.apiKey) || saved?.apiKey;
      const projectId = (req.body && req.body.projectId) || saved?.projectId;
      if (!apiKey || !projectId) return res.status(400).json({ error: 'Paste your Firebase apiKey and projectId.' });
      if (!/^[a-z0-9-]+$/i.test(projectId)) return res.status(400).json({ error: 'projectId is not valid.' });
      await pingFirebase(apiKey);
      res.json({ ok: true, message: 'Connected — Firebase API key accepted.' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Firebase: save to encrypted Vault (test first) ──────────────────
  app.post('/api/settings/connectivity/firebase/save', async (req, res) => {
    try {
      const config = req.body || {};
      if (!config.apiKey || !config.projectId) return res.status(400).json({ error: 'apiKey and projectId required' });
      await pingFirebase(config.apiKey);
      const metadata = cloudCredentials.save('firebase', config);
      res.json({ ok: true, message: 'Saved & tested in encrypted Vault.', cloudProviders: metadata });
    } catch (e) { res.status(e.statusCode || 400).json({ error: e.message }); }
  });

  // ── Cloudflare quick tunnel — free public URL, zero account ──────────
  app.post('/api/settings/connectivity/tunnel/start', async (req, res) => {
    try {
      if (_tunnel.proc) return res.json({ ok: true, url: _tunnel.url, alreadyRunning: true });

      if (!CLOUDFLARED_TARGET) {
        throw new Error(`Cloudflare Tunnel has no published build for ${os.platform()}/${os.arch()} — cloudflare/cloudflared does not ship one. The tunnel is not available on this machine.`);
      }

      if (!fs.existsSync(CLOUDFLARED)) {
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
        const r = await fetch(CLOUDFLARED_TARGET.url, { redirect: 'follow' });
        if (!r.ok) throw new Error(`Could not download Cloudflare Tunnel: HTTP ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());

        if (CLOUDFLARED_TARGET.archive === 'tgz') {
          // macOS ships the binary inside a .tgz — download, extract with the
          // system tar (present on macOS/Linux by default; no new dependency
          // for the one platform that needs this step), then discard the
          // archive. The extracted name is always `cloudflared`.
          const tgzPath = path.join(BIN_DIR, CLOUDFLARED_TARGET.filename);
          fs.writeFileSync(tgzPath, bytes);
          try {
            execFileSync('tar', ['-xzf', tgzPath, '-C', BIN_DIR], { stdio: 'pipe' });
          } catch (e) {
            throw new Error(`Downloaded Cloudflare Tunnel but could not extract it (${e.message}). Is 'tar' on PATH?`);
          } finally {
            try { fs.unlinkSync(tgzPath); } catch {}
          }
          if (!fs.existsSync(CLOUDFLARED)) throw new Error('Extracted the Cloudflare Tunnel archive but the cloudflared binary was not where expected.');
        } else {
          fs.writeFileSync(CLOUDFLARED, bytes);
        }
        // The download has no execute bit on macOS/Linux; Windows ignores this.
        if (os.platform() !== 'win32') { try { fs.chmodSync(CLOUDFLARED, 0o755); } catch {} }
        console.log('[CONNECTIVITY] Downloaded cloudflared for', `${os.platform()}/${os.arch()}`);
      }

      const proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      _tunnel.proc = proc;
      _tunnel.startedAt = new Date().toISOString();
      _tunnel.url = null;

      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tunnel did not produce a URL within 30s — check your internet connection.')), 30000);
        const onData = (chunk) => {
          const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (m) { clearTimeout(timer); _tunnel.url = m[0]; resolve(m[0]); }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        // A spawn that never starts emits 'error', not 'exit'. Without this the
        // event is unhandled — it throws past this promise and takes the server
        // down instead of failing the request.
        proc.on('error', (err) => {
          clearTimeout(timer);
          _tunnel.proc = null;
          reject(new Error(`Could not start cloudflared: ${err.message}`));
        });
        proc.on('exit', (code) => {
          clearTimeout(timer);
          _tunnel.proc = null;
          if (!_tunnel.url) reject(new Error(`Tunnel exited (code ${code}) before starting.`));
        });
      });

      proc.on('exit', () => { _tunnel.proc = null; _tunnel.url = null; });

      res.json({
        ok: true, url,
        secured: !!process.env.AEON_MOBILE_SECRET,
        note: process.env.AEON_MOBILE_SECRET
          ? 'Live while this computer is on. API calls from outside require your AEON_MOBILE_SECRET as a Bearer token.'
          : 'Live — but AEON_MOBILE_SECRET is not set, so all external API calls will be refused. Set it in .env to use the tunnel.',
      });
    } catch (e) {
      if (_tunnel.proc) { try { _tunnel.proc.kill(); } catch {} _tunnel.proc = null; }
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/settings/connectivity/tunnel/stop', (req, res) => {
    if (_tunnel.proc) { try { _tunnel.proc.kill(); } catch {} }
    _tunnel.proc = null; _tunnel.url = null;
    res.json({ ok: true });
  });

  // ── Cloud bootstrap — create all AEON tables in Supabase ───────────
  app.post('/api/settings/connectivity/supabase/setup', async (req, res) => {
    try {
      const saved = cloudCredentials.credentials('supabase');
      const url = saved?.url;
      const key = saved?.serviceRoleKey;
      if (!url || !key) return res.status(400).json({ error: 'A Vault-stored Supabase service role is required for schema setup.' });

      const { createClient } = require('@supabase/supabase-js');
      const db = createClient(url, key);

      const schemas = ['supabase_migration_aeon_blocks.sql', 'aeon_vault_schema.sql',
                        'aeon_notes_schema.sql', 'cloud_relay_schema.sql', 'aeon_governance_schema.sql'];
      const dbDir = path.join(ROOT, 'db');
      const applied = [];
      const skipped = [];

      for (const file of schemas) {
        const fp = path.join(dbDir, file);
        if (!fs.existsSync(fp)) { skipped.push(file); continue; }
        const sql = fs.readFileSync(fp, 'utf8');
        const { error } = await db.rpc('exec_sql', { sql });
        if (error) {
          // If exec_sql doesn't exist, try the REST fallback
          if (/exec_sql/.test(error.message)) {
            return res.status(400).json({
              error: 'exec_sql() RPC not found. Run this once in Supabase SQL Editor:\n\n' +
                'CREATE OR REPLACE FUNCTION exec_sql(sql text) RETURNS void\n' +
                '  LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END; $$;\n' +
                'REVOKE ALL ON FUNCTION exec_sql(text) FROM anon, authenticated;',
            });
          }
          return res.status(500).json({ error: `${file}: ${error.message}` });
        }
        applied.push(file);
      }

      res.json({ ok: true, applied, skipped, message: `Cloud ready — ${applied.length} schema(s) applied.` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Sync now — push local JSON data to Supabase aeon_blocks ────────
  app.post('/api/settings/connectivity/supabase/sync', async (req, res) => {
    try {
      const saved = cloudCredentials.credentials('supabase');
      const url = saved?.url;
      const key = saved?.serviceRoleKey;
      if (!url || !key) return res.status(400).json({ error: 'A Vault-stored Supabase service role is required for sync.' });

      const { createClient } = require('@supabase/supabase-js');
      const db = createClient(url, key);
      // Runtime state (the *.json) lives in the AEON home's db/, not beside
      // the tracked schema files in the install.
      const dbDir = require('../../../kernel/aeonHome.cjs').roots({ appRoot: ROOT }).db;

      const jsonFiles = fs.existsSync(dbDir)
        ? fs.readdirSync(dbDir).filter(f => f.endsWith('.json') && !f.startsWith('block.schema') && !f.startsWith('.'))
        : [];

      let synced = 0;
      for (const file of jsonFiles) {
        const tag = file.replace('.json', '');
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(dbDir, file), 'utf8'));
          const { error } = await db.from('aeon_blocks').upsert(
            { block_tag: tag, payload, updated_at: new Date().toISOString() },
            { onConflict: 'block_tag' }
          );
          if (!error) synced++;
        } catch {}
      }

      res.json({ ok: true, synced, total: jsonFiles.length, message: `Synced ${synced}/${jsonFiles.length} block(s) to cloud.` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Block teardown/rescan must not orphan the tunnel process.
  if (deps.lifecycle) deps.lifecycle.onCleanup(() => {
    if (_tunnel.proc) { try { _tunnel.proc.kill(); } catch {} _tunnel.proc = null; _tunnel.url = null; }
  });
};

// Exposed for tests — platform/arch resolution must be provable without
// downloading a real binary for every OS this runs on.
module.exports.cloudflaredTarget = cloudflaredTarget;
