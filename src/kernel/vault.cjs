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

const isVercel = require('./runtime.cjs').isCloud();
const APP_ROOT = path.join(__dirname, '..', '..');           // Command_Center_App
const SECRETS_DIR = process.env.AEON_SECRETS_DIR || path.join(APP_ROOT, 'secrets');
try { if (!isVercel) fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch {}
const VAULT_FILE = path.join(SECRETS_DIR, 'aeon-vault.json'); // local authoritative (desktop)
const VAULT_ROW_ID = 1;                                       // singleton row in Supabase

// Envelope keyslots — the DEK (which actually encrypts the vault) is wrapped
// under one or more protectors (the .env/file key, a recovery code, later a
// keychain or passphrase). The DEK is stable, so re-keying a protector never
// re-encrypts vault data. This is what lets the same install move .env → keychain
// → passphrase, and recover from a lost .env, without ever losing the stores.
const KEYSLOTS_FILE = path.join(SECRETS_DIR, 'aeon-keyslots.json');
let _dek = null;                 // cached 32-byte data-encryption key
let _dekEnvKey = null;           // the AEON_VAULT_MASTER_KEY that _dek was resolved under
let _pendingRecoveryCode = null; // revealed once after first-run generation

// The .env master key hashed to 32 bytes — the "file" protector's KEK.
function envKek() {
  const raw = process.env.AEON_VAULT_MASTER_KEY;
  return raw ? crypto.createHash('sha256').update(String(raw)).digest() : null;
}

// Resolve the DEK (read-only, no writes). With keyslots present the DEK is
// unwrapped from the file slot; without them it IS the env-derived key —
// identical to the pre-envelope behavior, so existing stores read unchanged.
// Cache is keyed on the current env value so a rotated key re-resolves (never
// returns a stale DEK — important for fail-closed decryption).
function masterKey() {
  const raw = process.env.AEON_VAULT_MASTER_KEY || null;
  if (_dek && _dekEnvKey === raw) return _dek;
  _dek = null; _dekEnvKey = raw;
  const kek = envKek();
  const slots = readKeyslots();
  if (slots?.slots?.file && kek) {
    try { _dek = unwrapDEK(slots.slots.file, kek); return _dek; }
    catch { _dek = null; return null; } // env key doesn't match this vault → locked
  }
  if (kek) { _dek = kek; return _dek; }
  return null;
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

// Scoped Vault stores use the same authenticated encryption without joining
// the endpoint secret map. The caller still owns the file location and schema.
function seal(value) { return encrypt(value); }
function unseal(blob) { return decrypt(blob); }

// ── Envelope keyslots ────────────────────────────────────────────────
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function genRecoveryCode() {
  return `AEON-${crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;
}
// Wrap/unwrap the DEK under a 32-byte KEK with authenticated encryption.
function wrapDEK(dek, kek) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const data = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function unwrapDEK(slot, kek) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(slot.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(slot.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(slot.data, 'hex')), decipher.final()]);
}
function readKeyslots() {
  if (!fs.existsSync(KEYSLOTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(KEYSLOTS_FILE, 'utf8')); } catch { return null; }
}
function writeKeyslots(slots) {
  const tmp = KEYSLOTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(slots, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, KEYSLOTS_FILE);
}
// The .env key and the keyslot file are two halves of the SAME protector: the
// "file" slot wraps the DEK under the key stored in .env. AEON_SECRETS_DIR
// already relocates one half, so the other must be relocatable too — otherwise
// pointing the vault at a temp directory still reissues the key into the real
// install's .env. That is exactly what made `npm test` rotate the developer's
// live AEON_VAULT_MASTER_KEY on every run.
const ENV_FILE = process.env.AEON_ENV_FILE || path.join(APP_ROOT, '.env');

function writeEnvKey(hexKey) {
  const envFile = ENV_FILE;
  let env = '';
  try { env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : ''; } catch {}
  if (/^AEON_VAULT_MASTER_KEY=.*$/m.test(env)) {
    env = env.replace(/^AEON_VAULT_MASTER_KEY=.*$/m, `AEON_VAULT_MASTER_KEY=${hexKey}`);
  } else {
    env += `${env.endsWith('\n') || !env ? '' : '\n'}AEON_VAULT_MASTER_KEY=${hexKey}\n`;
  }
  fs.writeFileSync(envFile, env, { mode: 0o600 });
}

/**
 * First-run envelope init (idempotent, desktop-only — Vercel FS is read-only).
 * Wraps the current DEK under the .env protector AND a recovery-code slot, and
 * stashes a one-time recovery code for the caller to reveal. Because the DEK is
 * unchanged, this never re-encrypts existing stores.
 */
function ensureKeyslots() {
  if (isVercel) return { created: false, reason: 'cloud-readonly' };
  const kek = envKek();
  if (!kek) return { created: false, reason: 'no-env-key' };
  if (readKeyslots()) return { created: false, reason: 'exists' };
  const dek = masterKey(); // = envKek() here (no keyslots yet)
  if (!dek) return { created: false, reason: 'locked' };
  const code = genRecoveryCode();
  const salt = crypto.randomBytes(16);
  const recKek = crypto.scryptSync(normalizeCode(code), salt, 32);
  writeKeyslots({
    v: 1,
    slots: {
      file: wrapDEK(dek, kek),
      recovery: { salt: salt.toString('hex'), ...wrapDEK(dek, recKek) },
    },
    createdAt: new Date().toISOString(),
  });
  _pendingRecoveryCode = code;
  console.log(`\n${'='.repeat(64)}\n[VAULT] Recovery code (write this down — shown once):\n\n        ${code}\n\n[VAULT] Restores vault access if this device or its .env is lost.\n${'='.repeat(64)}\n`);
  return { created: true };
}

/**
 * Break-glass: unwrap the DEK with the recovery code, then reissue a fresh .env
 * (file) protector. The DEK is unchanged, so every encrypted store stays
 * readable — this is the guarantee that a lost .env never bricks the vault.
 */
function recoverWithCode(code) {
  if (isVercel) return { ok: false, error: 'unsupported-on-cloud' };
  const slots = readKeyslots();
  if (!slots?.slots?.recovery) return { ok: false, error: 'no-recovery-slot' };
  let dek;
  try {
    const kek = crypto.scryptSync(normalizeCode(code), Buffer.from(slots.slots.recovery.salt, 'hex'), 32);
    dek = unwrapDEK(slots.slots.recovery, kek);
  } catch { return { ok: false, error: 'invalid-code' }; }
  const newEnv = crypto.randomBytes(32).toString('hex');
  slots.slots.file = wrapDEK(dek, crypto.createHash('sha256').update(newEnv).digest());
  writeKeyslots(slots);
  process.env.AEON_VAULT_MASTER_KEY = newEnv;
  _dek = dek; _dekEnvKey = newEnv;
  try { writeEnvKey(newEnv); } catch (e) { return { ok: true, envKeyReissued: false, warn: e.message }; }
  return { ok: true, envKeyReissued: true };
}

function consumePendingRecoveryCode() { const c = _pendingRecoveryCode; _pendingRecoveryCode = null; return c; }
function getRecoveryStatus() {
  const slots = readKeyslots();
  return {
    hasKeyslots: !!slots,
    hasRecoverySlot: !!slots?.slots?.recovery,
    protectors: slots ? Object.keys(slots.slots || {}) : [],
  };
}
function __resetForTest() { _dek = null; _dekEnvKey = null; _pendingRecoveryCode = null; }

// ── Storage backends ─────────────────────────────────────────────────
function readLocalBlob() {
  if (!fs.existsSync(VAULT_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch { return null; }
}
function writeLocalBlob(blob) {
  // Atomic write: tmp → rename, so a crash mid-save never corrupts the vault.
  //
  // BO-SHIP P1.2 — the temp name must be unique per writer. It was a fixed
  // VAULT_FILE + '.tmp', so two concurrent writers used the SAME scratch file:
  // one truncated it while the other was mid-write, and the rename published
  // whatever was there. Uniqueness makes the rename the only shared step, and
  // rename is atomic.
  const tmp = `${VAULT_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(blob, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, VAULT_FILE);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ── Cross-process write lock ─────────────────────────────────────────
// BO-SHIP P1.2. setSecret/removeSecret are read-modify-write against one file.
// Without a lock, concurrent callers each read the same starting state and the
// last write wins: 40 concurrent setSecret() calls retained 14 of 40.
//
// open(..., 'wx') is atomic — it fails if the file exists — which is the whole
// primitive. A stale lock (crashed writer) is broken after LOCK_STALE_MS so a
// crash cannot brick the vault; that is the same "never lock the owner out"
// rule that governs the key guard.
const LOCK_FILE = () => `${VAULT_FILE}.lock`;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

function tryAcquireLock() {
  const lock = LOCK_FILE();
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.unlinkSync(lock); // stale writer died holding it
        return tryAcquireLock();
      }
    } catch { /* lock vanished between calls — next attempt will get it */ }
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE()); } catch {}
}

/**
 * Run `fn` with exclusive access to the vault file.
 *
 * Deliberately NOT branched on isVercel. The cloud-surface ratchet counts
 * cloud conditionals and they may only fall, so a new `if (isVercel)` here
 * would have raised the baseline 95 → 96 to accommodate this fix. The real
 * constraint is not "is this cloud" but "is this filesystem writable", which
 * is what we test — and testing the actual constraint is the better check
 * anyway. A read-only FS degrades to no lock, and says so rather than
 * pretending it locked (R-05).
 */
async function withVaultLock(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 4;
  let held = false;

  while (!held) {
    try {
      held = tryAcquireLock();
    } catch (e) {
      // Not contention — the lock cannot be created here at all (read-only FS).
      console.warn(`[VAULT] write lock unavailable (${e.code || e.message}); proceeding unserialized`);
      return fn();
    }
    if (held) break;
    if (Date.now() > deadline) {
      throw new Error('[VAULT] timed out waiting for the write lock');
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 100); // backoff, capped so we stay responsive
  }

  try {
    return await fn();
  } finally {
    releaseLock();
  }
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
  // The read and the write are one critical section — see withVaultLock.
  return withVaultLock(async () => {
    const all = await loadSecrets(supabase);
    all[ref] = value;
    const blob = encrypt(all);
    if (!isVercel) writeLocalBlob(blob);
    await writeCloudBlob(supabase, blob);
    return true;
  });
}

/** Remove a secret. */
async function removeSecret(ref, supabase) {
  // Same read-modify-write critical section as setSecret.
  return withVaultLock(async () => {
    const all = await loadSecrets(supabase);
    delete all[ref];
    const blob = encrypt(all);
    if (!isVercel) writeLocalBlob(blob);
    await writeCloudBlob(supabase, blob);
    return true;
  });
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
  syncToCloud, isUnlocked, isVercel, seal, unseal,
  // Envelope keyslots
  ensureKeyslots, recoverWithCode, consumePendingRecoveryCode, getRecoveryStatus,
  wrapDEK, unwrapDEK, __resetForTest,
};
