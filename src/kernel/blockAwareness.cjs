/**
 * AEON Block Awareness — VP's eyes on the cartridge rack.
 *
 * Manifest-as-truth: composes a brief for every installed block at call time.
 * Remove a block → next mission, VP never hears of it. Add one → VP sees it,
 * its commands, its routes, its permissions. Nothing is hardcoded and nothing
 * is cached across missions.
 *
 * Each brief is auto-composed from manifest fields (what it does / operates /
 * calls / reads). A manifest may override with a hand-written `vp` field —
 * that always wins.
 */
const fs = require('fs');
const path = require('path');

const { BLOCKS_DIR } = require('./blocksDir.cjs');

function composeBrief(m) {
  if (m.vp) return m.vp; // hand-written override wins
  const bits = [];
  bits.push(`${m.label || m.id}: ${m.description || 'No description.'}`);
  const perms = m.contract?.permissions || {};
  const ops = [];
  if (m.api_routes || m.provides?.api) ops.push('serves API routes');
  if (perms.shell) ops.push('can run shell');
  if (perms.ai) ops.push('calls AI models');
  if (perms.network === 'external') ops.push('reaches the internet');
  if (ops.length) bits.push(`Operates: ${ops.join(', ')}.`);
  const apis = m.requires?.apis || [];
  if (apis.length) bits.push(`Calls: ${apis.join(', ')}.`);
  const storage = m.contract?.storage || m.storage;
  if (storage?.type || storage?.provider) bits.push(`Reads/writes: ${storage.type || storage.provider} storage (${storage.scope || 'block'} scope).`);
  return bits.join(' ');
}

function getBlockBriefs() {
  const briefs = [];
  let folders = [];
  try {
    folders = fs.readdirSync(BLOCKS_DIR).filter(f =>
      !f.startsWith('_') && fs.existsSync(path.join(BLOCKS_DIR, f, 'block.manifest.json')));
  } catch { return briefs; }

  for (const folder of folders) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(BLOCKS_DIR, folder, 'block.manifest.json'), 'utf8')); }
    catch { continue; }
    const commands = (m.contract?.commands || []).map(c => ({
      cmd: c.cmd, desc: c.desc || '', param: c.param || null, dangerous: !!c.dangerous,
    }));
    const agentTools = m.contract?.agent_tools || m.agent_tools || [];
    briefs.push({
      id: m.id || folder,
      label: m.label || folder,
      category: m.nav?.group || m.category || 'other',
      route: m.route || `/${folder}`,
      brief: composeBrief(m),
      commands,
      agentTools: agentTools.map(t => t.name || t),
    });
  }
  return briefs;
}

/** Formatted context block for the mission prompt. */
function formatForPrompt(briefs = getBlockBriefs()) {
  const lines = ['INSTALLED BLOCKS (live registry — these and ONLY these exist):'];
  for (const b of briefs) {
    lines.push(`• ${b.id} — ${b.brief}`);
    if (b.commands.length) {
      lines.push(`  commands: ${b.commands.map(c => `${c.cmd}${c.param ? ` <${c.param}>` : ''}${c.dangerous ? ' ⚠' : ''}`).join(' · ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = { getBlockBriefs, formatForPrompt, composeBrief };
