/**
 * AEON Agent Tool Registry
 * Scans src/blocks/<id>/block.manifest.json at call time and returns every
 * agent_tool declared across all installed blocks. No hardcoding — blocks
 * come and go, the registry reflects reality on the next agent call.
 *
 * Each agent_tool in a manifest:
 *   { name, desc, params[], method, route, returns? }
 *
 * dispatch(name, args, port) — executes a block tool via internal HTTP.
 */
const fs = require('fs');
const path = require('path');

const BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

// Returns flat array of all agent_tools across all ready blocks.
function collectTools() {
  const tools = [];
  if (!fs.existsSync(BLOCKS_DIR)) return tools;

  for (const entry of fs.readdirSync(BLOCKS_DIR)) {
    const manifestPath = path.join(BLOCKS_DIR, entry, 'block.manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { continue; }
    if (!Array.isArray(manifest.agent_tools)) continue;
    for (const tool of manifest.agent_tools) {
      if (!tool.name || !tool.route) continue;
      tools.push({
        name: tool.name,
        desc: tool.desc || '',
        params: tool.params || [],
        method: (tool.method || 'POST').toUpperCase(),
        route: tool.route,
        returns: tool.returns || '',
        block: manifest.id,
      });
    }
  }
  return tools;
}

// Execute a block tool by routing to its declared HTTP endpoint internally.
async function dispatch(tool, args, port = process.env.PORT || 3001) {
  const url = `http://127.0.0.1:${port}${tool.route}`;
  try {
    let res;
    if (tool.method === 'GET') {
      const qs = new URLSearchParams(args).toString();
      res = await fetch(`${url}${qs ? '?' + qs : ''}`);
    } else {
      res = await fetch(url, {
        method: tool.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    }
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { result: text.slice(0, 2000) }; }
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { collectTools, dispatch };
