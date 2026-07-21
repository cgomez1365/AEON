/**
 * Vendored Ollama — download the official portable release into a folder
 * INSIDE AEON, no system install, no admin rights. Shared by the Cookbook
 * block (server API, used from inside the running app) and launch.js (used
 * once, before the server exists, for the first-boot offer) so there is
 * exactly one place that knows the asset names and extraction steps.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Official GitHub release asset names (github.com/ollama/ollama/releases).
// Portable zip/tarball of the binary + GPU runners — no installer needed.
const RELEASE_ASSETS = {
  'win32:x64':   'ollama-windows-amd64.zip',
  'win32:arm64': 'ollama-windows-arm64.zip',
  'darwin:x64':  'ollama-darwin.tgz',
  'darwin:arm64':'ollama-darwin.tgz', // universal build
  'linux:x64':   'ollama-linux-amd64.tgz',
  'linux:arm64': 'ollama-linux-arm64.tgz',
};

function assetKey() { return `${os.platform()}:${os.arch()}`; }
function assetName() { return RELEASE_ASSETS[assetKey()] || null; }

function vendoredBin(vendorDir) {
  const bin = os.platform() === 'win32'
    ? path.join(vendorDir, 'ollama.exe')
    : path.join(vendorDir, 'bin', 'ollama');
  return fs.existsSync(bin) ? bin : null;
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / (1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// What a fresh install would cost, before anyone commits to it.
async function checkStatus(vendorDir) {
  const installed = !!vendoredBin(vendorDir);
  const asset = assetName();
  if (installed || !asset) return { installed, supported: !!asset, asset: asset || null };
  try {
    const r = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const a = (d.assets || []).find(x => x.name === asset);
    return { installed: false, supported: true, asset, version: d.tag_name, size_bytes: a ? a.size : null, size: a ? formatSize(a.size) : null };
  } catch (e) {
    return { installed: false, supported: true, asset, error: e.message };
  }
}

// Download + extract, streaming progress lines to onLog. Throws on failure —
// callers decide how to surface that (task log, console, etc).
async function install(vendorDir, onLog = () => {}) {
  const asset = assetName();
  if (!asset) throw new Error(`No portable Ollama build for ${assetKey()}`);
  fs.mkdirSync(vendorDir, { recursive: true });
  const archivePath = path.join(vendorDir, asset);

  onLog(`Downloading ${asset}...`);
  const url = `https://github.com/ollama/ollama/releases/latest/download/${asset}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(archivePath, buf);
  onLog(`Downloaded ${formatSize(buf.length)}. Extracting...`);

  if (os.platform() === 'win32') {
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${vendorDir}' -Force"`, { windowsHide: true, timeout: 300000 });
  } else {
    fs.mkdirSync(path.join(vendorDir, 'bin'), { recursive: true });
    execSync(`tar -xzf "${archivePath}" -C "${vendorDir}"`, { timeout: 300000 });
    const rootBin = path.join(vendorDir, 'ollama');
    const wantBin = path.join(vendorDir, 'bin', 'ollama');
    if (fs.existsSync(rootBin) && !fs.existsSync(wantBin)) fs.renameSync(rootBin, wantBin);
    try { fs.chmodSync(wantBin, 0o755); } catch {}
  }
  try { fs.unlinkSync(archivePath); } catch {} // don't keep the (up to 1.5GB) archive around

  const bin = vendoredBin(vendorDir);
  if (!bin) throw new Error('Extraction finished but the ollama binary was not found — the release layout may have changed.');
  onLog(`Installed at ${bin}`);
  return bin;
}

module.exports = { assetKey, assetName, vendoredBin, checkStatus, install, formatSize };
