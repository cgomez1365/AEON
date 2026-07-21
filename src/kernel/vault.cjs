/**
 * AEON Vault — encrypted secret store, runtime-aware.
 *
 * Holds API keys by reference id (e.g. "groq-main") so the endpoint registry
 * can point at a key without ever embedding it. Encrypted at rest with
 * AES-256-GCM; the master key comes from AEON_VAULT_MASTER_KEY (env), never
 * from code or the stored blob.
 *
 * Persistence is split-brain by design (see model-connection-topology):
 *   • Desktop  → authoritative local file (aeon-vault.json), mirrored to Supabase.
 *   • Vercel   → read-only FS, so it pulls the encrypted blob from Supabase
 *                and decrypts in-memory with the same master key.
 *
 * Zero new deps — Node builtin crypto only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isVercel = !!process.env.VERCEL;
const APP_ROOT = path.join(__dirname, '..', '..');           // Command_Center_App
const SECRETS_DIR = path.join(APP_ROOT, 'secrets');
try { if (!isVercel) fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch {}
const VAULT_FILE = path.join(SECRETS_DIR, 'aeon-vault.json'); // local authoritative (desktop)
const VAULT_ROW_ID = 1;                                       // singleton row in Supabase

function masterKey() {
  const raw = process.env.AEON_VAULT_MASTER_KEY;
  if (!raw) return null;
  // Derive a stable 32-byte key from whatever the operator set.
  return crypto.createHash('sha256').update(String(raw)).digest();
}

// ── AES-256-GCM ──────────────────────────────────────────────────────
function encrypt(plainObj) {
  const key = masterKey();
  if (!key) throw new Error('AEON_VAULT_MASTER_KEY not set — cannot encrypt vault');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), data: data.toString('hex') };
}
function decrypt(blob) {
  const key = masterKey();
  if (!key) throw new Error('AEON_VAULT_MASTER_KEY not set — cannot decrypt vault');
  if (!blob || !blob.iv) return {};
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(blob.data, 'hex')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// ── Storage backends ─────────────────────────────────────────────────
function readLocalBlob() {
  if (!fs.existsSync(VAULT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch { return null; }
}
function writeLocalBlob(blob) {
  // Atomic write: tmp → rename, so a crash mid-save never corrupts the vault.
  const tmp = VAULT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE);
}

async function readCloudBlob(supabase) {
  if (!supabase) return null;
  try {
    const { data } = await supabase.from('aeon_vault').select('blob').eq('id', VAULT_ROW_ID).maybeSingle();
    return data?.blob || null;
  } catch { return null; }
}
async function writeCloudBlob(supabase, blob) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('aeon_vault')
      .upsert({ id: VAULT_ROW_ID, blob, updated_at: new Date().toISOString() });
    return !error;
  } catch { return false; }
}

// ── Public API ───────────────────────────────────────────────────────
/** Load decrypted secrets map. On Vercel, source from cloud; on desktop, local. */
async function loadSecrets(supabase) {
  const blob = isVercel ? await readCloudBlob(supabase) : (readLocalBlob() || await readCloudBlob(supabase));
  if (!blob) return {};
  try { return decrypt(blob); } catch (e) { console.error('[VAULT] decrypt failed:', e.message); return {}; }
}

/** Get one secret by ref. */
async function getSecret(ref, supabase) {
  const all = await loadSecrets(supabase);
  return all[ref] || null;
}

/** Set/replace a secret. Writes local (if not Vercel) AND mirrors to cloud. */
async function setSecret(ref, value, supabase) {
  const all = await loadSecrets(supabase);
  all[ref] = value;
  const blob = encrypt(all);
  if (!isVercel) writeLocalBlob(blob);
  await writeCloudBlob(supabase, blob);
  return true;
}

/** Remove a secret. */
async function removeSecret(ref, supabase) {
  const all = await loadSecrets(supabase);
  delete all[ref];
  const blob = encrypt(all);
  if (!isVercel) writeLocalBlob(blob);
  await writeCloudBlob(supabase, blob);
  return true;
}

/** List ref ids only — never values. Safe for UI. */
async function listRefs(supabase) {
  const all = await loadSecrets(supabase);
  return Object.keys(all);
}

/** Force-push local vault to cloud (desktop → Supabase). */
async function syncToCloud(supabase) {
  const blob = readLocalBlob();
  if (!blob) return false;
  return writeCloudBlob(supabase, blob);
}

/** Whether the vault is usable (master key present). */
function isUnlocked() { return !!masterKey(); }

module.exports = {
  loadSecrets, getSecret, setSecret, removeSecret, listRefs,
  syncToCloud, isUnlocked, isVercel,
};
