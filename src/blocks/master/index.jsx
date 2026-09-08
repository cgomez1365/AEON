/**
 * Master — the block standard.
 *
 * Reference only. This page used to also drive the build airlock (Scaffold →
 * Check → Submit → Queue); those tabs were removed because Build and Queue
 * duplicated what the CLI and the approval queue already own, leaving three
 * surfaces describing one process. What a block author actually needs is the
 * contract, stated once — so that is all this renders.
 *
 * 2026-09-07 — expanded to leave nothing out. A block scaffolded on a Windows
 * clone from a stale template never appeared, and the post-mortem could only
 * guess why: this page did not say that discovery is a build-time glob, that
 * the kernel overwrites manifest.nav, or where an icon file goes. Every path
 * an author needs is now on this page, and tests/master-block-guide.test.js
 * checks each one exists in the tree.
 *
 * The centrepiece is a copyable prompt: paste it into any AI coding assistant,
 * say what the block should do, and get back the four files the kernel
 * requires. Everything below it is the same contract in reference form.
 *
 * Accessibility patterns demonstrated here (copy these, not just the JSX):
 *   - Every fetch() call is relative ('/blocks/registry', never a hardcoded
 *     host:port) — Vite proxies /blocks, /core, /api, etc. to the kernel in
 *     dev, and same-origin already works in every deployed target. Any
 *     "which host am I on" display text reads window.location, never a
 *     literal string — a literal 'localhost:3001' is a lie on Vercel/Docker.
 *   - Icons placed next to visible text get aria-hidden="true": the icon is
 *     decorative, the adjacent text is already the accessible name.
 *   - Section labels use real <h3> elements so screen reader users can jump
 *     between sections with heading navigation.
 *   - Repeated item groups render as <ul role="list">/<li> — role="list" is
 *     required because list-style: none strips list semantics in
 *     Safari/VoiceOver otherwise.
 *   - Async-loaded values sit in an aria-live="polite" region.
 *   - Icon-only controls get aria-label and keep the browser's default focus
 *     ring (no `outline: none` — WCAG 2.4.7).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Card, StatCard } from '../../components/aurora';
import { Dna, Radio, LayoutGrid, RefreshCw } from 'lucide-react';

// ── Where everything lives ───────────────────────────────────────────────
// Paths are relative to the AEON repo root. <id> is your block's folder name.
const PATHS = [
  ['src/blocks/<id>/', 'Your block. Four files: block.manifest.json, index.jsx, api/*.cjs (optional), README.md.'],
  ['src/blocks/_template/', 'The working empty block. Copy it — or let `npm run aeon new <id>` copy it into staging/ for you. Folders starting with `_` never register.'],
  ['staging/<id>/', 'Where `aeon new` puts a block. `aeon lint <id>` checks it; `aeon promote <id>` moves it into src/blocks/ through the lint airlock.'],
  ['public/brand/block-icons/<id>.svg', 'Your sidebar icon. Drop the file here and the sidebar picks it up — nothing to declare.'],
  ['public/brand/block-icons/png/<id>.png', 'PNG fallback for the same icon (dashboard tiles, exports).'],
  ['public/brand/block-icons/sections/', 'Section icons (finance, agent, work, content, tools, system). Add one per custom section.'],
  ['src/kernel/blockStandard.cjs', 'The NAV map: route, group, order, icon per known block. Overwrites manifest.nav on every boot. Unlisted blocks land in SYSTEM at order 99.'],
  ['src/kernel/blockRegistry.js', 'Browser-side discovery. import.meta.glob over src/blocks/*/index.jsx — resolved at BUILD time.'],
  ['server/block-loader.js', 'Server-side mounting. Reads your manifest, scopes deps by contract.permissions, mounts api/*.cjs under /api.'],
  ['src/kernel/schema.json', 'The manifest schema. Required: id, label, route, version.'],
  ['src/kernel/staging.cjs', 'validateManifest() and the lint rules `npm run aeon lint` runs.'],
  ['tools/aeon-cli.cjs', 'The CLI: aeon new | lint | dev | promote | pack.'],
  ['src/blocks/<id>/.aeon.runtime.json', 'Written by the kernel at boot (api base, runtime, models). Never edit; never commit.'],
  ['docs/BLOCKS.md', 'Generated registry of every installed block (`npm run prep:docs`). Read it; do not edit it.'],
];

// ── Make it appear ───────────────────────────────────────────────────────
const STEPS = [
  ['npm run aeon new <id>', 'Copies src/blocks/_template into staging/<id> and personalises id, route and label.'],
  ['Edit the four files', 'Manifest first. index.jsx default-exports one React component. api/<id>.cjs exports `(deps) => router`.'],
  ['npm run aeon lint <id>', 'Schema, id = folder, route starts with /, v1.1 storage and memory rules, circular imports. Fix until clean.'],
  ['npm run aeon promote <id>', 'staging/<id> → src/blocks/<id>. Refuses on any lint error.'],
  ['npm run build  (or npm run dev)', 'THE STEP EVERYONE MISSES. The browser discovers blocks through a build-time glob; a running production build cannot see a new folder until it is rebuilt. No error is logged — the block is simply absent.'],
  ['Restart the server', 'The kernel syncs your manifest (writes nav + .aeon.runtime.json), mounts api/, and lists you at /blocks/registry.'],
];

// ── Icons ────────────────────────────────────────────────────────────────
const ICON_WAYS = [
  ['Drop a file', 'public/brand/block-icons/<id>.svg and public/brand/block-icons/png/<id>.png. The sidebar and the Home dashboard look there by default. Square, single colour, no background.'],
  ['Pick one on Home', 'Home dashboard → your block\'s tile → icon. The picker offers every file already in public/brand/block-icons/. It writes nav.iconAsset for you.'],
  ['Name a Lucide icon', 'nav.icon: "Telescope" (any lucide-react name) or an emoji. Used wherever the file is missing. Default is "Boxes".'],
  ['Opt out', 'contract.customizable.icon: false — the block keeps its own icon and the picker leaves it alone.'],
];

// ── Nav and groups ───────────────────────────────────────────────────────
const GROUPS = ['finance (Home)', 'agent', 'work', 'content', 'tools', 'system'];

const ANATOMY = [
  ['block.manifest.json', 'Identity + contract. nav, permissions, storage, memory, commands, widget. Manifest is truth; the kernel rewrites nav on boot.'],
  ['index.jsx', 'The UI. Default-export one React component. Use aurora primitives (Card, StatCard). Relative fetch() only.'],
  ['api/<id>.cjs', 'Optional backend: module.exports = (deps) => router. Mounted under /api/. deps carries only what contract.permissions declares.'],
  ['README.md', 'One paragraph: what it owns, what it reads, what it writes.'],
];

const RULES = [
  ['Folder is truth', 'The displayed name derives from the folder name (my_block → "My Block"); manifest labels are ignored and a mismatch is logged. id must equal the folder.'],
  ['Never call what does not exist', 'Fetch only endpoints your own api/ provides or the kernel guarantees (/core, /api/ai, /blocks/registry).'],
  ['Declare a widget', 'Expose GET /api/<id>/widget + a manifest widget section, and the dashboard shows your quick-view automatically.'],
  ['Ask for nothing extra', 'Permissions start at the floor and the sandbox strips deps you did not declare. Every widening is a deliberate choice in contract.permissions.'],
  ['Never compute a storage path', 'Declare "filesystem": "write" and use the injected deps.blockStorage (writeData / publishState / writeMemoryDocument). It is scoped to your block; a hand-built path escapes the namespace and is refused. "none" means no storage at all.'],
  ['A command that needs something says so', 'contract.commands entries take `when`: "supabase", "runtime == local", "!ready". The terminal refuses with the reason instead of running a no-op.'],
];

export default function Master() {
  const [registry, setRegistry] = useState(null);
  const [kernel, setKernel] = useState('checking');

  const loadRegistry = useCallback(() => {
    fetch('/blocks/registry')
      .then((r) => r.json())
      .then((d) => { setRegistry(Array.isArray(d) ? d : d.blocks || []); setKernel('online'); })
      .catch((e) => { setKernel(`unreachable — ${e.message}`); });
  }, []);

  useEffect(() => { loadRegistry(); }, [loadRegistry]);

  return (
    <div className="block-root">
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Dna size={22} aria-hidden="true" /> Master
          <span style={{ fontSize: 10, letterSpacing: '.18em', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--line, #272d39)', color: 'var(--dim, #9aa3b2)' }}>
            THE BLOCK STANDARD
          </span>
        </h2>
        <p style={{ color: 'var(--dim, #9aa3b2)', fontSize: 13, marginTop: 6 }}>
          Everything a person or an AI needs to build an AEON block and see it appear — every path, every step, nothing left to guess.
        </p>
      </header>

      <div aria-live="polite" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 18 }}>
        <StatCard icon={<LayoutGrid size={14} aria-hidden="true" />} label="Installed blocks"
          value={registry ? registry.length : '—'} sub="live from /blocks/registry" />
        <StatCard icon={<Radio size={14} aria-hidden="true" />} label="Kernel"
          value={kernel === 'online' ? 'ONLINE' : 'CHECK'}
          sub={kernel === 'online' ? window.location.host : kernel} />
      </div>

      <ReferencePanel registry={registry} onRefresh={loadRegistry} />
    </div>
  );
}

const CODE = (t) => (
  <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 3, fontSize: 12 }}>{t}</code>
);
const DIM = { fontSize: 12.5, color: 'var(--dim, #9aa3b2)' };

// The whole contract, as one pasteable brief. Kept as a single template literal
// so "Copy prompt" hands over exactly what is rendered — no assembly, nothing
// that can drift between what the operator reads and what they paste.
// The manifest below mirrors src/blocks/_template/block.manifest.json; a test
// checks the manifestVersion matches.
const PROMPT_TEMPLATE = `You are building a self-contained AEON block. Follow every rule below exactly.

## What I want
[DESCRIBE YOUR BLOCK HERE — one sentence: what it does, what data it owns]

## Block identity
- id: my_block          <- snake_case, unique across src/blocks/, MUST equal the folder name
- label is derived from the folder name (my_block → "My Block"); do not invent one

## Where things live (paths from the AEON repo root)
- src/blocks/my_block/                       the block: manifest, index.jsx, api/, README.md
- src/blocks/_template/                      the working empty block to copy (never registers itself)
- public/brand/block-icons/my_block.svg      the sidebar icon — drop the file, nothing to declare
- public/brand/block-icons/png/my_block.png  PNG fallback of the same icon
- src/kernel/schema.json                     the manifest schema (required: id, label, route, version)

## Files to create
Create these inside src/blocks/my_block/:

### 1. block.manifest.json  (REQUIRED — the manifest is truth)
{
  "manifestVersion": "1.1.0",
  "id": "my_block",
  "label": "My Block",
  "icon": "Puzzle",
  "route": "/my_block",
  "description": "One sentence: what this block owns.",
  "category": "tools",
  "tier": "experimental",
  "nav": { "group": "tools", "order": 99, "label": "My Block", "icon": "Puzzle", "hidden": false },
  "requires": { "apis": [], "env": [], "local": [], "blocks": [] },
  "provides": { "routes": true, "api": true, "models": [] },
  "api_routes": true,
  "version": "0.1.0",
  "contract": {
    "inputs": [], "outputs": [], "events": [],
    "permissions": { "filesystem": "none", "network": "none", "secrets": false, "shell": false, "ai": false, "crossBlockRead": [] },
    "storage": { "type": "none", "scope": "block", "local": { "indexed": false, "retention": "operational" }, "access": "scoped" },
    "memory": { "mode": "none", "indexed": false, "userConfigurable": false },
    "ai": { "canGenerate": false, "canAnalyze": false, "canAutomate": false, "roles": [] },
    "commands": [],
    "settings_keys": []
  },
  "routes": [],
  "deployment": { "target": "desktop", "runtime": "local" }
}

Notes on the manifest:
- nav.group/order/icon are a REQUEST. The kernel's NAV map (src/kernel/blockStandard.cjs) overwrites
  manifest.nav on every boot; a block it does not list lands in the SYSTEM group at order 99. The
  operator can drag it to any section on the Home dashboard. Groups: finance, agent, work, content, tools, system.
- contract.permissions is the security declaration. The sandbox hands api/ ONLY what is declared:
  "filesystem": "none" | "read" | "write"    "network": "none" | "internal" | "external"
  "secrets": true (Vault credentials, server-side only)   "ai": true (kernel LLM via deps.kernelLLM / /api/ai)
  "shell": true is Tier 3 and needs approval. "crossBlockRead": ["other_id"] is a declared read.
- contract.storage.local.indexed must stay false; new blocks use "access": "scoped".
- contract.memory.mode: "none" | "summary" | "document". Enabled memory is written to the Vault and
  indexed by the Aeon Matrix; memory.indexed must equal (mode !== "none").
- contract.commands: slash-commands for the terminal — { cmd, desc, route, method, param, when }.
  "when": "supabase" makes the terminal refuse with a reason when there is no cloud link.
- routes: leave []. npm run build fills it from your code.

### 2. index.jsx  (REQUIRED — the UI)
import React, { useState, useEffect } from 'react';
import { Card, StatCard } from '../../components/aurora';

export default function MyBlock() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/my_block/status').then(r => r.json()).then(setData).catch(console.error);
  }, []);
  return (
    <div className="block-root">
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>My Block</h2>
        <p style={{ color: 'var(--dim, #9aa3b2)', fontSize: 13, marginTop: 6 }}>
          What this block does, in plain language for any user.
        </p>
      </header>
      <Card><p>{data ? JSON.stringify(data) : 'Loading...'}</p></Card>
    </div>
  );
}

### 3. api/my_block.cjs  (optional — backend routes; set "api_routes": true)
const express = require('express');

module.exports = (deps) => {
  // deps carries only what contract.permissions declares:
  //   "filesystem": "read" | "write"  → deps.blockStorage (scoped files; "none" gets no storage at all)
  //   "ai": true                     → deps.kernelLLM(prompt, { role })
  //   "secrets": true                → provider key pools
  // NEVER compute a path yourself — deps.blockStorage.writeData('state.json', obj).
  const router = express.Router();
  router.get('/status', (req, res) => res.json({ ok: true }));
  // Widget endpoint — the dashboard calls this for the tile
  router.get('/widget', (req, res) => res.json({ summary: 'Everything is fine.' }));
  return router;
};

### 4. README.md  (REQUIRED)
One paragraph: what the block owns, what it reads, what it writes.

### 5. The icon (recommended)
public/brand/block-icons/my_block.svg — square, single colour, no background.
public/brand/block-icons/png/my_block.png — the same, as PNG.
If neither exists, nav.icon (a lucide-react name or an emoji) is used.

## Absolute rules — the kernel enforces all of these
1. NEVER hardcode localhost or a port. All fetch() calls use relative paths (/api/...).
2. NEVER put secrets in index.jsx or any browser-side file. Vault reads are server-only (api/*.cjs).
3. NEVER use VITE_ prefixed env vars for secrets.
4. The block id, folder name, manifest id and api filename MUST all match exactly. Lowercase [a-z0-9_].
5. api/*.cjs must export \`module.exports = (deps) => router\` — no named exports.
6. index.jsx must default-export exactly one React component.
7. Declare every permission you need in contract.permissions. The sandbox strips undeclared deps.
8. GET /api/<id>/widget MUST return JSON — the dashboard renders it.
9. A folder starting with _ never registers. Do not name your block that way.

## What NOT to do
- Do not edit server/server.js, server/block-loader.js, or src/kernel/*.
- Do not create routes outside your api/ file.
- Do not import from other blocks' source folders.
- Do not write to VAULT_ROOT or DATA_ROOT directly — use deps.blockStorage.
- Do not edit or commit src/blocks/my_block/.aeon.runtime.json — the kernel writes it at boot.

## Make it appear — in this order
1. npm run aeon new my_block        (or copy src/blocks/_template to staging/my_block by hand)
2. edit the files above
3. npm run aeon lint my_block       fix until clean
4. npm run aeon promote my_block    staging/ → src/blocks/
5. npm run build   (or run npm run dev)
   The browser finds blocks through a BUILD-TIME glob (src/kernel/blockRegistry.js, import.meta.glob).
   A running production build cannot see a new folder until it is rebuilt. Nothing is logged — the
   block is just absent. This is the step most people miss.
6. restart the server — it syncs your manifest, mounts api/, and lists you at /blocks/registry.`;

// ── The builder persona ──────────────────────────────────────────────────
// A looped agent, as one Markdown file: paste it into any AI that can run
// commands in the repo, give it one sentence, and it scaffolds, lints,
// promotes, builds, mounts, verifies and reports — or says where it stopped.
function AgentCard() {
  const [md, setMd] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch('/api/master/agent.md')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then(setMd)
      .catch((e) => setErr(`Persona not served (${e.message}) — the file is src/blocks/master/AEON_BLOCK_BUILDER.md.`));
  }, []);
  const copy = () => {
    if (!md) return;
    navigator.clipboard.writeText(md).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  const phases = md ? (md.match(/^### Phase [A-I] — .+$/gm) || []).map((l) => l.replace(/^### /, '')) : [];
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <h3 style={{ marginTop: 0, marginBottom: 4 }}>Block Builder agent — a persona that runs the whole loop</h3>
          <p style={{ margin: 0, ...DIM }}>
            Paste this Markdown as the system prompt of any AI that can run commands in your AEON checkout — Claude Code, Cursor, Copilot Workspace, Aider.
            Give it one sentence. It scaffolds, lints, promotes, builds, mounts, verifies and reports — and says exactly where it stopped if it could not finish.
          </p>
        </div>
        <button onClick={copy} disabled={!md} aria-label="Copy the Block Builder agent persona"
          style={{ flexShrink: 0, background: copied ? 'var(--ok, #3fb950)' : 'var(--pu, #a78bfa)', color: '#fff', border: 'none', borderRadius: 5, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: md ? 'pointer' : 'default', opacity: md ? 1 : 0.5, whiteSpace: 'nowrap' }}>
          {copied ? '✓ Copied' : 'Copy agent'}
        </button>
      </div>
      {err && <p role="alert" style={{ color: 'var(--danger, #ff4455)', fontSize: 12.5, margin: '6px 0' }}>{err}</p>}
      {phases.length > 0 && (
        <ol style={{ paddingLeft: 20, margin: '6px 0 10px', columns: 2, columnGap: 24 }}>
          {phases.map((p) => <li key={p} style={{ fontSize: 12.5, margin: '3px 0', breakInside: 'avoid' }}>{p.replace(/^Phase [A-I] — /, '')}</li>)}
        </ol>
      )}
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ background: 'none', border: '1px solid var(--line, #272d39)', color: 'var(--dim, #9aa3b2)', borderRadius: 4, padding: '4px 10px', fontSize: 11.5, cursor: 'pointer' }}>
        {open ? 'Hide the file' : 'Read the file'} · {CODE('src/blocks/master/AEON_BLOCK_BUILDER.md')}
      </button>
      {open && md && (
        <pre style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: 14, margin: '10px 0 0', fontSize: 11.5, lineHeight: 1.65, color: 'var(--text, #e6edf3)', overflowX: 'auto', maxHeight: 420, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{md}</pre>
      )}
    </Card>
  );
}

function ReferencePanel({ registry, onRefresh }) {
  const [copied, setCopied] = useState(false);

  const copyPrompt = () => {
    navigator.clipboard.writeText(PROMPT_TEMPLATE).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <AgentCard />

      {/* ── AI Prompt ──────────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>AI block-builder prompt</h3>
            <p style={{ margin: 0, ...DIM }}>
              Copy this into any AI coding assistant — Claude, Cursor, Copilot — and fill in what you want the block to do.
              It carries the live manifest shape, every path, and the build step.
            </p>
          </div>
          <button
            onClick={copyPrompt}
            style={{
              flexShrink: 0, background: copied ? 'var(--ok, #3fb950)' : 'var(--pu, #a78bfa)',
              color: '#fff', border: 'none', borderRadius: 5, padding: '7px 14px',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {copied ? '✓ Copied' : 'Copy prompt'}
          </button>
        </div>
        <pre style={{
          background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: 14, margin: 0,
          fontSize: 11.5, lineHeight: 1.65, color: 'var(--text, #e6edf3)',
          overflowX: 'auto', maxHeight: 340, overflowY: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{PROMPT_TEMPLATE}</pre>
      </Card>

      {/* ── Make it appear ─────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Make it appear — six steps, in order</h3>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {STEPS.map(([step, why]) => (
            <li key={step} style={{ margin: '9px 0' }}>
              {CODE(step)}
              <span style={{ display: 'block', marginTop: 3, ...DIM }}>{why}</span>
            </li>
          ))}
        </ol>
      </Card>

      {/* ── Where everything lives ─────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Where everything lives</h3>
        <p style={{ marginTop: 0, ...DIM }}>Paths from the AEON repo root. {CODE('<id>')} is your block's folder name.</p>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {PATHS.map(([p, what]) => (
            <li key={p} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
              {CODE(p)}
              <span style={DIM}>{what}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── Icons ──────────────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Icons — four ways, in order of preference</h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ICON_WAYS.map(([how, what]) => (
            <li key={how} style={{ padding: '8px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
              <strong style={{ fontSize: 13 }}>{how}</strong>
              <span style={{ display: 'block', marginTop: 2, ...DIM }}>{what}</span>
            </li>
          ))}
        </ul>
        <p style={{ marginTop: 12, marginBottom: 0, ...DIM }}>
          The library the picker reads is the folder itself: {CODE('public/brand/block-icons/')}. Section icons live in {CODE('public/brand/block-icons/sections/')}.
        </p>
      </Card>

      {/* ── Nav and groups ─────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Nav and groups — the kernel owns the sidebar</h3>
        <p style={{ marginTop: 0, ...DIM }}>
          {CODE('manifest.nav')} is a request. On every boot {CODE('src/kernel/blockStandard.cjs')} overwrites it from its NAV map
          (route, group, order, icon). A block the map does not list still loads — in the SYSTEM group at order 99 — and the
          operator can drag it to any section, or a new one, on the Home dashboard. {CODE('nav.hidden: true')} keeps it out of nav.
        </p>
        <p style={{ marginBottom: 0, ...DIM }}>Groups: {GROUPS.map((g, i) => <React.Fragment key={g}>{i > 0 && ' · '}{CODE(g)}</React.Fragment>)}</p>
      </Card>

      {/* ── Anatomy ────────────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Anatomy of a block</h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ANATOMY.map(([file, what]) => (
            <li key={file} style={{ display: 'flex', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
              {CODE(file)}
              <span style={DIM}>{what}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── Rules ──────────────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>The rules</h3>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {RULES.map(([rule, why]) => (
            <li key={rule} style={{ margin: '9px 0' }}>
              <strong style={{ fontSize: 13 }}>{rule}</strong>
              <span style={DIM}> — {why}</span>
            </li>
          ))}
        </ol>
        <p style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)', marginTop: 14 }}>
          The manifest schema the kernel enforces is {CODE('src/kernel/schema.json')}, applied by
          {CODE(' validateManifest()')} in {CODE('src/kernel/staging.cjs')}. It is the only one. Server-side mounting is
          {CODE(' server/block-loader.js')}; browser-side discovery is {CODE('src/kernel/blockRegistry.js')}; the CLI is
          {CODE(' tools/aeon-cli.cjs')}; the generated registry of what is installed is {CODE('docs/BLOCKS.md')}.
        </p>
      </Card>

      {/* ── Installed blocks ───────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
          Installed blocks
          <button onClick={onRefresh} aria-label="Refresh block registry"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dim, #9aa3b2)', padding: 3 }}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 8 }}>
          {(registry || []).map((b) => (
            <li key={b.id} style={{ border: '1px solid var(--line, #272d39)', borderRadius: 6, padding: '9px 11px', fontSize: 12.5 }}>
              {b.label || b.id}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--dim, #9aa3b2)' }}>{b.route}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
