/**
 * One Second Brain index per data root, whoever loaded the module, and no
 * memory left out of it because a scan was already running.
 *
 * C06 (sweep, 2026-09-28). The index, manifest, chunk sidecar and scan mutex
 * were one per data root — per MODULE. Every block rescan (Settings ▸ Blocks
 * remove/restore/start, a store install or update, a build approve) purges the
 * block folders from require.cache and re-requires ingest.cjs for the HTTP
 * routes, while the kernel's liveBlockModule keeps the copy it built at boot
 * (memory-write scans, the boot sync, the nightly timer). Two maps, two
 * indexes: an /upload or ingest through the new copy was erased by the old
 * copy's next checkpoint, the two could scan at once, and every rescan added
 * another nightly interval nothing cleared.
 *
 * C44. A memory saved while a scan was in flight joined that scan, whose file
 * list was fixed when it started — the new <id>.md was never in it, and no
 * second pass followed. /recall could not find it until the next boot,
 * nightly or manual scan.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Before any require that can reach the kernel: nothing here may resolve a
// root inside the install this suite runs from.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-index-owner-'));
const savedEnv = { AEON_HOME: process.env.AEON_HOME, AEON_SECRETS_DIR: process.env.AEON_SECRETS_DIR, AEON_ENV_FILE: process.env.AEON_ENV_FILE };
process.env.AEON_HOME = path.join(TMP, 'home');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
process.env.AEON_ENV_FILE = path.join(TMP, '.env');

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INGEST = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'api', 'ingest.cjs');
const MATRIX_DIR = path.join(ROOT, 'src', 'blocks', 'aeon_matrix') + path.sep;

const load = () => require(INGEST);
/** What blockHost.rescan() does to a block folder before it mounts it again. */
const purgeMatrix = () => { for (const id of Object.keys(require.cache)) if (id.startsWith(MATRIX_DIR)) delete require.cache[id]; };

let n = 0, vault, dataRoot, probes, release;
let gate;
// The scan's first embed is its space probe, made right after it lists the
// Vault. Holding it holds the scan at exactly the point that matters.
const embed = async (text) => {
  if (text === 'aeon space probe') { probes++; await gate; }
  return { vector: [1, 0, 0], model: 'stub#document' };
};
const deps = () => ({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed });
const write = (rel, body) => { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const diskIndex = () => JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
const memory = (id, text) => `---\nid: ${id}\ncategory: fact\npinned: false\n---\n\n${text}\n`;

/** Wait until no scan is running on any data root (a follow-up included). */
async function idle() {
  for (let i = 0; i < 300; i++) {
    const stores = globalThis[Symbol.for('aeon.matrix.ingest.stores')];
    if (!stores || [...stores.values()].every((s) => !s.inFlight)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function post(router, routePath, body) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods.post);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(layer.route.stack[0].handle({ body, query: {}, headers: {} }, res, reject)).catch(reject);
  });
}

beforeEach(async () => {
  await idle();
  load()._resetStores();
  n++;
  vault = path.join(TMP, `vault-${n}`);
  dataRoot = path.join(TMP, `data-${n}`);
  fs.mkdirSync(vault, { recursive: true });
  probes = 0;
  gate = new Promise((r) => { release = r; });
});

afterAll(async () => {
  release?.();
  await idle();
  load()._resetStores();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('C06: a block rescan does not split the index into two owners', () => {
  it('a document ingested through the re-required HTTP copy survives the kernel copy\'s scan', async () => {
    write('a.md', '# Pallet audit\n\nThree racks on aisle four were out of spec and tagged for repair.\n');
    const kernelCopy = load()(deps());        // liveBlockModule's instance, kept for the process
    purgeMatrix();                            // Settings ▸ Blocks ▸ Restore, a store update, …
    const httpCopy = load()(deps());          // the routes, mounted again

    const scan = kernelCopy.runSecondBrainScan();   // listed the Vault; now waiting at the probe
    const up = await post(httpCopy, '/crn/second-brain/ingest/document', {
      file_path: 'b.md', content: '# Fuel log\n\nTruck 12 took on 80 litres at the north depot on Monday.\n',
    });
    expect(up.body.ok).toBe(true);
    release();
    await scan;
    await idle();

    expect(Object.keys(diskIndex().documents).sort()).toEqual(['a.md', 'b.md']);
  });

  it('a scan through one copy joins a scan already running in the other', async () => {
    write('a.md', '# Pallet audit\n\nThree racks on aisle four were out of spec and tagged for repair.\n');
    const kernelCopy = load()(deps());
    purgeMatrix();
    const httpCopy = load()(deps());

    const first = kernelCopy.runSecondBrainScan();
    const events = [];
    const second = httpCopy.runSecondBrainScan((e) => events.push(e));
    expect(events.some((e) => e.joined)).toBe(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    await idle();
    expect(probes).toBe(1);
  });

  it('the nightly re-index is one timer per data root, not one more per rescan', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      load()(deps());
      purgeMatrix();
      load()(deps());
      purgeMatrix();
      load()(deps());
      const hourly = spy.mock.calls.filter(([, ms]) => ms === 60 * 60 * 1000);
      expect(hourly).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});

describe('C44: a memory saved during a scan is indexed when that scan ends', () => {
  it('without another boot, nightly or manual scan', async () => {
    write('Agents/Aeon/memory/aaa111.md', memory('aaa111', 'The operator invoices on net 15 terms.'));
    const ingest = load()(deps());

    const running = ingest.runSecondBrainScan();   // the boot sync, say — its file list is fixed now
    write('Agents/Aeon/memory/bbb222.md', memory('bbb222', 'Payroll runs every other Friday.'));
    const joined = ingest.runSecondBrainScan();    // memory_core → requestIndex → the scheduler
    ingest.runSecondBrainScan();                   // a second save in the same window
    release();
    await Promise.all([running, joined]);

    await vi.waitFor(() => {
      expect(diskIndex().documents).toHaveProperty(['Agents/Aeon/memory/bbb222.md']);
    }, { timeout: 3000, interval: 20 });
    await idle();
    // Every request that arrived during the run shared ONE follow-up.
    expect(probes).toBe(2);
    expect(diskIndex().documents).toHaveProperty(['Agents/Aeon/memory/aaa111.md']);
  });

  it('a join with nothing new written costs no second scan', async () => {
    write('a.md', '# Pallet audit\n\nThree racks on aisle four were out of spec and tagged for repair.\n');
    const ingest = load()(deps());
    const running = ingest.runSecondBrainScan();
    const joined = ingest.runSecondBrainScan();
    release();
    await Promise.all([running, joined]);
    await idle();
    expect(probes).toBe(1);
  });
});
