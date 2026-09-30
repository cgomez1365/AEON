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

// The settings block API and the first-run guard both use this file. This
// service MUST read the same one — it previously pointed at a nonexistent
// root-level file, so the whole kernel ran on the hardcoded fallback below
// (wrong roles, no prefs). Found 2026-07-16. Since 2026-09-14 the file lives
// in the AEON home (<home>/aeon-settings.json, AEON_SETTINGS_FILE to
// override); storage resolves it, so every reader and the first-run copy agree.
const SETTINGS_FILE = storage.SETTINGS_FILE;
const SECURITY_VAULT_DIR = storage.getVaultFile(path.join('blocks', 'security'));
const CLOUD_CREDENTIALS_FILE = path.join(SECURITY_VAULT_DIR, 'cloud_credentials.json');
const PROVIDER_CREDENTIALS_FILE = path.join(SECURITY_VAULT_DIR, 'provider_credentials.json');
/**
 * Approved provider credential BASES.
 *
 * A base admits its plain name and its numbered siblings — GROQ_API_KEY,
 * GROQ_API_KEY_2, GROQ_API_KEY_3 … — because that numbering IS the key pool
 * convention the kernel reads (services/ai.js buildPool, scanGeminiEnvKeys).
 *
 * This was a flat list of exact names, which enumerated GEMINI_FREE_KEY_1..3
 * and stopped: Gemini could hold three accounts and every other provider
 * exactly one, and a fourth Gemini key was refused. The operator's whole
 * strategy — several free accounts per provider, AEON rotating between them —
 * was unreachable from the UI for every provider but one, and capped there.
 *
 * It stays an allowlist. An unlisted base is still refused, and the suffix
 * must be a plain number: nothing here admits an arbitrary name.
 */
const PROVIDER_SECRET_BASES = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_FREE_KEY',
  'GEMINI_PAID_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
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
];

/** GROQ_API_KEY and GROQ_API_KEY_7 are both approved; GROQ_API_KEY_X is not. */
const isProviderSecretKey = (name) =>
  typeof name === 'string' && PROVIDER_SECRET_BASES.some(
    base => name === base || (name.startsWith(base + '_') && /^[1-9][0-9]{0,2}$/.test(name.slice(base.length + 1))),
  );

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (e) {
    // A file that exists but does not parse is moved aside before defaults
    // are returned — the next save would otherwise write defaults over every
    // role assignment in it.
    //
    // ONLY a parse failure. A read that fails (EMFILE when descriptors run
    // out, EACCES, EIO) says nothing about the file, which is usually fine:
    // moving it aside turned one bad moment into a lasting loss — every later
    // read hit ENOENT and ran on defaults until someone restored it by hand.
    // renameSync needs no descriptor, so it succeeded under EMFILE.
    if (e instanceof SyntaxError) {
      const aside = `${SETTINGS_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(SETTINGS_FILE, aside); console.error(`[SETTINGS] ${path.basename(SETTINGS_FILE)} did not parse (${e.message}); kept as ${path.basename(aside)}, using defaults`); }
      catch (re) { console.error(`[SETTINGS] ${path.basename(SETTINGS_FILE)} did not parse and could not be moved aside: ${re.message}`); }
    } else if (e.code !== 'ENOENT') {
      console.error(`[SETTINGS] ${path.basename(SETTINGS_FILE)} could not be read (${e.code || e.message}); using defaults for this call, file left in place`);
    }
    let m = null;
    try {
      const rt = JSON.parse(fs.readFileSync(path.join(storage.DATA_ROOT, 'local-runtime.json'), 'utf8'));
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

/**
 * What a stored key must look like: printable ASCII, no spaces.
 *
 * A key goes into an HTTP header (Bearer, x-api-key) or a URL. A zero-width
 * space from a copy, an em-dash note, a line break or a "  # comment" cannot:
 * Node refuses the header ("Cannot convert argument to a ByteString") before
 * any request exists, so no status comes back, nothing rotates or cools, and
 * the provider stays "connected" while every turn fails. trim() does not
 * remove U+200B. Checked where keys are SAVED, naming the field and the
 * position — never echoing the value.
 */
const KEY_SHAPE_RE = /^[\x21-\x7e]+$/;
function keyShapeProblem(value) {
  if (typeof value !== 'string' || !value) return 'is empty';
  if (KEY_SHAPE_RE.test(value)) return null;
  const chars = [...value];
  const at = chars.findIndex((ch) => !KEY_SHAPE_RE.test(ch));
  const ch = chars[at];
  const what = /\s/.test(ch) ? 'a space or line break'
    : ch.codePointAt(0) < 0x80 ? 'a control character'
    : 'a non-ASCII character (often an invisible one picked up while copying)';
  return `contains ${what} at position ${at + 1}`;
}
function validateKeyValue(value, field) {
  const v = nonEmptyString(value, field);
  const problem = keyShapeProblem(v);
  if (problem) {
    throw Object.assign(
      new Error(`${field} is not a usable key: it ${problem}. Paste the key by itself, with no note after it.`),
      { statusCode: 400, code: 'KEY_SHAPE' },
    );
  }
  return v;
}
// The one approved credential that never travels in a header or URL: a
// Coinbase CDP API secret is a PEM private key that signs requests locally —
// spaces and line breaks are its shape. Stored as given (trimmed), like before.
const LOCAL_SIGNING_BASES = new Set(['COINBASE_API_SECRET']);
const travelsAsHeader = (name) => !LOCAL_SIGNING_BASES.has(String(name).replace(/_[1-9][0-9]{0,2}$/, ''));

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
      if (!isProviderSecretKey(key)) {
        throw Object.assign(new Error(`${key} is not an approved provider credential`), { statusCode: 400 });
      }
      const secret = travelsAsHeader(key) ? validateKeyValue(value, key) : nonEmptyString(value, key);
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

  function remove(names) {
    const data = loadForWrite();
    const removed = (names || []).filter((k) => k in data.secrets);
    for (const k of removed) delete data.secrets[k];
    if (removed.length) write(data);
    return removed;
  }

  return { save, hydrate, metadata, remove, file };
}

/**
 * One home for keys: move provider/search keys found in .env into the
 * encrypted vault, then comment their .env lines out. A key in both places
 * meant removing it in Settings did not stick — .env brought it back on the
 * next boot — and it sat in plaintext on disk. Bootstrap values (the vault
 * master key, VITE_*, paths, rate limits) are not keys and stay in .env.
 *
 * Each key is written, then read back from the vault, BEFORE its .env line
 * changes; anything that cannot be verified is left exactly where it was.
 * Skipped when the vault is locked or the store is unreadable. Idempotent.
 */
// The line a moved key leaves behind in .env.
const MOVED_LINE_RE = /^#\s*([A-Z0-9_]+) moved to the encrypted vault \d{4}-\d{2}-\d{2} — manage it in Settings\s*$/;

function migrateEnvKeysToVault(envFile, { store = createProviderCredentialStore(), date = new Date() } = {}) {
  if (!envFile || !fs.existsSync(envFile)) return { moved: [], healed: [], skipped: 'no-env-file' };
  if (!vault.isUnlocked()) return { moved: [], healed: [], skipped: 'vault-locked' };
  const meta = store.metadata();
  if (meta.__unreadable) return { moved: [], healed: [], skipped: 'store-unreadable' };

  let text = fs.readFileSync(envFile, 'utf8');

  // Repair (2026-09-28): the first version of this move read .env with its own
  // parser, which kept inline comments. Placeholder lines such as
  //   SERPER_API_KEY=   # optional — get one at serper.dev
  // — empty to dotenv — were stored as the key "# optional — …", and Orion's
  // web search then failed on an invalid header. A stored "key" that is a
  // comment is never a key: take it out of the vault and put the line back.
  //
  // The same parser also kept a REAL key's trailing comment, and the quotes
  // around a value followed by one:
  //   GROQ_API_KEY=gsk_live1 # main — acct     stored "gsk_live1 # main — acct"
  //   OPENROUTER_API_KEY="sk-or-1" # free       stored "\"sk-or-1\" # free"
  // dotenv reads those lines as gsk_live1 and sk-or-1, which is what ran
  // before the move. The .env line is now the "moved" comment, so nothing
  // would ever re-read it: every Groq call sent the comment in its Bearer
  // header. Each key this move took (its line carries the marker) is re-read
  // the way dotenv reads it; a value that changes is stored as dotenv reads
  // it, and one that reads as empty is a placeholder, handled as above.
  // Only a value that parser could have produced — one holding whitespace or
  // opening with a quote — is re-read: a key saved in Settings since (the
  // marker stays) may hold a bare '#', which dotenv would cut.
  const dotenv = require('dotenv');
  const healed = [];
  const repaired = [];
  {
    const held = {};
    store.hydrate(held);
    const movedHere = new Set(text.split(/\r?\n/).map((l) => MOVED_LINE_RE.exec(l)?.[1]).filter(Boolean));
    const reread = (k) => dotenv.parse(`${k}=${held[k]}`)[k] || '';
    const bogus = Object.keys(held).filter((k) => /^\s*#/.test(held[k])
      || (movedHere.has(k) && !reread(k)));
    const fix = {};
    for (const k of movedHere) {
      if (typeof held[k] !== 'string' || bogus.includes(k) || !travelsAsHeader(k)) continue;
      if (!/\s|^['"`]/.test(held[k])) continue;
      const v = reread(k);
      if (v === held[k]) continue;
      const problem = keyShapeProblem(v);
      if (problem) { console.warn(`[VAULT] ${k} in the vault is not a usable key (it ${problem}) — re-enter it in Settings.`); continue; }
      fix[k] = v;
    }
    if (bogus.length) {
      text = text.split(/(\r?\n)/).map((part) => {
        const m = MOVED_LINE_RE.exec(part);
        return m && bogus.includes(m[1]) ? `${m[1]}=   ${held[m[1]].trim()}` : part;
      }).join('');
      writeFileAtomic(envFile, text);
      healed.push(...store.remove(bogus));
    }
    if (Object.keys(fix).length) {
      repaired.push(...store.save(fix));
      console.log(`[VAULT] Repaired ${repaired.length} key(s) stored with their .env comment or quotes attached: ${repaired.join(', ')}`);
    }
  }

  // dotenv's own parser: the same reading the server gives this file at boot
  // (inline comments, quotes, export, CRLF), so an empty placeholder stays empty.
  const parsed = dotenv.parse(text);
  const found = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!isProviderSecretKey(name) || !value || /^\s*#/.test(value)) continue;
    // A value that cannot be sent stays in .env, where the operator can see
    // and fix it — importing it would hide it behind a "moved" comment.
    const problem = travelsAsHeader(name) ? keyShapeProblem(value) : null;
    if (problem) { console.warn(`[VAULT] ${name} in .env is not a usable key (it ${problem}) — left in .env, not moved.`); continue; }
    found[name] = value.trim(); // as save() stores it, so the read-back compares equal
  }
  const names = Object.keys(found);
  if (!names.length) return { moved: [], healed, repaired, skipped: null };

  // The vault already wins at boot (hydrate runs after dotenv), so a key it
  // holds is not overwritten; only keys it lacks are imported.
  const current = store.metadata();
  const toImport = Object.fromEntries(names.filter((n) => !current[n]).map((n) => [n, found[n]]));
  if (Object.keys(toImport).length) store.save(toImport);
  const check = {};
  store.hydrate(check);
  // Only a line whose value the vault now holds is commented out. A .env
  // value that DIFFERS from the vault's is usually the operator's newest
  // input (a rotated key typed into .env): commenting it out erased it from
  // disk while the old key kept serving and the log said "moved". It stays
  // exactly as written, and the log says which copy runs.
  const verified = names.filter((n) => check[n] === found[n]);
  const differs = names.filter((n) => current[n] && typeof check[n] === 'string' && check[n] && check[n] !== found[n]);
  for (const n of differs) {
    console.warn(`[VAULT] ${n} in .env differs from the copy in the encrypted vault — the vault copy is what runs. The .env line was left untouched; save the new value in Settings to use it.`);
  }
  if (!verified.length) return { moved: [], healed, repaired, differs, skipped: names.length > differs.length ? 'not-verified' : null };

  const stamp = date.toISOString().slice(0, 10);
  const out = text.split(/(\r?\n)/).map((part) => {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(part);
    return m && verified.includes(m[1])
      ? `# ${m[1]} moved to the encrypted vault ${stamp} — manage it in Settings`
      : part;
  }).join('');
  writeFileAtomic(envFile, out);
  try { fs.chmodSync(envFile, 0o600); } catch { /* not supported here */ }
  return { moved: verified, imported: Object.keys(toImport), healed, repaired, differs, skipped: null };
}

/**
 * BO-A3b for keys that live in the vault.
 *
 * launch.js replaces a known-exposed credential (security/compromised-
 * credentials.json holds only SHA-256 digests) by reading its `KEY=` line in
 * .env. Once migrateEnvKeysToVault moved the key, that line is a comment and
 * the check saw nothing: an exposed AEON_MOBILE_SECRET in the vault was never
 * rotated again. This runs the same check against the vault's copy.
 *
 * `generate(key)` returns the replacement, or null for a key that cannot be
 * minted locally (a provider's API key) — that one is reported, not changed.
 * Returns { rotated, exposed }. Read-only when nothing matches.
 */
function rotateCompromisedSecrets({ listFile, store = createProviderCredentialStore(), generate } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')).credentials || []; }
  catch { return { rotated: [], exposed: [] }; }
  if (!list.length || !vault.isUnlocked()) return { rotated: [], exposed: [] };
  const held = {};
  store.hydrate(held);
  const exposed = Object.keys(held).filter((key) => {
    const digest = crypto.createHash('sha256').update(String(held[key])).digest('hex');
    return list.some((c) => c.key === key && c.sha256 === digest);
  });
  const replace = {};
  for (const key of exposed) {
    const next = typeof generate === 'function' ? generate(key) : null;
    if (next) replace[key] = next;
  }
  const rotated = Object.keys(replace).length ? store.save(replace) : [];
  return { rotated, exposed };
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
  migrateEnvKeysToVault,
  rotateCompromisedSecrets,
  keyShapeProblem, validateKeyValue, MOVED_LINE_RE,
  SETTINGS_FILE,
  CLOUD_CREDENTIALS_FILE,
  PROVIDER_CREDENTIALS_FILE,
  PROVIDER_SECRET_BASES, isProviderSecretKey,
};
