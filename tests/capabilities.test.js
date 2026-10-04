/**
 * Capabilities — the gate that stops a toggle claiming what no code enforces.
 *
 * Settings shipped thirteen toggles that nothing read. Eight claimed to govern
 * what the agent may do; "Shell commands: off" restricted nothing. A cosmetic
 * dead setting is untidy, but a dead SECURITY setting is a lie the operator
 * cannot detect — they believe they restricted something and act on it.
 *
 * The rule this file enforces: `implemented: true` means a real caller passes
 * that key to enabled(). Flipping the flag without writing the enforcement
 * re-creates the original defect exactly, and would otherwise be invisible —
 * so it is checked mechanically rather than trusted to review.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caps = require_(path.join(ROOT, 'src', 'kernel', 'capabilities.cjs'));

/** Every .cjs/.js/.jsx under src/ and services/, excluding the module itself. */
function sourceFiles() {
  const out = [];
  const skip = new Set(['node_modules', 'dist', '.git', 'data']);
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(cjs|js|jsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'services'));
  return out.filter(f => !f.endsWith(path.join('kernel', 'capabilities.cjs')));
}

const FILES = sourceFiles().map(f => ({ path: f, code: fs.readFileSync(f, 'utf8') }));

describe('capabilities — a live toggle has a real consumer', () => {
  it('every implemented capability is actually consulted somewhere', () => {
    const unenforced = [];
    for (const [key, spec] of Object.entries(caps.CAPABILITIES)) {
      if (!spec.implemented) continue;
      // A real caller passes the key to enabled(). Quoted either way.
      const re = new RegExp(`enabled\\(\\s*['"\`]${key}['"\`]\\s*\\)`);
      if (!FILES.some(f => re.test(f.code))) unenforced.push(key);
    }
    expect(
      unenforced,
      `Marked implemented but nothing calls enabled() for: ${unenforced.join(', ')}. `
      + 'Either write the enforcement or set implemented: false — a toggle that '
      + 'governs nothing must not present itself as live.'
    ).toEqual([]);
  });

  it('every capability declares what it does, in plain language', () => {
    for (const [key, spec] of Object.entries(caps.CAPABILITIES)) {
      expect(spec.summary, `${key} has no summary`).toBeTruthy();
      expect(typeof spec.default, `${key} has no default`).toBe('boolean');
      expect(typeof spec.implemented, `${key} has no implemented flag`).toBe('boolean');
    }
  });

  it('every UNIMPLEMENTED capability explains why it is inactive', () => {
    // This string is shown to the operator verbatim. Without it the toggle
    // renders greyed out with no reason, which is its own small mystery.
    const missing = Object.entries(caps.CAPABILITIES)
      .filter(([, s]) => !s.implemented && !s.pending)
      .map(([k]) => k);
    expect(missing, `Unimplemented with no explanation: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('capabilities — enabled() behaviour', () => {
  it('an unimplemented capability answers with its default, never the stored pref', () => {
    // If a consumer appears before the enforcement does, it must not start
    // honouring a toggle that Settings is simultaneously calling inactive.
    // The two surfaces agree, or the flag is wrong.
    for (const [key, spec] of Object.entries(caps.CAPABILITIES)) {
      if (spec.implemented) continue;
      expect(caps.enabled(key), `${key} should answer with its declared default`).toBe(spec.default);
    }
  });

  it('an unknown capability fails closed rather than reading as "off" forever', () => {
    expect(caps.enabled('tool_does_not_exist')).toBe(false);
  });

  it('describe() gives Settings everything it needs to render honestly', () => {
    const rows = caps.describe();
    expect(rows.length).toBe(Object.keys(caps.CAPABILITIES).length);
    for (const r of rows) {
      expect(r.key).toBeTruthy();
      expect(r.summary).toBeTruthy();
      expect(typeof r.implemented).toBe('boolean');
      expect(typeof r.value).toBe('boolean');
      if (!r.implemented) expect(r.pending).toBeTruthy();
    }
  });
});

describe('capabilities — the Settings panel cannot hardcode them back', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');

  it('the agent and system toggles render from the registry, not a literal list', () => {
    // The original defect was a hardcoded <PrefToggle prefKey="tool_shell">
    // with an invented description and default, disconnected from whether any
    // code consulted it. These keys must reach the panel through the registry.
    for (const key of Object.keys(caps.CAPABILITIES)) {
      const hardcoded = new RegExp(`prefKey=["']${key}["']`);
      expect(hardcoded.test(panel), `${key} is hardcoded as a PrefToggle prefKey — use <CapabilityToggle capKey="${key}"> so its live/inert state comes from the kernel`).toBe(false);
    }
  });
});

// 3.3.0: agents use tools in chat (src/kernel/agentTools.cjs), switched in
// Settings → Blocks → Memory Core. The Agent tab's inert toggles that sound
// like those tools once said the agent "cannot write to memory at all today"
// and that no agent tool reads files — false the moment 3.3.0 shipped, and
// shown to the operator who opened that tab to see what agents may do.
describe('capabilities — the Agent tab does not deny what agents do in chat', () => {
  const { TOOL_NAMES } = require_(path.join(ROOT, 'src', 'kernel', 'toolProtocol.cjs'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'memory_core', 'block.manifest.json'), 'utf8'));
  const label = (key) => {
    const find = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (o.key === key && typeof o.label === 'string') return o.label;
      for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
      return null;
    };
    return find(manifest);
  };
  const COVERS = {
    tool_filesystem: { tools: ['vault_read', 'vault_list', 'artifact_save', 'scratchpad_write'], switch: 'agent_tools' },
    tool_web_search: { tools: ['web_search'], switch: 'agent_tools_web' },
    tool_memory: { tools: ['memory_save'], switch: 'agent_tools' },
  };

  it('each toggle a chat tool overlaps names the Memory Core switch that really governs it', () => {
    for (const [key, { tools, switch: sw }] of Object.entries(COVERS)) {
      if (!tools.some((t) => TOOL_NAMES.includes(t))) continue;
      const spec = caps.CAPABILITIES[key];
      const text = spec.implemented ? spec.summary : spec.pending;
      expect(label(sw), `memory_core manifest has no "${sw}" setting`).toBeTruthy();
      expect(text, `${key} does not point to Memory Core`).toContain(`Memory Core → "${label(sw)}"`);
      expect(text, `${key} says agents cannot do what ${tools.join('/')} do`).not.toMatch(/\byet\b|at all today|No agent tool/i);
    }
  });

  it('the shell toggle does not say the terminal runs commands', () => {
    expect(caps.CAPABILITIES.tool_shell.pending).not.toMatch(/prefix is what runs commands/i);
  });

  it('the Agent tab heading does not claim its toggles change the agent\'s toolset', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    expect(ui).not.toMatch(/Disabled tools won't appear in the agent's toolset/);
    expect(ui).toMatch(/agent-tools-desc">[^<]*Memory Core/);
  });
});
