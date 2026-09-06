/**
 * Master — the block standard.
 *
 * Reference only. This page used to also drive the build airlock (Scaffold →
 * Check → Submit → Queue); those tabs were removed because Build and Queue
 * duplicated what the CLI and the approval queue already own, leaving three
 * surfaces describing one process. What a block author actually needs is the
 * contract, stated once — so that is all this renders.
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
import { Dna, FolderTree, Radio, LayoutGrid, RefreshCw } from 'lucide-react';

const ANATOMY = [
  ['block.manifest.json', 'Identity + contract. nav, permissions, commands, widget. Manifest is truth.'],
  ['index.jsx', 'The UI. Default-export one component. Use aurora primitives (Card, StatCard).'],
  ['api/<id>.cjs', 'Optional backend: module.exports = (deps) => router. Auto-mounted at /api/*.'],
  ['README.md', 'One paragraph: what it owns, what it reads, what it writes.'],
];

const RULES = [
  ['Folder is truth', 'The displayed name is derived from the folder name (my_block → "My Block"). The builder derives all three from one id, so they cannot drift.'],
  ['Never call what does not exist', 'Fetch only endpoints your own api/ provides or the kernel guarantees (/core, /api/ai, /blocks/registry).'],
  ['Declare a widget', 'Expose GET /api/<id>/widget + a manifest widget section, and the dashboard shows your quick-view automatically.'],
  ['Ask for nothing extra', 'Permissions start at the floor and the sandbox strips deps you did not declare. Every widening below is a deliberate choice.'],
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
          Everything an AI system needs to build a production-ready AEON block from scratch.
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

// The whole contract, as one pasteable brief. Kept as a single template literal
// so "Copy prompt" hands over exactly what is rendered — no assembly, nothing
// that can drift between what the operator reads and what they paste.
const PROMPT_TEMPLATE = `You are building a self-contained AEON block. Follow every rule below exactly.

## What I want
[DESCRIBE YOUR BLOCK HERE — one sentence: what it does, what data it owns]

## Block identity
- id: my_block          <- snake_case, unique across src/blocks/
- label: My Block       <- title-case display name (derived from id if omitted)
- category: tools       <- one of: tools | agents | data | system

## Files to create
Create these inside src/blocks/my_block/:

### 1. block.manifest.json  (REQUIRED — the manifest is truth)
{
  "id": "my_block",
  "label": "My Block",
  "description": "One sentence: what this block owns.",
  "version": "1.0.0",
  "category": "tools",
  "nav": { "icon": "Puzzle", "order": 99 },
  "permissions": { "network": "internal" },
  "widget": { "height": 2, "description": "One-line summary for the dashboard tile." },
  "commands": []
}

Permission options:
- "network": "internal" (default, localhost only) | "external" (public internet)
- "ai": true            (lets this block call the kernel LLM via /api/ai)
- "secrets": true       (lets this block read Vault credentials)
- "storage": "read" | "write" | "readwrite"

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

### 3. api/my_block.cjs  (optional — backend routes)
const express = require('express');

module.exports = (deps) => {
  // deps = { VAULT_ROOT, DATA_ROOT, endpoints, vault, storage }
  // NEVER hardcode paths. Use deps.DATA_ROOT for block data.
  const router = express.Router();
  router.get('/status', (req, res) => res.json({ ok: true }));
  // Widget endpoint — the dashboard calls this for the tile
  router.get('/widget', (req, res) => res.json({ summary: 'Everything is fine.' }));
  return router;
};

### 4. README.md  (REQUIRED)
One paragraph: what the block owns, what it reads, what it writes.

## Absolute rules — the kernel enforces all of these
1. NEVER hardcode localhost or a port. All fetch() calls use relative paths (/api/...).
2. NEVER put secrets in index.jsx or any browser-side file. Vault reads are server-only (api/*.cjs).
3. NEVER use VITE_ prefixed env vars for secrets.
4. The block id, folder name, manifest id and api filename MUST all match exactly.
5. api/*.cjs must export \`module.exports = (deps) => router\` — no named exports.
6. index.jsx must default-export exactly one React component.
7. Declare every permission you need in the manifest. The sandbox strips undeclared deps.
8. GET /api/<id>/widget MUST return JSON — the dashboard renders it.

## What NOT to do
- Do not edit server/server.js, server/block-loader.js, or src/kernel/*.
- Do not create routes outside your api/ file.
- Do not import from other blocks' source folders.
- Do not write to VAULT_ROOT directly — use deps.storage if you need persistence.

## When you are done
Drop the whole src/blocks/my_block/ folder into the AEON project and restart the
server. The kernel discovers it from the manifest and mounts it. Nothing else changes.`;

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
      {/* ── AI Prompt ──────────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 4 }}>AI block-builder prompt</h3>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>
              Copy this into any AI coding assistant — Claude, Cursor, Copilot — and fill in what you want the block to do.
              The AI will generate all required files following AEON's cartridge contract.
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

      {/* ── Anatomy ────────────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>Anatomy of a block</h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ANATOMY.map(([file, what]) => (
            <li key={file} style={{ display: 'flex', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
              {CODE(file)}
              <span style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>{what}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── Four rules ─────────────────────────────────────────────────── */}
      <Card>
        <h3 style={{ marginTop: 0 }}>The four rules</h3>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {RULES.map(([rule, why]) => (
            <li key={rule} style={{ margin: '9px 0' }}>
              <strong style={{ fontSize: 13 }}>{rule}</strong>
              <span style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}> — {why}</span>
            </li>
          ))}
        </ol>
        <p style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)', marginTop: 14 }}>
          The manifest schema the kernel enforces is {CODE('src/kernel/schema.json')}, applied by
          {CODE(' validateManifest()')} in {CODE('src/kernel/staging.cjs')}. It is the only one.
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
