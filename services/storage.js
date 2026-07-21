/**
 * AEON Jarvis — Storage Service
 * Owns the data-file map (db/docs/archive/scripts/secrets), workspace roots,
 * upload handling, and orphan cleanup. All path resolution lives here.
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ── Smart install-root detection ────────────────────────────────────────────
// AEON must "just work" wherever it's unzipped — no env var, no config, no
// pointing a folder at the app (the Obsidian pain point). We find the install
// root by walking UP from this file until we hit AEON's own package.json
// (or the server/ + src/ signature). This survives folder rename, moving the
// whole install anywhere, and being launched from any working directory,
// because __dirname is the physical location of THIS file, not the cwd.
function detectAeonRoot() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const isAeon = /aeon/i.test(pkg.name || '') ||
          (fs.existsSync(path.join(dir, 'server', 'server.js')) && fs.existsSync(path.join(dir, 'src', 'blocks')));
        if (isAeon) return dir;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;   // reached filesystem root
    dir = parent;
  }
  return path.join(__dirname, '..'); // structural fallback (services/ → install)
}

const ROOT = detectAeonRoot();

const getLocalFile = (filename) => {
  if (process.env.VERCEL) return path.join('/tmp', filename);

  const dbFiles = ['activity_heatmap.json', 'aeon_ats.json', 'aeon_notes.json', 'aeon_terminal_history.json', 'ats_candidates.json', 'audit_log.json', 'chat_log.json', 'process_registry.json', 'token_ledger.json', 'cloud_relay_schema.sql', 'logs', 'clients.json', 'inventory.json', 'quick-links.json', 'training-data.json'];
  const docsFiles = ['AEON_HISTORY.md', 'claude_transcript.md', 'GEMINI.md', '2026-06-12.md', 'AEON-SECURITY-HANDOFF.md', 'AEON-TELEMETRY-AUDIT.md', 'AEON_PHASE0-1_PATCH_BRIEFING.txt', 'CLAUDE-MEMORY-CONTEXT.md'];
  const archiveFiles = ['canva_session.json', 'canva_tokens.json', 'clients_archive.json', 'sandbox_results.json', 'sdi_violations.json', 'Staff_Comlinks', 'Untitled.base', 'Untitled.canvas'];
  const scriptsFiles = ['01_INIT.bat', '02_RUN.bat'];
  const secretsFiles = ['aeon_master_import.json', 'aeon_master_memory.json'];

  if (dbFiles.includes(filename)) return path.join(ROOT, 'db', filename);
  if (docsFiles.includes(filename)) return path.join(ROOT, 'docs', filename);
  if (archiveFiles.includes(filename)) return path.join(ROOT, 'archive', filename);
  if (scriptsFiles.includes(filename)) return path.join(ROOT, 'scripts', filename);
  if (secretsFiles.includes(filename)) return path.join(ROOT, 'secrets', filename);

  return path.join(ROOT, '..', filename);
};

// Default workspace = the AEON install folder itself. The File Manager and
// OS tools open HERE, not in the user's home directory — a consumer install
// should never greet its owner with their entire C:\Users profile. Power
// users widen the scope with AEON_WORKSPACE in .env.
const WORKSPACE = process.env.AEON_WORKSPACE || ROOT;

// ── Vault (durable knowledge) + Data (ephemeral/regenerable state) ─────────
// One canonical seam. Before this, 7+ files across aeon_matrix, council,
// memory_core, dashboard, fleet_control, portfolio, and skillifyHook each
// independently computed their own __dirname-relative path into the same
// physical Vault folder — no shared source of truth, and a real risk that
// moving or renaming it would silently orphan whichever caller nobody
// remembered to update. Every block should now import VAULT_ROOT/DATA_ROOT
// (or call getVaultFile()/getDataFile()) instead of hand-rolling the path.
//
// VAULT_ROOT still points at its current physical location on disk — this
// is a refactor, not a data move. Relocating the Vault later (e.g. to a
// clean top-level `Vault/` folder for a GitHub-portable install) becomes a
// one-line env var change instead of a hunt across the whole codebase.
const VAULT_ROOT = process.env.VAULT_PATH
  || path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'data', 'Vault');

// Top-level, general-purpose bucket for EVERY block's ephemeral/regenerable
// state — namespace by block id (getDataFile('deep_research/reports/x.json')).
// Distinct from VAULT_ROOT: nothing here needs to survive a reinstall.
const DATA_ROOT = process.env.DATA_PATH || path.join(ROOT, 'data');

const getVaultFile = (relPath) => path.join(VAULT_ROOT, relPath);
const getDataFile = (relPath) => {
  if (process.env.VERCEL) return path.join('/tmp', relPath);
  return path.join(DATA_ROOT, relPath);
};

// data/local-runtime.json — written by the Cookbook block (the owner of local
// models): models_dir, available runtimes, and every installed local model.
// Settings/kernel/blocks read THIS instead of probing or hardcoding Ollama.
const readLocalRuntime = () => {
  try { return JSON.parse(fs.readFileSync(getDataFile('local-runtime.json'), 'utf8')); }
  catch { return null; }
};

const LOG_FILE = getLocalFile('chat_log.json');
const AUDIT_FILE = getLocalFile('audit_log.json');
const SDI_VIOLATION_LOG = getLocalFile('sdi_violations.json');
const TOKEN_LEDGER_FILE = getLocalFile('token_ledger.json');
const TERMINAL_HISTORY_FILE = getLocalFile('aeon_terminal_history.json');
const NOTES_FILE = getLocalFile('aeon_notes.json');

// Drag-and-drop uploads (50MB cap)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dest = req.body.targetDir || WORKSPACE;
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const videoUpload = multer({ dest: getLocalFile('temp_frames') });

const logTrivial = (e) => {
  try {
    const logDir = getLocalFile('logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    fs.appendFileSync(path.join(logDir, 'audit_low.log'), `[TRIVIAL][${new Date().toISOString()}] ${e.message}\n`);
    if (typeof global.broadcastTerminalEvent === 'function') {
      global.broadcastTerminalEvent('SYSTEM_METRIC', `[SILENT-ERR] ${e.message}`);
    }
  } catch (err) {}
};

function cleanupOrphans() {
  const stagingDir = process.env.VERCEL ? path.join('/tmp', 'temp_staging') : getLocalFile('staging');
  const tempDir = process.env.VERCEL ? path.join('/tmp', 'temp_frames') : getLocalFile('temp_frames');
  const now = Date.now();

  const cleanDir = (dir, maxAgeMs) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.mp4') && !f.endsWith('.txt')) continue;
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > maxAgeMs) {
        try { fs.unlinkSync(p); console.log(`[AEON] Cleaned orphaned file: ${f}`); } catch (e) { logTrivial(e); }
      }
    }
  };

  cleanDir(stagingDir, 48 * 60 * 60 * 1000);
  cleanDir(tempDir, 24 * 60 * 60 * 1000);
}

module.exports = {
  ROOT, getLocalFile, WORKSPACE, upload, videoUpload, cleanupOrphans, logTrivial,
  LOG_FILE, AUDIT_FILE, SDI_VIOLATION_LOG, TOKEN_LEDGER_FILE, TERMINAL_HISTORY_FILE, NOTES_FILE,
  VAULT_ROOT, DATA_ROOT, getVaultFile, getDataFile, readLocalRuntime,
};
