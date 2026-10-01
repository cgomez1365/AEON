/**
 * Master → Install from the store: what the operator pasted, and what a new
 * section is called.
 *
 * A block is a program. A link that is not https lets whoever sits on the
 * network path choose what gets installed, so the panel refuses it before any
 * request — and says why, which is why "nothing typed" and "not a link or a
 * name" are kept as different kinds. Section names typed by the operator must
 * survive a round trip through settings as ids, and ids must read back as
 * names.
 */
import { describe, expect, it } from 'vitest';

const { classifySource, slug, labelise } = await import('../src/blocks/master/InstallPanel.jsx');

describe('what the operator pasted', () => {
  it('an https link is installed from that link', () => {
    expect(classifySource('https://store.example/reports-0.1.0.aeon'))
      .toEqual({ kind: 'url', body: { url: 'https://store.example/reports-0.1.0.aeon' } });
  });

  it('an http link is refused, whatever the case of its scheme', () => {
    expect(classifySource('http://store.example/reports.aeon')).toEqual({ kind: 'insecure' });
    expect(classifySource('HTTP://store.example/reports.aeon')).toEqual({ kind: 'insecure' });
  });

  it('a bare block id is a name', () => {
    expect(classifySource('reports')).toEqual({ kind: 'name', body: { name: 'reports' } });
    expect(classifySource('my_block-2')).toEqual({ kind: 'name', body: { name: 'my_block-2' } });
    expect(classifySource('Reports')).toEqual({ kind: 'name', body: { name: 'Reports' } });
  });

  it('surrounding spaces are trimmed', () => {
    expect(classifySource('  https://s/x.aeon  ')).toEqual({ kind: 'url', body: { url: 'https://s/x.aeon' } });
    expect(classifySource('  reports ')).toEqual({ kind: 'name', body: { name: 'reports' } });
  });

  it('keeps "nothing yet" apart from "not a link or a name"', () => {
    for (const v of ['', '   ', null, undefined]) expect(classifySource(v)).toEqual({ kind: 'empty' });
    for (const v of ['/Users/me/reports.aeon', 'file:///tmp/x.aeon', 'ftp://x/y.aeon', 'two words', 'reports.aeon', '_hidden', '-x']) {
      expect(classifySource(v), v).toEqual({ kind: 'unknown' });
    }
  });

  it('keeps an upper-case https scheme as typed', () => {
    expect(classifySource('HTTPS://x/y.aeon')).toEqual({ kind: 'url', body: { url: 'HTTPS://x/y.aeon' } });
  });
});

describe('naming a new section', () => {
  it('slug makes a stored id', () => {
    expect(slug('Client Work')).toBe('client_work');
    expect(slug('  Ops & Risk  ')).toBe('ops_risk');
    expect(slug('2026 Projects')).toBe('2026_projects');
  });

  it('an id is never empty', () => {
    expect(slug('!!!')).toBe('custom');
    expect(slug('')).toBe('custom');
    expect(slug(null)).toBe('custom');
  });

  it('labelise reads an id back as a name', () => {
    expect(labelise('file_manager')).toBe('File Manager');
    expect(labelise('agents')).toBe('Agents');
    expect(labelise('ops-and__risk')).toBe('Ops And Risk');
    expect(labelise('client_work')).toBe('Client Work');
  });
});
