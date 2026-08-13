/**
 * AEON Jarvis — Settings Service
 * Single reader for aeon-settings.json (the nervous system's kernel view).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage.js');
const vault = require('../src/kernel/vault.cjs');

/**
 * Atomic write with a per-writer temp name.
 *
 * BO-SHIP P1.2 — this file had three copies of `const tmp = \`${file}.tmp\``.
 * A fixed temp name is shared scratch: two concurrent writers truncate each
 * other and the rename publishes whichever half-written file happens to be
 * there. Unique naming makes rename the only shared step, and rename is
 * atomic. One helper, so the next site cannot get it wrong independently.
 */
function writeFileAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

const ROOT = path.join(__dirname, '..');
// The settings block API and the first-run guard both use src/aeon-settings.json.
// This service MUST read the same file — it previously pointed at a nonexistent
// root-level file, so the whole kernel ran on the hardcoded fallback below
// (wrong roles, no prefs). Found 2026-07-16.
const SETTINGS_FILE = path.join(ROOT, 'src', 'aeon-settings.json');
const SECURITY_VAULT_DIR = storage.getVaultFile(path.join('blocks', 'security'));
const CLOUD_CREDENTIALS_FILE = path.join(SECURITY_VAULT_DIR, 'cloud_credentials.json');
const PROVIDER_CREDENTIALS_FILE = path.join(SECURITY_VAULT_DIR, 'provider_credentials.json');
const PROVIDER_SECRET_KEYS = new Set([
  'GROQ_API_KEY',
  'GEMINI_FREE_KEY_1',
  'GEMINI_FREE_KEY_2',
  'GEMINI_FREE_KEY_3',
  'GEMINI_PAID_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'BRAVE_API_KEY',
  'COINGECKO_API_KEY',
  'COINBASE_API_KEY',
  'COINBASE_API_SECRET',
  'CANVA_CLIENT_SECRET',
  'YOUTUBE_API_KEY',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'AEON_MOBILE_SECRET',
]);

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch {
    let m = null;
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(process.env.DATA_PATH || path.join(ROOT, 'data'), 'local-runtime.json'), 'utf8'));
      m = rt?.models?.find(x => x.ready !== false)?.id || null;
    } catch {}
    const role = { provider: 'local', model: m };
    return { models: { chat: role, grading: role, research: role, creative: role, agent_worker: role, agent_heavy: role, agent_final: role }, roulette: false, prefs: {} };
  }
};

function saveSettings(settings) {
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function sanitizeSettings(value) {
  if (Array.isArray(value)) return value.map(sanitizeSettings);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:api.?key|secret|token|password|credential|service.?role)/i.test(key)) continue;
    clean[key] = sanitizeSettings(entry);
  }
  return clean;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
  }
  return value.trim();
}

function validateSupabaseConfig(input = {}) {
  const urlText = nonEmptyString(input.url || input.SUPABASE_URL, 'Supabase URL');
  let parsed;
  try { parsed = new URL(urlText); }
  catch { throw Object.assign(new Error('Supabase URL must be a valid HTTPS URL'), { statusCode: 400 }); }
  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Supabase URL must use HTTPS'), { statusCode: 400 });
  }

  const anonKey = nonEmptyString(input.anonKey || input.SUPABASE_ANON_KEY, 'Supabase anon key');
  if (anonKey.length < 20) {
    throw Object.assign(new Error('Supabase anon key is not valid'), { statusCode: 400 });
  }
  const serviceRoleKey = String(input.serviceRoleKey || input.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (serviceRoleKey && serviceRoleKey.length < 20) {
    throw Object.assign(new Error('Supabase service role key is not valid'), { statusCode: 400 });
  }

  return {
    url: parsed.toString().replace(/\/$/, ''),
    anonKey,
    ...(serviceRoleKey ? { serviceRoleKey } : {}),
  };
}

const FIREBASE_FIELDS = {
  apiKey: ['apiKey', 'VITE_FIREBASE_API_KEY'],
  authDomain: ['authDomain', 'VITE_FIREBASE_AUTH_DOMAIN'],
  projectId: ['projectId', 'VITE_FIREBASE_PROJECT_ID'],
  storageBucket: ['storageBucket', 'VITE_FIREBASE_STORAGE_BUCKET'],
  messagingSenderId: ['messagingSenderId', 'VITE_FIREBASE_MESSAGING_SENDER_ID'],
  appId: ['appId', 'VITE_FIREBASE_APP_ID'],
  measurementId: ['measurementId', 'VITE_FIREBASE_MEASUREMENT_ID'],
};

function validateFirebaseConfig(input = {}) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); }
    catch { throw Object.assign(new Error('Firebase config must be valid JSON'), { statusCode: 400 }); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Firebase Web Config object is required'), { statusCode: 400 });
  }
  if (input.private_key || input.privateKey || input.client_email || input.clientEmail) {
    throw Object.assign(new Error('Firebase service-account credentials are not accepted here; use Web Config'), { statusCode: 400 });
  }

  const config = {};
  for (const [field, aliases] of Object.entries(FIREBASE_FIELDS)) {
    const value = aliases.map((key) => input[key]).find((entry) => typeof entry === 'string' && entry.trim());
    if (value) config[field] = value.trim();
  }
  for (const field of ['apiKey', 'authDomain', 'projectId', 'appId']) {
    nonEmptyString(config[field], `Firebase ${field}`);
  }
  if (!/^[a-z0-9-]+$/i.test(config.projectId)) {
    throw Object.assign(new Error('Firebase projectId is not valid'), { statusCode: 400 });
  }
  return config;
}

// Fail-closed read for an encrypted credential store. Distinguishes a MISSING
// file (safe to initialize) from an existing-but-UNREADABLE one — vault locked,
// wrong master key, corrupt ciphertext, or malformed JSON. Callers that mutate
// MUST refuse to write when status is 'unreadable': overwriting would destroy
// the original ciphertext. The reason is a coarse code and never secret content.
function readCredentialStore(file, collection) {
  if (!fs.existsSync(file)) return { status: 'missing', data: { version: 1, [collection]: {} } };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { status: 'unreadable', reason: 'io-error' }; }
  let blob;
  try { blob = JSON.parse(raw); }
  catch { return { status: 'unreadable', reason: 'malformed-json' }; }
  if (!vault.isUnlocked()) return { status: 'unreadable', reason: 'vault-locked' };
  let data;
  try { data = vault.unseal(blob); }
  catch { return { status: 'unreadable', reason: 'undecryptable' }; }
  // A genuine store always carries its collection object. A missing/empty
  // decrypt result (e.g. a truncated blob) is corruption, not an empty store.
  if (!data || typeof data !== 'object' || !data[collection] || typeof data[collection] !== 'object') {
    return { status: 'unreadable', reason: 'corrupt-shape' };
  }
  return { status: 'ok', data };
}

function createCloudCredentialStore(options = {}) {
  const file = options.file || CLOUD_CREDENTIALS_FILE;

  function read() { return readCredentialStore(file, 'providers'); }

  // Mutations fail closed — never overwrite a store we could not read back.
  function loadForWrite() {
    const r = read();
    if (r.status === 'unreadable') {
      throw Object.assign(
        new Error('Cloud credential store exists but is unreadable; refusing to overwrite it'),
        { statusCode: 409, code: 'CREDENTIAL_STORE_UNREADABLE', reason: r.reason },
      );
    }
    return r.data;
  }

  function write(data) {
    if (!vault.isUnlocked()) {
      throw Object.assign(new Error('Encrypted Vault is locked; configure the Vault master key before saving credentials'), { statusCode: 503 });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(vault.seal(data), null, 2));
  }

  function save(provider, payload) {
    if (!['supabase', 'firebase'].includes(provider)) {
      throw Object.assign(new Error('Unsupported cloud provider'), { statusCode: 400 });
    }
    const credentials = provider === 'supabase'
      ? validateSupabaseConfig(payload)
      : validateFirebaseConfig(payload);
    const data = loadForWrite();
    data.providers[provider] = { credentials, updatedAt: new Date().toISOString() };
    write(data);
    return metadata();
  }

  function remove(provider) {
    const data = loadForWrite();
    delete data.providers[provider];
    write(data);
    return metadata();
  }

  function credentials(provider) {
    const r = read();
    return r.status === 'ok' ? (r.data.providers[provider]?.credentials || null) : null;
  }

  function metadata() {
    const r = read();
    if (r.status === 'unreadable') {
      return {
        active: [],
        unreadable: true,
        reason: r.reason,
        supabase: { configured: false, source: null },
        firebase: { configured: false, source: null },
      };
    }
    const providers = r.data.providers;
    const supabase = providers.supabase?.credentials;
    const firebase = providers.firebase?.credentials;
    const result = {
      active: [],
      supabase: {
        configured: !!(supabase?.url && supabase?.anonKey),
        source: supabase ? 'vault' : null,
        projectUrl: supabase?.url || null,
        projectId: supabase?.url ? new URL(supabase.url).hostname.split('.')[0] : null,
        hasAnonKey: !!supabase?.anonKey,
        hasServiceRoleKey: !!supabase?.serviceRoleKey,
      },
      firebase: {
        configured: !!(firebase?.projectId && firebase?.apiKey),
        source: firebase ? 'vault' : null,
        projectId: firebase?.projectId || null,
        authDomain: firebase?.authDomain || null,
        appId: firebase?.appId || null,
        hasApiKey: !!firebase?.apiKey,
      },
    };
    if (result.supabase.configured) result.active.push('supabase');
    if (result.firebase.configured) result.active.push('firebase');
    return result;
  }

  return { save, remove, credentials, metadata, file };
}

function createProviderCredentialStore(options = {}) {
  const file = options.file || PROVIDER_CREDENTIALS_FILE;

  function read() { return readCredentialStore(file, 'secrets'); }

  function loadForWrite() {
    const r = read();
    if (r.status === 'unreadable') {
      throw Object.assign(
        new Error('Provider credential store exists but is unreadable; refusing to overwrite it'),
        { statusCode: 409, code: 'CREDENTIAL_STORE_UNREADABLE', reason: r.reason },
      );
    }
    return r.data;
  }

  function write(data) {
    if (!vault.isUnlocked()) {
      throw Object.assign(new Error('Encrypted Vault is locked; configure the Vault master key before saving credentials'), { statusCode: 503 });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(vault.seal(data), null, 2));
  }

  function save(vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      throw Object.assign(new Error('vars object required'), { statusCode: 400 });
    }
    const data = loadForWrite();
    const written = [];
    for (const [key, value] of Object.entries(vars)) {
      if (!PROVIDER_SECRET_KEYS.has(key)) {
        throw Object.assign(new Error(`${key} is not an approved provider credential`), { statusCode: 400 });
      }
      const secret = nonEmptyString(value, key);
      data.secrets[key] = secret;
      written.push(key);
    }
    if (written.length) write(data);
    return written;
  }

  function hydrate(target = process.env) {
    // Read-only: an unreadable store hydrates nothing rather than wiping env or
    // masking the fault — the on-disk ciphertext is left intact for recovery.
    const r = read();
    if (r.status === 'unreadable') return [];
    for (const [key, value] of Object.entries(r.data.secrets)) target[key] = value;
    return Object.keys(r.data.secrets);
  }

  function metadata() {
    const r = read();
    if (r.status === 'unreadable') return { __unreadable: r.reason };
    return Object.fromEntries(Object.keys(r.data.secrets).map((key) => [key, 'vault']));
  }

  return { save, hydrate, metadata, file };
}

function hydrateProviderSecrets(target = process.env) {
  return createProviderCredentialStore().hydrate(target);
}

module.exports = {
  loadSettings,
  saveSettings,
  sanitizeSettings,
  validateSupabaseConfig,
  validateFirebaseConfig,
  createCloudCredentialStore,
  createProviderCredentialStore,
  hydrateProviderSecrets,
  SETTINGS_FILE,
  CLOUD_CREDENTIALS_FILE,
  PROVIDER_CREDENTIALS_FILE,
  PROVIDER_SECRET_KEYS,
};
