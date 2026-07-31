#!/usr/bin/env node
/**
 * BO-A2/A3 — compute SHA-256 for the pinned runtime assets and catalog models.
 *
 * Deliberately uses AEON's OWN services/local-runtime/download.cjs, so a run of
 * this script is also an end-to-end proof that the installer's download path
 * survives real 302s from GitHub and Hugging Face.
 *
 * THE RULE: the hash is computed from the downloaded bytes. Never copied from
 * a page. A hash served by the same host as the binary proves nothing — it is
 * the only thing between a user and arbitrary code execution.
 *
 * Usage:
 *   node tools/fetch-runtime-hashes.mjs runtime            # all 5 platform zips
 *   node tools/fetch-runtime-hashes.mjs models             # all catalog models
 *   node tools/fetch-runtime-hashes.mjs models <id> [...]  # named models only
 *   node tools/fetch-runtime-hashes.mjs --write            # patch the JSON in place
 *
 * Downloads land in <repo>/data/hash-staging and are deleted after hashing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { download } = require(path.join(ROOT, 'services/local-runtime/download.cjs'));

const ASSETS_FILE = path.join(ROOT, 'services/local-runtime/runtime-assets.json');
const CATALOG_FILE = path.join(ROOT, 'services/local-runtime/model-catalog.json');
const STAGING = path.join(ROOT, 'data', 'hash-staging');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const mode = args.find(a => a === 'runtime' || a === 'models') || 'runtime';
const only = args.filter(a => a !== mode && a !== '--write');

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const mb = n => (n / 1e6).toFixed(1) + ' MB';

async function hashOne(id, url, bytesHint) {
  fs.mkdirSync(STAGING, { recursive: true });
  const dest = path.join(STAGING, `${id}-${Date.now()}.part`);
  const started = Date.now();
  let lastPct = -1;

  process.stdout.write(`\n${id}\n  ${url}\n  `);
  try {
    const res = await download(url, dest, {
      timeoutMs: 900_000,
      onProgress: (pct) => {
        if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`${pct}% `); }
      },
    });
    const digest = await sha256(dest);
    const size = fs.statSync(dest).size;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\n  ${mb(size)} in ${secs}s, ${res.redirects} redirect(s)\n  sha256 ${digest}\n`);
    if (bytesHint && Math.abs(size - bytesHint) / bytesHint > 0.25) {
      process.stdout.write(`  NOTE: declared bytes ${mb(bytesHint)} is >25% off actual ${mb(size)}\n`);
    }
    return { ok: true, sha256: digest, bytes: size };
  } catch (e) {
    process.stdout.write(`\n  FAILED: ${e.message}\n`);
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(dest); } catch {}
  }
}

async function main() {
  const results = {};

  if (mode === 'runtime') {
    const assets = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8'));
    for (const p of assets.platforms) {
      if (only.length && !only.includes(p.id)) continue;
      const r = await hashOne(p.id, p.url, p.bytes);
      results[p.id] = r;
      if (r.ok && WRITE) { p.sha256 = r.sha256; p.bytes = r.bytes; }
    }
    if (WRITE) {
      fs.writeFileSync(ASSETS_FILE, JSON.stringify(assets, null, 2) + '\n');
      console.log(`\nwrote ${path.relative(ROOT, ASSETS_FILE)}`);
    }
  } else {
    const cat = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    for (const m of cat.models) {
      if (only.length && !only.includes(m.id)) continue;
      const r = await hashOne(m.id, m.url, m.bytes);
      results[m.id] = r;
      if (r.ok && WRITE) { m.sha256 = r.sha256; m.bytes = r.bytes; }
    }
    if (WRITE) {
      cat.updatedAt = new Date().toISOString();
      fs.writeFileSync(CATALOG_FILE, JSON.stringify(cat, null, 2) + '\n');
      console.log(`\nwrote ${path.relative(ROOT, CATALOG_FILE)}`);
    }
  }

  const ok = Object.values(results).filter(r => r.ok).length;
  const bad = Object.entries(results).filter(([, r]) => !r.ok);
  console.log(`\n${ok}/${Object.keys(results).length} hashed.`);
  for (const [id, r] of bad) console.log(`  UNRESOLVED ${id}: ${r.error}`);
  try { fs.rmdirSync(STAGING); } catch {}
  process.exit(bad.length ? 1 : 0);
}

main();
