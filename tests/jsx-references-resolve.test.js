/**
 * Every JSX component reference must resolve to something.
 *
 * On 2026-08-10 the Master rewrite used <Section> and <Finding> four times
 * each and defined neither. The page rendered fine — until the operator
 * pressed Check, which mounts CheckResult, which uses them. Then:
 * "Section is not defined".
 *
 * Nothing caught it. A bare identifier is resolved at RUNTIME, so the bundler
 * has nothing to complain about; `npm run build` was clean. And a render smoke
 * test would not have caught it either: CheckResult only mounts after a click,
 * so an initial-render pass never reaches it. The defect lives in a branch, and
 * the only cheap way to see a branch you did not execute is to read it.
 *
 * That is what this does — statically, across every block, in every code path
 * regardless of what triggers it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.jsx')) acc.push(full);
  }
  return acc;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Names React itself provides — never user-defined. */
const BUILTIN = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler']);

function analyse(src) {
  // Usages come from comment-stripped source, so a <Component> named in prose
  // is not reported. DEFINITIONS come from the RAW source on purpose: comment
  // stripping is a heuristic — a `//` line mentioning something block-comment
  // shaped can swallow the lines beneath it, which is exactly what happened to
  // DesktopLayout's imports when this gate was first written. Missing a real
  // import would be a false POSITIVE, and a gate that cries wolf gets skipped
  // (§19). Reading definitions raw biases the error toward a false negative,
  // which is the survivable direction.
  const code = stripComments(src);

  const used = new Set([...code.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)].map((m) => m[1]));

  const defined = new Set([
    // function Foo() / const Foo = / class Foo
    ...[...src.matchAll(/\bfunction\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bclass\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]),
    // import { A, B as C } / import D / import * as E
    ...[...src.matchAll(/import\s*\{([^}]*)\}/g)].flatMap((m) =>
      m[1].split(',').map((p) => p.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)),
    ...[...src.matchAll(/import\s+([A-Z][A-Za-z0-9_]*)\s*(?:,|from)/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s*\*\s*as\s+([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]),
    // Locally bound by destructuring or a map callback:
    //   const { icon: Icon } = props      ({ icon: Icon }) => …
    //   const [[id, label, Icon]] = …     .map(([a, b, Icon]) => …)
    ...[...src.matchAll(/[:{,[]\s*([A-Z][A-Za-z0-9_]*)\s*[,}\]=)]/g)].map((m) => m[1]),
  ]);

  return [...used].filter((u) => !defined.has(u) && !BUILTIN.has(u));
}

describe('no JSX element references an undefined component', () => {
  const files = walk(path.join(ROOT, 'src'));

  it('scans a meaningful number of files, so a broken walk cannot pass silently', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every <Component> in src/ resolves to an import or a definition', () => {
    const offenders = [];
    for (const file of files) {
      const missing = analyse(fs.readFileSync(file, 'utf8'));
      if (missing.length) offenders.push(`${path.relative(ROOT, file)} → ${missing.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('catches a deliberately undefined component', () => {
    // The gate must be able to fail. This is the exact shape of the Master bug.
    expect(analyse('export default function P(){ return <Section title="x">hi</Section>; }'))
      .toEqual(['Section']);
  });

  it('does not flag a component that IS defined below its use', () => {
    const src = 'export default function P(){ return <Row/>; }\nfunction Row(){ return null; }';
    expect(analyse(src)).toEqual([]);
  });

  it('does not flag an aliased or destructured binding', () => {
    expect(analyse("import { Card as Panel } from 'x';\nexport default ()=> <Panel/>;")).toEqual([]);
    expect(analyse('function S({ icon: Icon }){ return <Icon/>; }')).toEqual([]);
  });
});

/**
 * WHAT THIS DOES NOT COVER (§08):
 *
 * It resolves NAMES, not values. The other Master crash on the same day passed
 * a real, resolved component where an element was required — every name
 * resolved and React still died (#31). That class is covered separately by
 * tests/aurora-prop-contract.test.js.
 *
 * Neither is a substitute for rendering the page. A jsdom smoke render of each
 * block's default export remains open: several blocks touch window,
 * localStorage and fetch at module or render scope, so it needs a stub set
 * decided deliberately rather than bolted on here.
 */
