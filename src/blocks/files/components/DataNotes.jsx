import React, { useState, useEffect } from 'react';
import { FileText, Save, Plus, RefreshCw, Trash2, Edit } from 'lucide-react';
import { AGENTS_DIR } from '../../../config.js';

const NOTE_FILES = [
  { id: 'daily', name: 'Daily Notes.md', path: AGENTS_DIR + '\\Daily Notes.md' },
  { id: 'inbox', name: 'Inbox.md', path: AGENTS_DIR + '\\Inbox.md' },
  { id: 'master', name: 'Master List.md', path: AGENTS_DIR + '\\Master List.md' }
];

export default function DataNotes() {
  const [selectedFile, setSelectedFile] = useState(NOTE_FILES[0]);
  const [noteContent, setNoteContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const loadNote = async (file) => {
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/fs/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: file.path })
      });
      if (!res.ok) throw new Error('Failed to read note file');
      const data = await res.json();
      setNoteContent(data.content || '');
    } catch (err) {
      console.error(err);
      setNoteContent(`// Failed to load file from disk.\n// Make sure path exists:\n// ${file.path}`);
    } finally {
      setLoading(false);
    }
  };

  const saveNote = async () => {
    setSaving(true);
    setStatus('Saving...');
    try {
      const res = await fetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: selectedFile.path, content: noteContent })
      });
      if (!res.ok) throw new Error('Failed to write note file');
      setStatus('✅ Saved successfully!');
      
      // Post an audit log for transparency
      await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'SYSTEM',
          action: 'NOTE_SYNC',
          details: `Synchronized filesystem note: ${selectedFile.name}`
        })
      });
    } catch (err) {
      console.error(err);
      setStatus('❌ Failed to save note');
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(''), 3000);
    }
  };

  useEffect(() => {
    loadNote(selectedFile);
  }, [selectedFile]);

  return (
    <div style={{ padding: '30px', color: '#f8fafc', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#FFD700', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <FileText size={24} /> SECURE DATA NOTES
          </h2>
          <p style={{ color: '#64748b', fontSize: '13px', margin: '5px 0 0 0' }}>Direct Read/Write Integration to Local System Markdown Archives</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {status && <span style={{ fontSize: '12px', color: '#00ff40', fontFamily: 'monospace' }}>{status}</span>}
          <button 
            disabled={saving}
            onClick={saveNote}
            style={{ backgroundColor: '#FFD700', color: '#000', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
          >
            {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} Save Note (Sync to Disk)
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '24px', flex: 1, minHeight: 0 }}>
        {/* Left Side: Note File Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 'bold', letterSpacing: '1px' }}>MARKDOWN REPOSITORY</div>
          {NOTE_FILES.map(file => (
            <div 
              key={file.id}
              onClick={() => setSelectedFile(file)}
              style={{
                background: selectedFile.id === file.id ? 'rgba(255, 215, 0, 0.1)' : 'rgba(255,255,255,0.02)',
                border: selectedFile.id === file.id ? '1px solid #FFD700' : '1px solid rgba(255,255,255,0.05)',
                borderRadius: '12px', padding: '16px', cursor: 'pointer', transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', gap: '12px'
              }}
            >
              <FileText size={20} color={selectedFile.id === file.id ? '#FFD700' : '#64748b'} />
              <div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: selectedFile.id === file.id ? '#FFD700' : '#f8fafc' }}>{file.name}</div>
                <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>Local System</div>
              </div>
            </div>
          ))}
        </div>

        {/* Right Side: Code/Markdown Editor */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
              <RefreshCw size={32} className="animate-spin" color="#FFD700" />
            </div>
          ) : (
            <textarea
              value={noteContent}
              onChange={e => setNoteContent(e.target.value)}
              style={{
                flex: 1, width: '100%', padding: '20px', background: '#090d16',
                border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px',
                color: '#cbd5e1', fontFamily: "'Fira Code', monospace", fontSize: '13px',
                lineHeight: '1.6', outline: 'none', resize: 'none'
              }}
              placeholder="Start drafting or editing your secure notes..."
            />
          )}
        </div>
      </div>
    </div>
  );
}
