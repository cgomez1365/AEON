/**
 * Master → Install: what the operator pastes, and what it becomes.
 *
 * These import the real helpers. The https rule in particular is a safety
 * property and not a convenience — a cartridge is executable code, so fetching
 * one over http lets whoever sits between here and the store choose what gets
 * installed. The kernel refuses it as well; this refuses earlier and explains.
 */
import { describe, it, expect } from 'vitest';
import { classifySource, slug, labelise } from '../src/blocks/master/InstallPanel.jsx';

describe('what the operator pasted', () => {
  it('sends an https link as a url', () => {
    expect(classifySource('https://store.example/reports-0.1.0.aeon'))
      .toEqual({ kind: 'url', body: { url: 'https://store.example/reports-0.1.0.aeon' } });
  });

  it('REFUSES http, rather than passing it on', () => {
    expect(classifySource('http://store.example/reports.aeon').kind).toBe('insecure');
    expect(classifySource('HTTP://store.example/reports.aeon').kind).toBe('insecure');
  });

  it('sends a bare id as a name, for the store to resolve and verify', () => {
    expect(classifySource('reports')).toEqual({ kind: 'name', body: { name: 'reports' } });
    expect(classifySource('my_block-2')).toEqual({ kind: 'name', body: { name: 'my_block-2' } });
  });

  it('trims, so a pasted link with a stray space still installs', () => {
    expect(classifySource('  https://s/x.aeon  ').body.url).toBe('https://s/x.aeon');
  });

  it('distinguishes empty from unrecognised, because they need different sentences', () => {
    expect(classifySource('').kind).toBe('empty');
    expect(classifySource('   ').kind).toBe('empty');
    expect(classifySource('/Users/me/reports.aeon').kind).toBe('unknown');
    expect(classifySource('file:///tmp/x.aeon').kind).toBe('unknown');
  });
});

describe('naming a new section', () => {
  it('makes an id that survives a round trip through settings', () => {
    expect(slug('Client Work')).toBe('client_work');
    expect(slug('  Ops & Risk  ')).toBe('ops_risk');
    expect(slug('2026 Projects')).toBe('2026_projects');
  });

  it('never returns an empty id', () => {
    expect(slug('!!!')).toBe('custom');
    expect(slug('')).toBe('custom');
  });

  it('renders a stored group id back as a readable name', () => {
    expect(labelise('file_manager')).toBe('File Manager');
    expect(labelise('agents')).toBe('Agents');
  });
});
