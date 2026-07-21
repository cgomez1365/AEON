import React, { useState } from 'react';

const EditorMode = ({ nodeId, initialContent, onSave, onCancel }) => {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('Saving...');
    try {
      // Overwrites the file on disk and re-embeds it in the Vault index —
      // see the PUT /crn/second-brain/ingest/document handler in ingest.cjs.
      // (POST on that same route is create-only and never clobbers existing
      // files, so Edit Mode needs its own explicit "update" verb.)
      const response = await fetch('/api/crn/second-brain/ingest/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: nodeId, content })
      });
      let data = null;
      try { data = await response.json(); } catch { /* empty/non-JSON body */ }
      if (response.ok && data?.ok) {
        setSaveStatus('✅ Saved to Vault');
        setTimeout(() => setSaveStatus(''), 3000);
        if (onSave) onSave(content);
      } else {
        setSaveStatus('❌ Error: ' + (data?.error || `Server error (${response.status})`));
      }
    } catch (e) {
      setSaveStatus('❌ Network error: ' + e.message);
    }
    setIsSaving(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <button 
          onClick={handleSave} 
          disabled={isSaving}
          style={{
            padding: '8px 16px',
            background: '#FFD700',
            color: '#000',
            border: 'none',
            borderRadius: '4px',
            cursor: isSaving ? 'not-allowed' : 'pointer',
            fontWeight: 'bold'
          }}
        >
          {isSaving ? 'Saving...' : '💾 Save'}
        </button>
        <span style={{ color: '#FFD700', alignSelf: 'center' }}>{saveStatus}</span>
        <button 
          onClick={onCancel}
          style={{
            padding: '8px 16px',
            background: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Close Editor
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Document content editor"
        className="input"
        style={{
          flex: 1,
          width: '100%',
          background: '#111',
          color: '#E0E0E0',
          border: '1px solid #333',
          padding: '15px',
          fontFamily: 'monospace',
          fontSize: '0.95rem',
          lineHeight: '1.6',
          resize: 'none',
          outline: 'none'
        }}
      />
    </div>
  );
};

export default EditorMode;
