import React, { useState, useEffect } from 'react';
import { ExternalLink, Plus, Trash2, Link2, X, Search, ChevronDown, ChevronUp, Pencil, ArrowUp, ArrowDown, Check } from 'lucide-react';
import { useAeonContext } from '../../kernel/contexts/AeonContext';
import { safeHref, normalizeUrl, moveLink, editLink, storeProblem } from './linkOps.js';

const DEFAULT_LINKS = [];
const CATEGORIES = ['General', 'Workspace', 'Dev Ops', 'Database', 'Integrations', 'Personal', 'Active Portals', 'Codebases', 'Client'];

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

export default function QuickLinks() {
  const { links, linksError, manageLinks, updateLinks } = useAeonContext();
  const [showAdd, setShowAdd] = useState(false);
  const [formError, setFormError] = useState(null);
  const [editing, setEditing] = useState(null); // { id, name, url, category }
  const [editError, setEditError] = useState(null);
  // HTTP status of a direct probe of the links store, taken only when the
  // context reports a failure — so a missing Aeon Matrix block (404) is named
  // instead of surfacing as a raw "HTTP 404".
  const [storeStatus, setStoreStatus] = useState(undefined);

  useEffect(() => {
    if (!linksError) { setStoreStatus(undefined); return; }
    let live = true;
    fetch('/api/sync/quick_links', { headers: { 'x-aeon-self-reported': '1' } })
      .then(r => { if (live) setStoreStatus(r.status); })
      .catch(() => { if (live) setStoreStatus(0); });
    return () => { live = false; };
  }, [linksError]);
  const problem = storeProblem(linksError, storeStatus);
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('General');
  const [collapsedCats, setCollapsedCats] = useState({});

  const allLinks = links?.length > 0 ? links : DEFAULT_LINKS;

  const filtered = search
    ? allLinks.filter(l => (l.name || '').toLowerCase().includes(search.toLowerCase()) || (l.url || '').toLowerCase().includes(search.toLowerCase()) || (l.category || '').toLowerCase().includes(search.toLowerCase()))
    : allLinks;

  const categories = [...new Set(filtered.map(l => l.category || 'General'))].sort();

  const handleAdd = (e) => {
    e.preventDefault();
    if (!name.trim() || !url) return;
    const safe = normalizeUrl(url);
    if (!safe) { setFormError('Only http:// and https:// addresses can be saved.'); return; }
    setFormError(null);
    manageLinks({ action: 'add', name: name.trim(), url: safe, category });
    setName(''); setUrl(''); setCategory('General'); setShowAdd(false);
  };

  // Edit and reorder persist the whole list through updateLinks — the same
  // server-backed save (/api/sync/quick_links) add and delete use.
  const startEdit = (link) => { setEditError(null); setEditing({ id: link.id, name: link.name || link.title || '', url: link.url || '', category: link.category || 'General' }); };
  const saveEdit = (e) => {
    e.preventDefault();
    const r = editLink(allLinks, editing.id, { name: editing.name, url: editing.url, category: editing.category });
    if (r.error) { setEditError(r.error); return; }
    updateLinks(r.links);
    setEditing(null);
  };
  const move = (id, delta) => {
    const next = moveLink(allLinks, id, delta);
    if (next.some((l, i) => l !== allLinks[i])) updateLinks(next);
  };

  const handleDelete = (id) => {
    const item = allLinks.find(l => l.id === id);
    if (item) manageLinks({ action: 'delete', id: item.id, name: item.name });
  };

  const toggleCat = (cat) => setCollapsedCats(prev => ({ ...prev, [cat]: !prev[cat] }));

  return (
    <div style={{ padding: '24px', maxWidth: '800px', margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Link2 size={20} aria-hidden="true" style={{ color: 'var(--color-primary, #00f2ff)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Quick Links</h2>
        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', border: '1px solid rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
          {allLinks.length} links
        </span>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim)', margin: '0 0 16px 0' }}>
        Bookmarks, portals, and operational links — organized by category
      </p>

      {problem && (
        <div role="alert" style={{ margin: '0 0 12px 0', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', border: '1px solid #ff5c5c', background: 'rgba(255,92,92,0.08)', color: '#ff8a8a' }}>
          {problem}
        </div>
      )}

      {/* Search + Add */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={12} aria-hidden="true" style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-dim)' }} />
          <input type="text" placeholder="Search links..." aria-label="Search links" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '8px 10px 8px 28px', borderRadius: '8px', fontSize: '12px', border: '1px solid var(--border, #2a2a2a)', background: 'rgba(0,0,0,0.2)', color: 'var(--text)' }} />
        </div>
        <button onClick={() => setShowAdd(!showAdd)} aria-expanded={showAdd} aria-controls="quick-links-add-form" style={{
          display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
          cursor: 'pointer', border: '1px solid var(--color-primary)', background: showAdd ? 'rgba(0,242,255,0.1)' : 'transparent', color: 'var(--color-primary)',
        }}>
          {showAdd ? <X size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />} {showAdd ? 'Cancel' : 'Add'}
        </button>
      </div>

      {/* Add Form */}
      {showAdd && (
        <form id="quick-links-add-form" onSubmit={handleAdd} style={{
          background: 'var(--color-surface, #1a1a1a)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '16px',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px',
        }}>
          <input type="text" required placeholder="Link name" aria-label="Link name" value={name} onChange={e => setName(e.target.value)}
            style={inputStyle} />
          <input type="text" required placeholder="URL" aria-label="URL" value={url} onChange={e => setUrl(e.target.value)}
            style={inputStyle} />
          <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category" style={inputStyle}>
            {CATEGORIES.map(c =>
              <option key={c} value={c}>{c}</option>
            )}
          </select>
          <button type="submit" style={{ padding: '8px', borderRadius: '8px', background: 'var(--color-primary)', color: '#000', border: 'none', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
            Save Link
          </button>
          {formError && <div role="alert" style={{ gridColumn: '1 / -1', fontSize: '11px', color: '#ff8a8a' }}>{formError}</div>}
        </form>
      )}

      {/* Categorized Link List */}
      {categories.map(cat => {
        const catLinks = filtered.filter(l => (l.category || 'General') === cat);
        const collapsed = collapsedCats[cat];
        return (
          <div key={cat} style={{ marginBottom: '8px' }}>
            <button onClick={() => toggleCat(cat)} aria-expanded={!collapsed} style={{
              display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '6px 10px',
              background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border, #2a2a2a)', borderRadius: '6px',
              color: 'var(--text-dim)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
              cursor: 'pointer', textAlign: 'left',
            }}>
              {collapsed ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
              {cat}
              <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{catLinks.length}</span>
            </button>

            {!collapsed && (
              <div style={{ display: 'grid', gap: '2px', marginTop: '4px' }}>
                {catLinks.map((link, idx) => {
                  const href = safeHref(link.url);
                  const label = link.name || link.title;
                  if (editing?.id === link.id) {
                    return (
                      <form key={link.id} onSubmit={saveEdit} aria-label={`Edit ${label}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px auto auto', gap: '6px', padding: '6px 8px', borderRadius: '6px', background: 'rgba(0,242,255,0.04)' }}>
                        <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} aria-label="Link name" style={inputStyle} />
                        <input value={editing.url} onChange={e => setEditing({ ...editing, url: e.target.value })} aria-label="URL" style={inputStyle} />
                        <select value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} aria-label="Category" style={inputStyle}>
                          {[...new Set([...CATEGORIES, editing.category])].map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <button type="submit" aria-label="Save changes" style={{ ...iconBtn, opacity: 1, color: "var(--color-primary)" }}><Check size={13} aria-hidden="true" /></button>
                        <button type="button" aria-label="Cancel editing" onClick={() => setEditing(null)} style={{ ...iconBtn, opacity: 1 }}><X size={13} aria-hidden="true" /></button>
                        {editError && <div role="alert" style={{ gridColumn: '1 / -1', fontSize: '11px', color: '#ff8a8a' }}>{editError}</div>}
                      </form>
                    );
                  }
                  return (
                  <div key={link.id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                    borderRadius: '6px', transition: 'background 0.1s',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

                    {href && <img src={`https://www.google.com/s2/favicons?domain=${getDomain(href)}&sz=16`} width="16" height="16"
                      alt="" aria-hidden="true"
                      style={{ borderRadius: '2px', flexShrink: 0 }} onError={e => e.target.style.display = 'none'} />}

                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer"
                        style={{ flex: 1, color: 'var(--text)', textDecoration: 'none', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                      </a>
                    ) : (
                      <span title="This address is not http(s), so it will not be opened. Edit it to fix." style={{ flex: 1, fontSize: '13px', color: '#ff8a8a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label} — blocked address
                      </span>
                    )}

                    <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.4, flexShrink: 0 }}>
                      {href ? getDomain(href) : ''}
                    </span>

                    {!search && (
                      <>
                        <button type="button" aria-label={`Move ${label} up`} disabled={idx === 0} onClick={() => move(link.id, -1)} style={{ ...iconBtn, opacity: idx === 0 ? 0.1 : 0.3 }}>
                          <ArrowUp size={11} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`Move ${label} down`} disabled={idx === catLinks.length - 1} onClick={() => move(link.id, +1)} style={{ ...iconBtn, opacity: idx === catLinks.length - 1 ? 0.1 : 0.3 }}>
                          <ArrowDown size={11} aria-hidden="true" />
                        </button>
                      </>
                    )}

                    <button type="button" aria-label={`Edit ${label}`} onClick={() => startEdit(link)} style={iconBtn}
                      onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '0.3'}>
                      <Pencil size={11} aria-hidden="true" />
                    </button>

                    {href && (
                      <button type="button" aria-label={`Open ${label} in a new tab`}
                        onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
                        style={iconBtn}
                        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={e => e.currentTarget.style.opacity = '0.3'}>
                        <ExternalLink size={11} aria-hidden="true" />
                      </button>
                    )}

                    <button type="button" aria-label={`Delete ${label}`} onClick={() => handleDelete(link.id)} style={iconBtn}
                      onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '0.3'}>
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const iconBtn = {
  display: 'flex', background: 'none', border: 'none', color: 'var(--text-dim)',
  cursor: 'pointer', padding: '2px', opacity: 0.3, flexShrink: 0,
};

const inputStyle = {
  padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
  border: '1px solid var(--border, #2a2a2a)', background: 'rgba(0,0,0,0.2)',
  color: 'var(--text)', fontFamily: 'inherit',
};
