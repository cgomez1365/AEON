// ============================================================
// INCREMENTAL NEURAL INDEXER
// Only indexes NEW, MODIFIED, or DELETED synapses.
// Uses a manifest file to track what's already been processed.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_DIR = process.env.AEON_WORKSPACE ? path.join(process.env.AEON_WORKSPACE, 'Data', 'Second_Brain') : path.resolve(__dirname, '..', '..', '..', 'Second_Brain');
const DATA_FILE = path.join(__dirname, '../src/brain-data.json');
const MANIFEST_FILE = path.join(__dirname, '../.sync-manifest.json');

const ignoreDirs = ['node_modules', '.git', '.obsidian', '.vercel', 'dist', '__pycache__', 'Obsidian', 'locales', 'resources'];
const readableExts = ['.md', '.txt', '.json', '.csv', '.pdf', '.docx', '.js', '.jsx', '.ts', '.html', '.css'];

function fileHash(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}-${stat.mtimeMs}`;
  } catch { return null; }
}

function loadManifest() {
  if (fs.existsSync(MANIFEST_FILE)) {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));
  }
  return { files: {}, lastRun: null };
}

function saveManifest(manifest) {
  manifest.lastRun = new Date().toISOString();
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function walkReadable(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignoreDirs.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkReadable(fullPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (readableExts.includes(ext)) {
        result.push(fullPath);
      }
    }
  }
  return result;
}

(async () => {
  console.log('⚡ INCREMENTAL INDEXER STARTED...');

  const manifest = loadManifest();
  const currentFiles = walkReadable(BRAIN_DIR);

  // Build current state
  const currentState = {};
  for (const f of currentFiles) {
    const key = f.replace(/\\/g, '/');
    currentState[key] = fileHash(f);
  }

  // Diff against manifest
  const newFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  // Check for new + modified
  for (const [key, hash] of Object.entries(currentState)) {
    if (!manifest.files[key]) {
      newFiles.push(key);
    } else if (manifest.files[key] !== hash) {
      modifiedFiles.push(key);
    }
  }

  // Check for deleted
  for (const key of Object.keys(manifest.files)) {
    if (!currentState[key]) {
      deletedFiles.push(key);
    }
  }

  console.log(`   NEW:      ${newFiles.length} synapses`);
  console.log(`   MODIFIED: ${modifiedFiles.length} synapses`);
  console.log(`   DELETED:  ${deletedFiles.length} synapses`);

  if (newFiles.length === 0 && modifiedFiles.length === 0 && deletedFiles.length === 0) {
    console.log('✅ Brain is up to date. No changes detected.');
    process.exit(0);
  }

  // If this is the first run (no manifest), defer to full indexer
  if (!manifest.lastRun) {
    console.log('🔄 First run detected. Deferring to full indexer...');
    process.exit(1); // Signal to bat to run full index
  }

  // Load existing brain-data
  let brainData = { nodes: [], links: [] };
  if (fs.existsSync(DATA_FILE)) {
    brainData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }

  // Remove deleted nodes
  if (deletedFiles.length > 0) {
    const deletedSet = new Set(deletedFiles);
    brainData.nodes = brainData.nodes.filter(n => !deletedSet.has(n.id));
    brainData.links = brainData.links.filter(l => !deletedSet.has(l.source) && !deletedSet.has(l.target));
    console.log(`🗑️  Pruned ${deletedFiles.length} deleted synapses.`);
  }

  // For new/modified, we flag them for the full indexer to pick up on next full run
  // But we update the manifest so they won't be re-flagged
  console.log(`📝 ${newFiles.length + modifiedFiles.length} synapses queued for next full index.`);

  // Update manifest with current state
  manifest.files = currentState;
  saveManifest(manifest);

  // Save updated brain-data (with deletions applied)
  fs.writeFileSync(DATA_FILE, JSON.stringify(brainData, null, 2));

  if (newFiles.length > 0 || modifiedFiles.length > 0) {
    console.log('🔄 Triggering full indexer for new/modified files...');
    process.exit(1);
  }

  console.log('✅ Incremental index complete.');
})();
