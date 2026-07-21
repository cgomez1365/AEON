import React, { useState } from 'react';
import { Send, Plus, Brain, Search } from 'lucide-react';

const NoteEditor = ({ onAddNote }) => {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    onAddNote({ title, content });
    setTitle('');
    setContent('');
  };

  return (
    <div className="glass card">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <Brain color="#00f2ff" size={24} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--accent-color)' }}>Synapse Node</h2>
      </div>
      <input
        className="note-input"
        placeholder="Thought Title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ marginBottom: '10px' }}
      />
      <textarea
        className="note-input"
        placeholder="What's on your mind? Connect the dots..."
        rows={5}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <button className="neon-button" onClick={handleSubmit} style={{ marginTop: '10px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        <Plus size={18} /> Fire Synapse
      </button>
    </div>
  );
};

export default NoteEditor;
