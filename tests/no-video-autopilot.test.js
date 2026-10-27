/**
 * Video autopilot is retired. This gate fails if it comes back.
 *
 * CEO, 2026-10-27, asked to retire it or document it: "retire".
 *
 * tools/autopilot-daemon.cjs was a YouTube video producer that the kernel
 * mounted on every start (/api/autopilot/status, /ledger, /start, /stop and
 * /upload-now). It stitched random clips with FFmpeg, asked Groq for a title
 * with its own GROQ_API_KEY read, outside kernelLLM (so Settings → Models →
 * Local only never applied to it), and uploaded the result to YouTube as a
 * PUBLIC video through googleapis. No doc said that (docs/KERNEL.md and two
 * block READMEs only named it); the Dashboard and Fleet Control each showed
 * its status card. services/media.js was the same
 * pipeline's other half (an FFmpeg stitch with an optional YouTube upload),
 * handed to blocks through deps; no block in this repository asked for it.
 * The YouTube credential slots in Settings and .env.example served only these
 * two files, so they went too. Deleted per Bible §21; git history is the
 * rollback path.
 *
 * What a user's AEON already wrote stays on their disk: autopilot_ledger.json
 * and the Vault's Autopilot_Log/ notes are data, not code, and YouTube keys
 * saved earlier stay in the vault or .env, read by nothing.
 *
 * §18: an absence-only gate passes just as happily on a product with no
 * Dashboard. The second half asserts what the cards sat on still works. A real
 * boot of server/server.js without these files is tests/sweep-server-home-lock.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Production source: everything that runs or ships. tests/ is not here (its
// dated comments may name what was removed); neither is CHANGELOG.md.
const CODE_DIRS = ['server', 'services', 'src', 'tools', 'security', 'scripts'];
const CODE_FILES = ['server.cjs', 'launch.js', 'vite.config.js'];
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|jsx|cjs|mjs|ts|json)$/.test(e.name)) acc.push(full);
  }
  return acc;
}
const code = () => [
  ...CODE_DIRS.flatMap((d) => walk(path.join(ROOT, d))),
  ...CODE_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
].map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), txt: fs.readFileSync(f, 'utf8') }));
const offenders = (re) => code().filter(({ txt }) => re.test(txt)).map(({ rel }) => rel);

// What a reader is told AEON does.
const DOCS = [
  'README.md', 'PRIVACY.md', 'EULA.md', 'TERMS_OF_USE.md', '.env.example',
  ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md') && f !== 'BLOCKS.md').map((f) => `docs/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'src', 'blocks'))
    .map((b) => `src/blocks/${b}/README.md`).filter((f) => fs.existsSync(path.join(ROOT, f))),
];

describe('Video autopilot stays deleted', () => {
  it('the daemon and the media service do not exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'tools', 'autopilot-daemon.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'services', 'media.js'))).toBe(false);
  });

  it('no production source names it, mounts its routes or asks for its deps', () => {
    expect(offenders(/autopilot/i), 'autopilot is named in production source').toEqual([]);
    expect(offenders(/services\/media(\.js)?['"]|finalizeVideoStitch|processingJobs/),
      'the media service or its deps are referenced').toEqual([]);
  });

  it('nothing uploads to YouTube or reads YouTube credentials', () => {
    expect(offenders(/videos\.insert|google\.youtube\(|\bYOUTUBE_[A-Z_]+/), 'YouTube upload code or credentials').toEqual([]);
  });

  it('googleapis is not a dependency and nothing requires it', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(pkg[field] || {}), `package.json ${field}`).not.toContain('googleapis');
    }
    const lock = JSON.parse(read('package-lock.json'));
    expect(Object.keys(lock.packages[''].dependencies || {})).not.toContain('googleapis');
    expect(Object.keys(lock.packages)).not.toContain('node_modules/googleapis');
    // The package, not the hosts: generativelanguage.googleapis.com is Gemini.
    expect(offenders(/require\(\s*['"]googleapis['"]|from\s+['"]googleapis['"]|import\(\s*['"]googleapis['"]/),
      'googleapis is required').toEqual([]);
  });

  it('Settings offers no autopilot permission', () => {
    const caps = require(path.join(ROOT, 'src', 'kernel', 'capabilities.cjs'));
    expect(Object.keys(caps.CAPABILITIES)).not.toContain('tool_autopilot');
    expect(read('src/blocks/settings/index.jsx')).not.toMatch(/capKey="tool_autopilot"/);
  });

  it('no doc says AEON has it, uploads to YouTube or holds YouTube keys', () => {
    const bad = DOCS.filter((f) => /autopilot|\/api\/autopilot|YOUTUBE_[A-Z_]+|media pipeline/i.test(read(f)));
    expect(bad, 'docs still describe the video uploader').toEqual([]);
    expect(read('PRIVACY.md')).not.toMatch(/YouTube/);
  });
});

describe('what the autopilot cards sat on still works', () => {
  it('the Dashboard KPI row keeps its three cards and still polls the kernel', () => {
    const src = read('src/blocks/dashboard/index.jsx');
    for (const label of ['Spend today', 'LLM calls today', 'Server']) {
      expect(src, `Dashboard lost its "${label}" card`).toMatch(new RegExp(`<StatCard label="${label}"`));
    }
    expect(src).toMatch(/const loadFleetData = useCallback\(async \(\) => \{[\s\S]*?fetch\('\/api\/llm-telemetry'\)/);
    expect(src).toMatch(/setInterval\(loadFleetData, 5000\)/);
  });

  it('Fleet Control keeps its status cards and the routes behind them', () => {
    const src = read('src/blocks/fleet_control/index.jsx');
    for (const label of ['AEON Server', 'LLM Calls · since start', 'Providers']) {
      expect(src, `Fleet Control lost its "${label}" card`).toContain(`label="${label}"`);
    }
    for (const route of ['/api/llm-telemetry', '/core/provider-health', '/api/agents']) {
      expect(src, `Fleet Control no longer reads ${route}`).toContain(`fetch('${route}'`);
    }
  });

  it('the Second Brain document route the producer posted to is still mounted', () => {
    // It has other callers (Matrix's Edit mode, writer); only one client went.
    const src = read('src/blocks/aeon_matrix/api/ingest.cjs');
    expect(src).toMatch(/router\.post\('\/crn\/second-brain\/ingest\/document'/);
    expect(src).toMatch(/router\.put\('\/crn\/second-brain\/ingest\/document'/);
  });

  it('every remaining agent permission still renders in Settings → Agent', () => {
    const caps = require(path.join(ROOT, 'src', 'kernel', 'capabilities.cjs'));
    const panel = read('src/blocks/settings/index.jsx');
    const tools = Object.keys(caps.CAPABILITIES).filter((k) => k.startsWith('tool_'));
    expect(tools.length).toBeGreaterThan(0);
    for (const key of tools) expect(panel, `${key} has no toggle`).toContain(`capKey="${key}"`);
    expect(caps.describe().map((r) => r.key)).toEqual(Object.keys(caps.CAPABILITIES));
  });

  it('the terminal still routes host requests to host_os', () => {
    const router = require(path.join(ROOT, 'tools', 'terminal', 'router.cjs'));
    const registry = [
      { id: 'host_os.read', cmd: '/read', blockId: 'host_os', title: 'Read a file', desc: '', available: true },
      { id: 'writer.write', cmd: '/write', blockId: 'writer', title: 'Create a draft', desc: '', available: true },
    ];
    const r = router.fastMatch('scan the host system', registry);
    expect(r && r.blockId).toBe('host_os');
  });

  it('the kernel still composes its remaining services', () => {
    const server = read('server/server.js');
    for (const svc of ['storage', 'ai', 'search', 'system']) {
      expect(server, `server.js no longer loads services/${svc}.js`).toMatch(new RegExp(`require\\('\\.\\./services/${svc}\\.js'\\)`));
    }
  });
});

describe('what a user saved for it stays theirs', () => {
  // Bible §21 deletes code, never data. These keys were approved before
  // 2026-10-27, so a vault may hold them; the sealed file is written directly,
  // as that AEON left it (save() now refuses them).
  it('a YouTube key in the vault still loads and removes, and blocks no other key', () => {
    const settings = require(path.join(ROOT, 'services', 'settings.js'));
    const vault = require(path.join(ROOT, 'src', 'kernel', 'vault.cjs'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-no-autopilot-'));
    const savedKey = process.env.AEON_VAULT_MASTER_KEY;
    process.env.AEON_VAULT_MASTER_KEY = 'no-video-autopilot-suite-key';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const file = path.join(tmp, 'provider_credentials.json');
      fs.writeFileSync(file, JSON.stringify(vault.seal({ version: 1, secrets: {
        // Both as the first .env parser stored them (comment attached), with
        // the "moved" marker in .env: the boot repair re-reads both.
        YOUTUBE_REFRESH_TOKEN: '1//kept # old channel',
        GROQ_API_KEY: 'gsk_live1 # main',
      } }), null, 2));
      const store = settings.createProviderCredentialStore({ file });
      const held = () => { const o = {}; store.hydrate(o); return o; };

      expect(settings.isProviderSecretKey('YOUTUBE_REFRESH_TOKEN')).toBe(false);
      expect(() => store.save({ YOUTUBE_REFRESH_TOKEN: 'a-new-one' })).toThrow(/not an approved provider credential/);

      const mark = (k) => `# ${k} moved to the encrypted vault 2026-09-28 — manage it in Settings`;
      const envFile = path.join(tmp, '.env');
      const envText = `${mark('YOUTUBE_REFRESH_TOKEN')}\n${mark('GROQ_API_KEY')}\nYOUTUBE_CLIENT_SECRET=still-in-env\n`;
      fs.writeFileSync(envFile, envText);
      const r = settings.migrateEnvKeysToVault(envFile, { store });
      expect(r.repaired).toEqual(['GROQ_API_KEY']);
      expect(r.moved).toEqual([]);
      expect(held()).toEqual({ YOUTUBE_REFRESH_TOKEN: '1//kept # old channel', GROQ_API_KEY: 'gsk_live1' });
      expect(fs.readFileSync(envFile, 'utf8')).toBe(envText);

      expect(store.remove(['YOUTUBE_REFRESH_TOKEN'])).toEqual(['YOUTUBE_REFRESH_TOKEN']);
      expect(held()).toEqual({ GROQ_API_KEY: 'gsk_live1' });
    } finally {
      log.mockRestore();
      if (savedKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY; else process.env.AEON_VAULT_MASTER_KEY = savedKey;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
