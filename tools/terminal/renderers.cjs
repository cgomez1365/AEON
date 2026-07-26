/**
 * AEON Terminal — typed output renderers (BO-TGM)
 *
 * Results arrive as JSON envelopes; these turn them into something a person
 * reads at a glance. Each renderer is total: it must never throw on a shape it
 * did not expect, because a rendering crash would destroy a result the kernel
 * already computed successfully. Unknown shapes fall through to `auto`.
 *
 *   grade-card       ATS resume grading
 *   search-results   Matrix recall hits (numbered, selectable)
 *   table            list output
 *   markdown         documents and reports
 *   progress         long-running jobs
 *   raw-json         --json, machine-readable
 */
'use strict';

const { c } = require('./client.cjs');

// ── box drawing ─────────────────────────────────────────────────────────────
// Width is measured on the ANSI-stripped string; escape codes occupy no
// columns, and padding to the raw length would visibly skew every box.
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => strip(s).length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

function box(lines, { title = null, color = c.neon, padding = 1 } = {}) {
  const flat = lines.map((l) => (l === null ? null : String(l)));
  const inner = Math.max(
    ...flat.filter((l) => l !== null).map(width),
    title ? width(title) + 2 : 0,
    24,
  ) + padding * 2;
  const sp = ' '.repeat(padding);
  const out = [];
  out.push(color(`┌${title ? `─ ${title} ` + '─'.repeat(Math.max(0, inner - width(title) - 3)) : '─'.repeat(inner)}┐`));
  for (const line of flat) {
    if (line === null) out.push(color(`├${'─'.repeat(inner)}┤`));
    else out.push(color('│') + sp + pad(line, inner - padding * 2) + sp + color('│'));
  }
  out.push(color(`└${'─'.repeat(inner)}┘`));
  return out.join('\n');
}

function bar(value, max = 100, len = 20) {
  const pct = Math.max(0, Math.min(1, (Number(value) || 0) / max));
  const filled = Math.round(pct * len);
  const color = pct >= 0.8 ? c.green : pct >= 0.6 ? c.yellow : c.red;
  return color('█'.repeat(filled)) + c.dim('░'.repeat(len - filled));
}

// ── grade card ──────────────────────────────────────────────────────────────
function gradeCard(data) {
  const d = data?.data || data || {};
  const grade = d.grade ?? d.letter ?? '—';
  const score = d.score ?? d.total ?? d.overall ?? null;
  const verdict = d.recommendation ?? d.verdict ?? d.decision ?? null;
  const summary = d.summary ?? d.rationale ?? d.explanation ?? null;

  const lines = [];
  const head = `${c.bold('Grade:')} ${c.neon(c.bold(grade))}`
    + (score !== null ? `   ${c.bold('Score:')} ${c.bold(String(score))}${c.dim('/100')}` : '');
  lines.push(head);

  // Sub-scores live under a few different keys depending on which grader ran.
  const breakdown = d.breakdown || d.scores || d.dimensions || d.criteria;
  if (breakdown && typeof breakdown === 'object') {
    lines.push(null);
    const entries = Array.isArray(breakdown)
      ? breakdown.map((b) => [b.name || b.label || b.key, b.score ?? b.value])
      : Object.entries(breakdown);
    const labelWidth = Math.max(...entries.map(([k]) => String(k).length), 0);
    for (const [k, v] of entries) {
      const n = typeof v === 'object' ? (v.score ?? v.value) : v;
      if (n === undefined || n === null) continue;
      const label = String(k).replace(/[_-]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
      lines.push(`${c.dim(label.padEnd(labelWidth + 2))} ${bar(n)} ${String(n).padStart(3)}`);
    }
  }

  if (verdict) {
    lines.push(null);
    const v = String(verdict).toUpperCase();
    const tone = /RECOMMEND|STRONG|YES|PASS/.test(v) ? c.green
      : /REJECT|NO|FAIL|WEAK/.test(v) ? c.red : c.yellow;
    lines.push(tone(c.bold(v)));
  }
  if (summary) {
    if (!verdict) lines.push(null);
    for (const l of wrapText(String(summary), 52)) lines.push(c.dim(l));
  }

  const gaps = d.gaps || d.weaknesses || d.missing;
  if (Array.isArray(gaps) && gaps.length) {
    lines.push(null);
    lines.push(c.yellow(c.bold('Gaps')));
    for (const g of gaps.slice(0, 5)) {
      for (const [i, l] of wrapText(String(g), 50).entries()) lines.push(c.dim(i === 0 ? `• ${l}` : `  ${l}`));
    }
  }
  return box(lines, { title: 'RESUME GRADE' });
}

function wrapText(text, max) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > max) { if (line) out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

// ── search results ──────────────────────────────────────────────────────────
function searchResults(data, { query = null } = {}) {
  const d = data?.data || data || {};
  const list = d.results || d.hits || d.matches || d.documents || (Array.isArray(d) ? d : []);
  if (!Array.isArray(list) || !list.length) {
    return `  ${c.dim('no results')}${query ? c.dim(` for "${query}"`) : ''}`;
  }
  const out = [`\n  ${c.bold(String(list.length))} result${list.length === 1 ? '' : 's'}${query ? c.dim(` for "${query}"`) : ''}\n`];
  list.slice(0, 20).forEach((hit, i) => {
    const title = hit.title || hit.name || hit.file || hit.path || hit.id || `result ${i + 1}`;
    const when = hit.date || hit.modified || hit.savedAt || hit.updated_at;
    const score = hit.score ?? hit.similarity ?? hit.relevance;
    let line = `  ${c.neon(`[${i + 1}]`)} ${c.bold(String(title))}`;
    if (when) line += c.dim(`  ${formatDate(when)}`);
    if (typeof score === 'number') line += c.dim(`  ${score.toFixed(2)}`);
    out.push(line);
    const snippet = hit.snippet || hit.excerpt || hit.preview || hit.content || hit.text;
    if (snippet) {
      for (const l of wrapText(String(snippet).replace(/\s+/g, ' ').slice(0, 220), 66).slice(0, 2)) {
        out.push(`      ${c.dim(l)}`);
      }
    }
  });
  if (list.length > 20) out.push(`\n  ${c.dim(`… ${list.length - 20} more`)}`);
  return out.join('\n');
}

function formatDate(v) {
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

// ── table ───────────────────────────────────────────────────────────────────
function table(rows, { columns = null, empty = 'nothing to show' } = {}) {
  if (!Array.isArray(rows) || !rows.length) return `  ${c.dim(empty)}`;
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 6);
  const w = {};
  for (const col of cols) {
    w[col] = Math.max(col.length, ...rows.map((r) => width(fmtCell(r[col]))));
    w[col] = Math.min(w[col], 40);
  }
  const line = (ch, l, m, r) => c.dim(l + cols.map((col) => ch.repeat(w[col] + 2)).join(m) + r);
  const out = [line('─', '┌', '┬', '┐')];
  out.push(c.dim('│') + cols.map((col) => ` ${c.bold(pad(col.toUpperCase(), w[col]))} `).join(c.dim('│')) + c.dim('│'));
  out.push(line('─', '├', '┼', '┤'));
  for (const r of rows) {
    out.push(c.dim('│') + cols.map((col) => {
      let v = fmtCell(r[col]);
      if (width(v) > w[col]) v = strip(v).slice(0, w[col] - 1) + '…';
      return ` ${pad(v, w[col])} `;
    }).join(c.dim('│')) + c.dim('│'));
  }
  out.push(line('─', '└', '┴', '┘'));
  return out.join('\n');
}

function fmtCell(v) {
  if (v === null || v === undefined) return c.dim('—');
  if (typeof v === 'boolean') return v ? c.green('yes') : c.dim('no');
  if (Array.isArray(v)) return v.length ? `${v.length}` : c.dim('—');
  if (typeof v === 'object') return c.dim('{…}');
  return String(v);
}

// ── markdown ────────────────────────────────────────────────────────────────
// Deliberately shallow: headings, bullets, code fences, emphasis. A full
// markdown engine would be a dependency, and this only has to be readable.
function markdown(text) {
  const out = [];
  let inCode = false;
  for (const raw of String(text).split('\n')) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; out.push(c.dim(raw)); continue; }
    if (inCode) { out.push(c.dim('  ') + c.cyan(raw)); continue; }
    let line = raw;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push('');
      out.push(h[1].length === 1 ? c.neon(c.bold(h[2].toUpperCase())) : c.bold(h[2]));
      if (h[1].length === 1) out.push(c.dim('─'.repeat(Math.min(60, h[2].length + 4))));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) line = line.replace(/^(\s*)[-*+]\s+/, (_, s) => `${s}${c.neon('•')} `);
    if (/^\s*>\s?/.test(line)) line = c.dim(line.replace(/^\s*>\s?/, '  │ '));
    line = line
      .replace(/\*\*(.+?)\*\*/g, (_, t) => c.bold(t))
      .replace(/`([^`]+)`/g, (_, t) => c.cyan(t));
    out.push(line);
  }
  return out.join('\n');
}

// ── progress ────────────────────────────────────────────────────────────────
function progress(pct, label = '') {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const len = 24;
  const filled = Math.round((p / 100) * len);
  return `  ${c.neon('█'.repeat(filled))}${c.dim('░'.repeat(len - filled))} ${String(p).padStart(3)}%${label ? `  ${c.dim(label)}` : ''}`;
}

// The one spinner currently painting the line. A spinner redraws every 80ms,
// so anything that needs to READ from the same terminal (an auth prompt, a
// dangerous-command confirmation) must stop it first or the prompt is
// overwritten mid-keystroke and the user cannot see what they are typing.
// client.prompt() calls stopActiveSpinner() for exactly this reason.
let activeSpinner = null;

function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0, active = true;
  const tty = process.stdout.isTTY;
  // Non-TTY (piped, CI, a subprocess) gets one static line instead of an
  // animation, but is still TRACKED the same way — stop() must behave
  // identically in both modes or callers have to branch on terminal type.
  if (!tty) console.log(`  ${label}…`);
  const timer = tty ? setInterval(() => {
    process.stdout.write(`\r  ${c.neon(frames[i++ % frames.length])} ${c.dim(label)}   `);
  }, 80) : null;

  const handle = {
    stop(final) {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      if (tty) process.stdout.write('\r\x1b[2K');
      if (activeSpinner === handle) activeSpinner = null;
      if (final) console.log(final);
    },
  };
  activeSpinner = handle;
  return handle;
}

/** Stop whatever spinner is painting, so the line is free for input. */
function stopActiveSpinner() {
  if (activeSpinner) activeSpinner.stop();
}

// ── dispatcher ──────────────────────────────────────────────────────────────
/**
 * Picks a renderer from an explicit hint, then from the shape of the payload.
 * Wrapped so a renderer bug degrades to readable JSON instead of losing the
 * result entirely.
 */
function auto(payload, { renderer = null, query = null, json = false } = {}) {
  if (json) return JSON.stringify(payload, null, 2);
  try {
    const d = payload?.data ?? payload ?? {};
    switch (renderer) {
      case 'grade-card':     return gradeCard(payload);
      case 'search-results': return searchResults(payload, { query });
      case 'markdown':       return markdown(d.text ?? d.content ?? d.markdown ?? String(d));
      case 'table':          return table(Array.isArray(d) ? d : d.rows || d.items || []);
      case 'raw-json':       return JSON.stringify(payload, null, 2);
    }
    if (d.grade !== undefined || d.score !== undefined && d.breakdown) return gradeCard(payload);
    if (Array.isArray(d.results) || Array.isArray(d.hits) || Array.isArray(d.matches)) return searchResults(payload, { query });
    if (Array.isArray(d) && d.length && typeof d[0] === 'object') return table(d);

    const text = payload?.text ?? d.text ?? d.answer ?? d.content ?? d.message ?? d.summary;
    if (typeof text === 'string' && text.trim()) return markdown(text);

    // Blocks name their payloads after the thing they return — {gpus:[…]},
    // {models:[…]}, {blocks:[…]}. When exactly one key holds an array of
    // objects, that array IS the result; table it instead of dumping JSON.
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const arrays = Object.entries(d).filter(
        ([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null,
      );
      if (arrays.length === 1) {
        const [key, rows] = arrays[0];
        return `  ${c.dim(key)}\n${table(rows)}`;
      }
      // Flat scalar bag (a status blob) reads better as aligned pairs.
      const scalars = Object.entries(d).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
      if (scalars.length && scalars.length === Object.keys(d).length) {
        const w = Math.max(...scalars.map(([k]) => k.length));
        return scalars.map(([k, v]) => `  ${c.dim(pad(k, w))}  ${fmtCell(v)}`).join('\n');
      }
    }

    if (d && typeof d === 'object' && Object.keys(d).length) return JSON.stringify(d, null, 2);
    return c.dim('  (no output)');
  } catch (e) {
    return `${c.yellow('  ! renderer failed, showing raw result')}\n${JSON.stringify(payload, null, 2)}\n${c.dim(`  (${e.message})`)}`;
  }
}

module.exports = {
  box, bar, gradeCard, searchResults, table, markdown, progress, spinner, auto,
  wrapText, strip, width, pad, stopActiveSpinner,
};
