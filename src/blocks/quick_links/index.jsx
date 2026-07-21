import React, { useState, useEffect } from 'react';
import { ExternalLink, Plus, Trash2, Link2, X, Search, ChevronDown, ChevronUp, Star } from 'lucide-react';
import { useAeonContext } from '../../kernel/contexts/AeonContext';

const DEFAULT_LINKS = [];

function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

export default function QuickLinks() {
  const { links, manageLinks } = useAeonContext();
  const [showAdd, setShowAdd] = useState(false);
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
    if (!name || !url) return;
    manageLinks({ action: 'add', name, url: url.startsWith('http') ? url : `https://${url}`, category });
    setName(''); setUrl(''); setCategory('General'); setShowAdd(false);
  };

  const handleDelete = (id) => {
    const item = allLinks.find(l => l.id === id);
    if (item) manageLinks({ action: 'delete', name: item.name });
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
            {['General', 'Workspace', 'Dev Ops', 'Database', 'Integrations', 'Personal', 'Active Portals', 'Codebases', 'Client'].map(c =>
              <option key={c} value={c}>{c}</option>
            )}
          </select>
          <button type="submit" style={{ padding: '8px', borderRadius: '8px', background: 'var(--color-primary)', color: '#000', border: 'none', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
            Save Link
          </button>
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
                {catLinks.map(link => (
                  <div key={link.id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                    borderRadius: '6px', transition: 'background 0.1s',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>

                    <img src={`https://www.google.com/s2/favicons?domain=${getDomain(link.url)}&sz=16`} width="16" height="16"
                      alt="" aria-hidden="true"
                      style={{ borderRadius: '2px', flexShrink: 0 }} onError={e => e.target.style.display = 'none'} />

                    <a href={link.url} target="_blank" rel="noopener noreferrer"
                      style={{ flex: 1, color: 'var(--text)', textDecoration: 'none', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.name || link.title}
                    </a>

                    <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.4, flexShrink: 0 }}>
                      {getDomain(link.url)}
                    </span>

                    <button type="button" aria-label={`Open ${link.name || link.title} in a new tab`}
                      onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
                      style={{ display: 'flex', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px', opacity: 0.3, flexShrink: 0 }}
                      onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '0.3'}>
                      <ExternalLink size={11} aria-hidden="true" />
                    </button>

                    <button type="button" aria-label={`Delete ${link.name || link.title}`} onClick={() => handleDelete(link.id)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '2px', opacity: 0.3, flexShrink: 0 }}
                      onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                      onMouseLeave={e => e.currentTarget.style.opacity = '0.3'}>
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const inputStyle = {
  padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
  border: '1px solid var(--border, #2a2a2a)', background: 'rgba(0,0,0,0.2)',
  color: 'var(--text)', fontFamily: 'inherit',
};
