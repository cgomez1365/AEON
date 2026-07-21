#!/usr/bin/env node
/**
 * S1b — BGI Store publish bot. Deterministic, zero LLM tokens, rerunnable.
 *
 *   node tools/publish-store.cjs
 *
 * dist-blocks/*.aeon → <BGI site>/store/cartridges/ + <BGI site>/store/catalog.json
 * (sha256 per cartridge so a stranger can verify what they downloaded).
 * store.html is authored, not generated — this bot never touches it.
 * Deploy to Cloudflare stays a portfolio-block act (POST /api/portfolio/deploy).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { listCatalog, DIST_DIR } = require('../src/kernel/store.cjs');

const SITE_DIR = process.env.BGI_SITE_DIR ||
  path.join(__dirname, '..', 'src', 'blocks', 'second_brain', 'data', 'Vault', 'Projects', 'Portfolio');

function publishStore() {
  if (!fs.existsSync(SITE_DIR)) return { ok: false, error: `BGI site folder not found: ${SITE_DIR}` };
  const storeDir = path.join(SITE_DIR, 'store');
  const cartDir = path.join(storeDir, 'cartridges');
  fs.mkdirSync(cartDir, { recursive: true });

  const items = [];
  for (const entry of listCatalog()) {
    if (entry.error) { items.push(entry); continue; }
    const src = path.join(DIST_DIR, entry.file);
    const buf = fs.readFileSync(src);
    fs.writeFileSync(path.join(cartDir, entry.file), buf);
    items.push({
      ...entry,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      download: `store/cartridges/${entry.file}`,
    });
  }

  const catalog = {
    store: 'Broken Gear Industries — AEON Block Store',
    generatedAt: new Date().toISOString(),
    installHint: 'On your AEON: POST /api/store/install {"url":"<download url>"} — perms below are what you are agreeing to.',
    items,
  };
  fs.writeFileSync(path.join(storeDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return { ok: true, published: items.length, storeDir, items: items.map(i => i.file || i.error) };
}

if (require.main === module) {
  const r = publishStore();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
module.exports = { publishStore, SITE_DIR };
