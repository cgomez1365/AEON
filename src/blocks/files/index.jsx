import React, { useState, useEffect, useRef } from 'react';
import { Folder, FileText, Upload, FolderPlus, ChevronRight, Home, ArrowLeft, X, RefreshCw, Trash2, Download, Cloud, Monitor, Save, Columns } from 'lucide-react';
import { supabase } from '../../kernel/supabase';
import { WORKSPACE } from '../../config.js';
import ModalPortal from '../../components/ModalPortal.jsx';

const BUCKET = 'aeon-files';
const IS_LOCAL_ENV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const LOCAL_API = '/api/fs';

const FILE_ICONS = {
  '.pdf': '📄', '.md': '📝', '.json': '📊', '.html': '🌐', '.css': '🎨',
  '.js': '⚡', '.jsx': '⚛️', '.py': '🐍', '.bat': '🦇', '.png': '🖼️',
  '.jpg': '🖼️', '.jpeg': '🖼️', '.txt': '📃', '.csv': '📈', '.svg': '🎯',
  '.mp4': '🎬', '.mp3': '🎵', '.zip': '📦', '.docx': '📝', '.xlsx': '📊',
};

const getFileIcon = (name) => {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return FILE_ICONS[ext] || '📄';
};

const formatSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const folderPrefix = (folder) => folder ? folder + '/' : '';

function FilePane({ mode, onPreview, onEdit }) {
  const [currentFolder, setCurrentFolder] = useState('');
  const [entries, setEntries]             = useState([]);
  const [loading, setLoading]             = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [isDragOver, setIsDragOver]       = useState(false);
  const [uploadStatus, setUploadStatus]   = useState('');
  const [fsLocked, setFsLocked]           = useState(true); // add-only until server says otherwise
  const dropRef   = useRef(null);
  const fileInput = useRef(null);

  const themeColor = mode === 'cloud' ? '#3ECF8E' : '#00f2ff';
  const themeBg = mode === 'cloud' ? 'rgba(62,207,142,0.1)' : 'rgba(0,242,255,0.1)';

  // Local hub edits touch REAL files on disk — lock state is server-enforced;
  // this just keeps the UI honest about it.
  useEffect(() => {
    if (mode !== 'cloud') {
      fetch('/api/fs/lock').then(r => r.json()).then(d => setFsLocked(d.locked !== false)).catch(() => {});
    }
  }, [mode]);

  const toggleLock = async () => {
    if (fsLocked) {
      const sure = window.confirm(
        '⚠ Unlock full editing?\n\nEverything in this hub is a REAL file on this computer\'s disk. ' +
        'While unlocked, deleting or overwriting here permanently changes the actual file — there is no separate copy.\n\n' +
        'Unlock?'
      );
      if (!sure) return;
    }
    try {
      const r = await fetch('/api/fs/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: !fsLocked }) });
      const d = await r.json();
      setFsLocked(d.locked !== false);
      setUploadStatus(d.locked !== false ? '🔒 Add-only mode: browse and add files; editing and deleting are off.' : '🔓 Full edit mode: changes here affect the real files on this computer.');
      setTimeout(() => setUploadStatus(''), 6000);
    } catch {}
  };

  const loadDir = async (folder = currentFolder) => {
    setLoading(true);
    setUploadStatus('');
    try {
      if (mode === 'cloud') {
        if (!supabase) throw new Error('Cloud storage not configured — add Supabase keys in Settings.');
        const prefix = folderPrefix(folder);
        const { data, error } = await supabase.storage
          .from(BUCKET)
          .list(prefix, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw error;
        
        const folders = [];
        const files   = [];
        const seen    = new Set();

        for (const item of data || []) {
          if (item.id === null) {
            if (!seen.has(item.name)) { seen.add(item.name); folders.push({ name: item.name, type: 'dir' }); }
          } else if (item.name !== '.keep') {
            files.push({ name: item.name, type: 'file', size: item.metadata?.size, storagePath: prefix + item.name });
          }
        }
        setEntries([...folders, ...files]);
      } else {
        const body = JSON.stringify({ dirPath: folder || WORKSPACE });
        const res = await fetch(`${LOCAL_API}/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const sorted = (data.entries || []).sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'dir' ? -1 : 1;
        });
        setEntries(sorted.map(f => ({ ...f, storagePath: f.path })));
      }
      setCurrentFolder(folder);
    } catch (e) {
      setUploadStatus(`❌ Error loading folder: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDir(''); }, [mode]);

  const navigateTo = (entry) => {
    if (mode === 'cloud') loadDir(folderPrefix(currentFolder) + entry.name);
    else loadDir(entry.storagePath);
  };

  const goUp = () => {
    if (mode === 'cloud') {
      const parts = currentFolder.split('/').filter(Boolean);
      parts.pop();
      loadDir(parts.join('/'));
    } else {
      const parts = currentFolder.split('\\').filter(Boolean);
      if (parts.length > 3) { parts.pop(); loadDir(parts.join('\\')); }
      else loadDir('');
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      if (mode === 'cloud') {
        if (!supabase) throw new Error('Cloud storage not configured — add Supabase keys in Settings.');
        const path = folderPrefix(currentFolder) + newFolderName.trim() + '/.keep';
        const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob(['']), { upsert: true });
        if (error) throw error;
      } else {
        setUploadStatus('❌ Local folder creation via API not yet implemented.'); return;
      }
      setNewFolderName(''); setShowNewFolder(false); loadDir(currentFolder);
    } catch (error) { setUploadStatus(`❌ Folder error: ${error.message}`); }
  };

  const uploadFilesList = async (files) => {
    let uploaded = 0;
    try {
      if (mode === 'cloud') {
        if (!supabase) throw new Error('Cloud storage not configured — add Supabase keys in Settings.');
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (file.size > 50 * 1024 * 1024) { setUploadStatus(`❌ ${file.name} exceeds 50 MB limit.`); continue; }
          setUploadStatus(`⬆️ Uploading ${file.name} to Cloud...`);
          const storagePath = folderPrefix(currentFolder) + file.name;
          const { error } = await supabase.storage.from(BUCKET).upload(storagePath, file, { upsert: true });
          if (error) throw error;
          uploaded++;
        }
      } else {
        const formData = new FormData();
        const uploadPath = currentFolder || WORKSPACE;
        formData.append('targetDir', uploadPath);
        for (let i = 0; i < files.length; i++) { formData.append('files', files[i]); }
        setUploadStatus(`⬆️ Saving ${files.length} file(s) to Local Disk...`);
        const res = await fetch(`${LOCAL_API}/upload`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error(await res.text());
        uploaded = files.length;
      }
      setUploadStatus(`✅ ${uploaded} file(s) saved successfully!`);
      loadDir(currentFolder);
      setTimeout(() => setUploadStatus(''), 5000);
    } catch (error) {
      setUploadStatus(`❌ Upload failed: ${error.message}`);
      setTimeout(() => setUploadStatus(''), 8000);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    if (!e.dataTransfer.files?.length) return;
    await uploadFilesList(e.dataTransfer.files);
  };

  const handleFileSelect = async (e) => {
    if (!e.target.files?.length) return;
    await uploadFilesList(e.target.files);
    e.target.value = '';
  };

  const handleDelete = async (e, entry) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${entry.name}"?`)) return;
    try {
      if (mode === 'cloud') {
        if (!supabase) throw new Error('Cloud storage not configured — add Supabase keys in Settings.');
        const { error } = await supabase.storage.from(BUCKET).remove([entry.storagePath]);
        if (error) throw error;
      } else {
        const body = JSON.stringify({ targetPath: entry.storagePath });
        const res = await fetch(`${LOCAL_API}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (res.status === 423) { const d = await res.json().catch(() => ({})); setFsLocked(true); throw new Error(d.error || 'Locked — unlock the hub to delete.'); }
        if (!res.ok) throw new Error(await res.text());
      }
      loadDir(currentFolder);
    } catch (error) { setUploadStatus(`❌ Delete failed: ${error.message}`); }
  };

  const handleFileClick = async (entry) => {
    if (entry.type === 'dir') { navigateTo(entry); return; }
    const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    const previewable = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.webm'];
    const editable = ['.txt', '.md', '.json', '.js', '.jsx', '.html', '.css', '.py', '.bat'];

    if (mode === 'cloud') {
      if (!supabase) { alert('Cloud storage not configured — add Supabase keys in Settings.'); return; }
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(entry.storagePath, 300);
      if (!data?.signedUrl) return;
      if (previewable.includes(ext)) onPreview(data.signedUrl, entry.name, mode);
      else window.open(data.signedUrl, '_blank');
    } else {
      if (editable.includes(ext)) {
        try {
          const body = JSON.stringify({ filePath: entry.storagePath });
          const res = await fetch(`${LOCAL_API}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          onEdit(data.content, entry.storagePath, entry.name);
        } catch (e) { alert('Could not open file: ' + e.message); }
      } else if (previewable.includes(ext)) {
        onPreview(`/api/fs/serve?path=${encodeURIComponent(entry.storagePath)}`, entry.name, mode);
      } else { alert('File type not supported for inline viewing.'); }
    }
  };

  const handleDownload = async (e, entry) => {
    e.stopPropagation();
    if (mode === 'cloud') {
      if (!supabase) { alert('Cloud storage not configured — add Supabase keys in Settings.'); return; }
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(entry.storagePath, 60);
      if (data?.signedUrl) {
        const a = document.createElement('a'); a.href = data.signedUrl; a.download = entry.name; a.click();
      }
    } else {
      const a = document.createElement('a');
      a.href = `/api/fs/serve?path=${encodeURIComponent(entry.storagePath)}&download=1`;
      a.download = entry.name; a.click();
    }
  };

  const crumbs = mode === 'cloud' 
    ? currentFolder.split('/').filter(Boolean)
    : currentFolder.replace(WORKSPACE, '').split('\\').filter(Boolean);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', padding: '20px', border: `1px solid rgba(255,255,255,0.05)`, minWidth: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
        <div>
          <h3 style={{ margin: 0, color: themeColor, display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px' }}>
            {mode === 'cloud' ? <Cloud size={18} /> : <Monitor size={18} />}
            {mode === 'cloud' ? 'CLOUD HUB' : 'LOCAL OS HUB'}
          </h3>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {mode !== 'cloud' && (
            <button onClick={toggleLock}
              aria-label={fsLocked ? 'Unlock full editing' : 'Lock to add-only mode'}
              title={fsLocked ? 'Add-only: browse & add files. Click to unlock editing/deleting.' : 'Full edit: changes affect real disk files. Click to lock.'}
              style={{ background: fsLocked ? 'rgba(0,255,64,0.08)' : 'rgba(245,158,11,0.12)', border: `1px solid ${fsLocked ? 'rgba(0,255,64,0.4)' : '#f59e0b'}`, color: fsLocked ? '#22c55e' : '#f59e0b', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700 }}>
              {fsLocked ? '🔒 Add-only' : '🔓 Full edit'}
            </button>
          )}
          <button onClick={() => fileInput.current?.click()} aria-label="Upload files" style={{ background: themeBg, border: `1px solid ${themeColor}40`, color: themeColor, padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600 }}>
            <Upload size={12} /> Upload
          </button>
          <input type="file" ref={fileInput} onChange={handleFileSelect} multiple aria-label="Choose files to upload" style={{ display: 'none' }} />
          <button onClick={() => loadDir(currentFolder)} aria-label="Refresh file list" title="Refresh" style={{ background: themeBg, border: `1px solid ${themeColor}40`, color: themeColor, padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600 }}>
            <RefreshCw size={12} />
          </button>
          {mode === 'cloud' && (
            <button onClick={() => setShowNewFolder(!showNewFolder)} aria-label="New folder" title="New folder" aria-expanded={showNewFolder} style={{ background: themeBg, border: `1px solid ${themeColor}40`, color: themeColor, padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600 }}>
              <FolderPlus size={12} />
            </button>
          )}
        </div>
      </div>

      {mode !== 'cloud' && (
        <div role="note" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', marginBottom: '12px', borderRadius: '6px', fontSize: '11px', lineHeight: 1.5,
          background: fsLocked ? 'rgba(255,255,255,0.03)' : 'rgba(245,158,11,0.08)',
          border: `1px solid ${fsLocked ? 'rgba(255,255,255,0.08)' : '#f59e0b'}`,
          color: fsLocked ? '#94a3b8' : '#f59e0b' }}>
          <span aria-hidden="true">{fsLocked ? '🛈' : '⚠'}</span>
          <span>
            {fsLocked
              ? 'These are the real files on this computer. Add-only mode is on: you can browse and add, but nothing can be edited or deleted.'
              : 'Full edit mode: deleting or changing anything here permanently changes the actual file on this computer\'s disk. Edit carefully.'}
          </span>
        </div>
      )}

      {showNewFolder && mode === 'cloud' && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <input autoFocus value={newFolderName} onChange={e => setNewFolderName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreateFolder()} placeholder="Folder name..." aria-label="New folder name" onFocus={e => { e.currentTarget.style.borderColor = themeColor; e.currentTarget.style.boxShadow = `0 0 0 2px ${themeBg}`; }} onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none'; }} style={{ flex: 1, padding: '8px 12px', background: '#090d16', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: '#fff', outline: 'none', fontSize: '12px' }} />
          <button onClick={handleCreateFolder} style={{ background: themeColor, color: '#000', border: 'none', padding: '8px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>Create</button>
        </div>
      )}

      {/* Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '12px', fontSize: '11px', flexWrap: 'wrap' }}>
        <button onClick={goUp} aria-label="Go up one folder" title="Up" style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><ArrowLeft size={12} /></button>
        <button onClick={() => loadDir('')} style={{ background: 'transparent', border: 'none', color: themeColor, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
          <Home size={12} /> {mode === 'cloud' ? 'Cloud' : 'Local'}
        </button>
        {crumbs.map((crumb, i) => {
          const path = mode === 'cloud' ? crumbs.slice(0, i + 1).join('/') : WORKSPACE + '\\' + crumbs.slice(0, i + 1).join('\\');
          return (
            <React.Fragment key={i}>
              <ChevronRight size={10} color="#475569" />
              <button onClick={() => loadDir(path)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '11px' }}>{crumb}</button>
            </React.Fragment>
          );
        })}
      </div>

      {uploadStatus && (
        <div style={{ padding: '8px 12px', background: uploadStatus.startsWith('✅') ? 'rgba(0,255,64,0.1)' : uploadStatus.startsWith('❌') ? 'rgba(255,68,102,0.1)' : themeBg, border: `1px solid ${uploadStatus.startsWith('✅') ? 'rgba(0,255,64,0.3)' : uploadStatus.startsWith('❌') ? 'rgba(255,68,102,0.3)' : themeColor}`, borderRadius: '6px', fontSize: '11px', color: '#f8fafc', marginBottom: '12px' }}>
          {uploadStatus}
        </div>
      )}

      {/* File List */}
      <div ref={dropRef} onDragOver={e => { e.preventDefault(); setIsDragOver(true); }} onDragLeave={e => { e.preventDefault(); setIsDragOver(false); }} onDrop={handleDrop} style={{ flex: 1, overflowY: 'auto', background: isDragOver ? themeBg : 'transparent', border: isDragOver ? `2px dashed ${themeColor}` : '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '8px', transition: 'all 0.2s', position: 'relative' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100px' }}><RefreshCw size={20} className="animate-spin" color={themeColor} /></div>
        ) : entries.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100px', gap: '8px' }}>
            <div style={{ color: '#64748b', fontSize: '12px' }}>Empty folder</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {entries.map((entry, i) => (
              <div key={i} onClick={() => handleFileClick(entry)} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', transition: 'background 0.15s' }} onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ fontSize: '16px', width: '24px', textAlign: 'center' }}>{entry.type === 'dir' ? '📁' : getFileIcon(entry.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: '12px', fontWeight: entry.type === 'dir' ? 600 : 400, color: entry.type === 'dir' ? themeColor : '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</div></div>
                {entry.size != null && <span style={{ fontSize: '10px', color: '#475569', whiteSpace: 'nowrap' }}>{formatSize(entry.size)}</span>}
                {entry.type === 'file' && (
                  <div style={{ display: 'flex', gap: '2px' }} onClick={e => e.stopPropagation()}>
                    <button onClick={(e) => handleDownload(e, entry)} aria-label={`Download ${entry.name}`} title="Download" style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', padding: '2px', display: 'flex' }}><Download size={12} /></button>
                    {(mode === 'cloud' || !fsLocked) && (
                      <button onClick={(e) => handleDelete(e, entry)} aria-label={`Delete ${entry.name}`} title="Delete" style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '2px', display: 'flex' }}><Trash2 size={12} /></button>
                    )}
                  </div>
                )}
                {entry.type === 'dir' && <ChevronRight size={12} color="#475569" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function FileManager() {
  const [viewMode, setViewMode] = useState(IS_LOCAL_ENV ? 'local' : 'cloud'); // 'local', 'cloud', 'dual'
  
  const [previewUrl, setPreviewUrl]   = useState(null);
  const [previewName, setPreviewName] = useState('');
  const [previewMode, setPreviewMode] = useState('cloud');
  const [editContent, setEditContent] = useState(null);
  const [editPath, setEditPath]       = useState(null);
  const [saveStatus, setSaveStatus]   = useState('');

  const handlePreview = (url, name, mode) => { setPreviewUrl(url); setPreviewName(name); setPreviewMode(mode); };
  const handleEdit = (content, path, name) => { setEditContent(content); setEditPath(path); setPreviewName(name); };

  const handleLocalSave = async () => {
    try {
      setSaveStatus('Saving...');
      const res = await fetch(`${LOCAL_API}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: editPath, content: editContent }) });
      if (!res.ok) throw new Error(await res.text());
      setSaveStatus('✅ Saved!');
      setTimeout(() => { setSaveStatus(''); setEditContent(null); }, 1500);
    } catch (e) { alert('Save failed: ' + e.message); }
  };

  return (
    <div style={{ padding: '30px', color: '#f8fafc', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '20px' }}>
            <Folder size={24} color="#64748b" /> FILE MANAGER
          </h2>
          <p style={{ color: '#64748b', fontSize: '13px', margin: '5px 0 0 0' }}>Manage your Local OS and Cloud storage</p>
        </div>

        {IS_LOCAL_ENV && (
          <div style={{ display: 'flex', background: '#090d16', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <button onClick={() => setViewMode('local')} aria-label="Show local files only" aria-pressed={viewMode === 'local'} style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 'bold', border: 'none', cursor: 'pointer', background: viewMode === 'local' ? 'rgba(0,242,255,0.15)' : 'transparent', color: viewMode === 'local' ? '#00f2ff' : '#64748b', transition: 'all 0.2s' }}>
              <Monitor size={14} /> LOCAL
            </button>
            <button onClick={() => setViewMode('cloud')} aria-label="Show cloud files only" aria-pressed={viewMode === 'cloud'} style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 'bold', border: 'none', cursor: 'pointer', background: viewMode === 'cloud' ? 'rgba(62,207,142,0.15)' : 'transparent', color: viewMode === 'cloud' ? '#3ECF8E' : '#64748b', transition: 'all 0.2s' }}>
              <Cloud size={14} /> CLOUD
            </button>
            <button onClick={() => setViewMode('dual')} aria-label="Show local and cloud side by side" aria-pressed={viewMode === 'dual'} style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 'bold', border: 'none', cursor: 'pointer', background: viewMode === 'dual' ? 'rgba(255,255,255,0.1)' : 'transparent', color: viewMode === 'dual' ? '#fff' : '#64748b', transition: 'all 0.2s' }}>
              <Columns size={14} /> DUAL VIEW
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', gap: '20px', minHeight: 0 }}>
        {(viewMode === 'local' || viewMode === 'dual') && (
          <FilePane mode="local" onPreview={handlePreview} onEdit={handleEdit} />
        )}
        {(viewMode === 'cloud' || viewMode === 'dual') && (
          <FilePane mode="cloud" onPreview={handlePreview} onEdit={handleEdit} />
        )}
      </div>

      {/* PREVIEW MODAL */}
      {previewUrl && (
        <ModalPortal ariaLabel={`Preview file: ${previewName}`} onEscape={() => setPreviewUrl(null)}>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', backdropFilter: 'blur(8px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '92%', maxWidth: '1100px', marginBottom: '16px' }}>
              <div style={{ color: previewMode === 'cloud' ? '#3ECF8E' : '#00f2ff', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={18} /> {previewName}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => window.open(previewUrl, '_blank')} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>Open Full</button>
                <button onClick={() => setPreviewUrl(null)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600 }}><X size={16} /> Close</button>
              </div>
            </div>
            {previewName.match(/\.(png|jpg|jpeg|gif|svg)$/i) ? (
              <img src={previewUrl} alt={previewName} style={{ maxWidth: '92%', maxHeight: '80vh', borderRadius: '12px', objectFit: 'contain', border: '1px solid rgba(255,255,255,0.1)' }} />
            ) : (
              <iframe src={previewUrl} style={{ width: '92%', maxWidth: '1100px', height: '82vh', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', background: '#fff' }} title="Viewer" />
            )}
          </div>
        </ModalPortal>
      )}

      {/* TEXT EDITOR MODAL */}
      {editContent !== null && (
        <ModalPortal ariaLabel={`Edit file: ${previewName}`} onEscape={() => setEditContent(null)}>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}>
            <div style={{ width: '90%', maxWidth: '1000px', display: 'flex', flexDirection: 'column', height: '85vh', background: '#0a0a0f', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ color: '#00f2ff', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}><FileText size={18} /> {previewName} {saveStatus && <span style={{ color: '#3ECF8E', marginLeft: '10px' }}>{saveStatus}</span>}</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={handleLocalSave} style={{ background: '#00f2ff', color: '#000', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}><Save size={16} /> Save</button>
                  <button onClick={() => setEditContent(null)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
              <textarea value={editContent} onChange={e => setEditContent(e.target.value)} spellCheck="false" aria-label={`Edit file: ${previewName}`} onFocus={e => { e.currentTarget.style.boxShadow = 'inset 0 0 0 2px #00f2ff40'; }} onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }} style={{ flex: 1, width: '100%', background: 'transparent', border: 'none', color: '#e4e4e7', padding: '16px', fontFamily: 'monospace', fontSize: '14px', resize: 'none', outline: 'none' }} />
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
