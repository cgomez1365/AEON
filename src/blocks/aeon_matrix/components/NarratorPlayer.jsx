import React, { useState, useEffect, useRef } from 'react';

const THEMES = {
  classic: { name: 'Classic', bg: '#faf7f2', text: '#2c2418', primary: '#b85c38', panelBg: '#f3ede3', panelBorder: '#e2d9cc', muted: '#7a6e5f' },
  night: { name: 'Night Mode', bg: '#141210', text: '#e8dfd0', primary: '#d4795a', panelBg: '#1c1916', panelBorder: '#2e2924', muted: '#8a7f6e' },
  sepia: { name: 'Sepia', bg: '#f4ecd8', text: '#433422', primary: '#8b5a2b', panelBg: '#e9ddc3', panelBorder: '#d4c5a9', muted: '#6a5a48' },
  cyberpunk: { name: 'Cyberpunk', bg: '#0b0f19', text: '#00ffcc', primary: '#ff00ff', panelBg: '#111827', panelBorder: '#374151', muted: '#4b5563' }
};

const NarratorPlayer = ({ nodeId, content, onClose }) => {
  const [sentences, setSentences] = useState([]);
  const [wordsCount, setWordsCount] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(null);
  const [speed, setSpeed] = useState(1.0);
  
  // New Features
  const [theme, setTheme] = useState('classic');
  const [focusMode, setFocusMode] = useState(false);
  
  const synth = window.speechSynthesis;
  const contentRef = useRef(null);
  // Chrome drops readings two ways: it garbage-collects utterances whose only
  // reference is inside speak() (onend never fires, playback silently stops),
  // and it auto-pauses the engine mid-speech on long sentences / network
  // voices. Hold the live utterance here and run a resume() watchdog below.
  const utterRef = useRef(null);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const voiceRef = useRef(null);
  const sentencesRef = useRef([]);
  const idxRef = useRef(0);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { voiceRef.current = selectedVoice; }, [selectedVoice]);
  useEffect(() => { sentencesRef.current = sentences; }, [sentences]);
  useEffect(() => { idxRef.current = currentIdx; }, [currentIdx]);

  // Split text into sentences and calculate stats
  useEffect(() => {
    if (!content) return;
    const text = String(content).replace(/\s+/g, ' ');
    const sents = text.match(/[^.!?]+[.!?]+/g) || [text];
    const cleanSents = sents.map(s => s.trim()).filter(s => s.length > 0);
    setSentences(cleanSents);
    setWordsCount(text.split(/\s+/).length);
    
    // Fetch state from Supabase
    fetch(`/api/narrator/state?nodeId=${encodeURIComponent(nodeId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.state && data.state.currentIdx) {
          setCurrentIdx(Math.min(data.state.currentIdx, cleanSents.length - 1));
          setStatus('Restored progress.');
        } else {
          setStatus('Ready to play.');
        }
      })
      .catch(() => setStatus('Ready to play.')); // state save is optional — never block playback on it

    // Load voices
    const loadVoices = () => {
      const v = synth.getVoices();
      setVoices(v);
      if (v.length > 0) {
        const ukVoice = v.find(voice => voice.name.includes('UK English Female') || voice.lang === 'en-GB' && voice.name.includes('Female'));
        const gbVoice = v.find(voice => voice.lang === 'en-GB');
        setSelectedVoice(ukVoice || gbVoice || v.find(voice => voice.default) || v[0]);
      }
    };
    if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;
    loadVoices();
    
    return () => synth.cancel();
  }, [content, nodeId]);

  const saveState = (idx) => {
    fetch('/api/narrator/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, state: { currentIdx: idx } })
    }).catch(e => console.error(e));
  };

  const playSentence = (idx) => {
    const sents = sentencesRef.current;
    if (idx < 0 || idx >= sents.length) {
      setIsPlaying(false);
      playingRef.current = false;
      saveState(Math.max(0, sents.length - 1));
      setStatus(idx >= sents.length ? 'Finished.' : 'Ready to play.');
      return;
    }
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(sents[idx]);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = speedRef.current;

    utterance.onend = () => {
      if (utterRef.current !== utterance) return; // superseded by a skip/seek
      setTimeout(() => {
        if (playingRef.current && utterRef.current === utterance) {
          const nextIdx = idx + 1;
          setCurrentIdx(nextIdx);
          saveState(nextIdx);
          playSentence(nextIdx);
        }
      }, 50);
    };

    utterance.onerror = (e) => {
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      console.error('Speech error:', e);
      // Don't kill the whole reading over one bad sentence — skip it.
      if (playingRef.current && utterRef.current === utterance) {
        const nextIdx = idx + 1;
        setCurrentIdx(nextIdx);
        playSentence(nextIdx);
      }
    };

    utterRef.current = utterance; // pin against GC — the silent-stop bug
    synth.speak(utterance);
    setCurrentIdx(idx);
  };

  const togglePlay = () => {
    if (playingRef.current) {
      playingRef.current = false;
      synth.cancel();
      setIsPlaying(false);
      saveState(idxRef.current);
      setStatus('Paused.');
    } else {
      playingRef.current = true;
      setIsPlaying(true);
      setStatus('Playing...');
      playSentence(idxRef.current);
    }
  };

  // Chrome auto-pause watchdog: the engine silently flips to paused mid-read
  // (esp. Google network voices) and never resumes on its own.
  useEffect(() => {
    if (!isPlaying) return;
    const tick = setInterval(() => {
      if (playingRef.current && synth.paused) synth.resume();
    }, 3000);
    return () => clearInterval(tick);
  }, [isPlaying]);

  // Save the reading position on unmount too (closing mid-read used to lose
  // up to 5 sentences of progress).
  useEffect(() => () => { if (playingRef.current) saveState(idxRef.current); playingRef.current = false; }, []);

  const skipForward = () => {
    const newIdx = Math.min(currentIdx + 1, sentences.length - 1);
    setCurrentIdx(newIdx);
    if (isPlaying) playSentence(newIdx);
  };

  const skipBackward = () => {
    const newIdx = Math.max(currentIdx - 1, 0);
    setCurrentIdx(newIdx);
    if (isPlaying) playSentence(newIdx);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && !['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        skipForward();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        skipBackward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentIdx, sentences, selectedVoice, speed]);
  
  useEffect(() => {
    if (isPlaying && contentRef.current) {
        const el = contentRef.current.children[currentIdx];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentIdx, isPlaying]);

  const currentTheme = THEMES[theme];
  const estMinutes = Math.max(1, Math.ceil(wordsCount / (200 * speed)));

  return (
    <div style={{ 
      display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', overflow: 'hidden',
      background: currentTheme.bg, color: currentTheme.text, 
      fontFamily: '"Lora", serif', transition: 'all 0.3s ease' 
    }}>
      
      {/* Top Nav / Settings Bar */}
      <div style={{ 
        flexShrink: 0,
        padding: '10px 20px', background: currentTheme.panelBg, borderBottom: `1px solid ${currentTheme.panelBorder}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px'
      }}>
        <div style={{ display: 'flex', gap: '15px', fontSize: '0.8rem', color: currentTheme.muted }}>
            <span title="Word Count">📝 {wordsCount} Words</span>
            <span title="Sentences">🔤 {sentences.length} Sentences</span>
            <span title="Estimated Read Time">⏱️ ~{estMinutes} min</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button 
                onClick={() => setFocusMode(!focusMode)}
                style={{ background: focusMode ? currentTheme.primary : 'transparent', color: focusMode ? '#fff' : currentTheme.muted, border: `1px solid ${currentTheme.panelBorder}`, padding: '4px 10px', borderRadius: '15px', fontSize: '0.8rem', cursor: 'pointer', transition: 'all 0.2s' }}
            >
                🎯 Focus Mode
            </button>
            <button 
                onClick={() => setTheme(theme === 'classic' ? 'night' : 'classic')}
                style={{ background: 'transparent', color: currentTheme.muted, border: `1px solid ${currentTheme.panelBorder}`, padding: '4px 10px', borderRadius: '15px', fontSize: '0.8rem', cursor: 'pointer' }}
            >
                {theme === 'classic' || theme === 'sepia' ? '🌙 Night Mode' : '☀️ Day Mode'}
            </button>
            <select
                value={theme} onChange={(e) => setTheme(e.target.value)}
                aria-label="Reading theme"
                className="input"
                style={{ background: currentTheme.panelBg, color: currentTheme.text, border: `1px solid ${currentTheme.panelBorder}`, padding: '4px 8px', borderRadius: '4px', fontSize: '0.8rem', outline: 'none' }}
            >
                {Object.keys(THEMES).map(t => <option key={t} value={t}>{THEMES[t].name}</option>)}
            </select>
        </div>
      </div>
      
      {/* Player Controls (Moved up from bottom) */}
      <div style={{ 
        flexShrink: 0,
        padding: '10px 20px', 
        background: currentTheme.panelBg, 
        borderBottom: `1px solid ${currentTheme.panelBorder}`,
        boxShadow: `0 5px 15px rgba(0,0,0, ${theme === 'classic' ? '0.03' : '0.2'})`,
        display: 'flex', alignItems: 'center', gap: '15px', zIndex: 200, flexWrap: 'wrap'
      }}>
        {/* Playback Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={skipBackward} aria-label="Previous sentence" style={{ background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: currentTheme.muted }}>⏮</button>
            <button
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            aria-pressed={isPlaying}
            style={{
                width: '40px', height: '40px', borderRadius: '50%',
                background: currentTheme.primary, color: '#fff', border: 'none',
                fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 10px rgba(0,0,0,0.2)'
            }}
            >
            {isPlaying ? '⏸' : '▶'}
            </button>
            <button onClick={skipForward} aria-label="Next sentence" style={{ background: 'transparent', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: currentTheme.muted }}>⏭</button>
        </div>
        
        {/* Progress & Speed */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <div style={{ fontSize: '0.8rem', color: currentTheme.primary, fontWeight: 'bold' }}>
            {isPlaying ? 'PLAYING...' : 'READY TO PLAY'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
            <input
                type="range"
                min="0" max={sentences.length - 1}
                value={currentIdx}
                onChange={(e) => {
                setCurrentIdx(parseInt(e.target.value));
                if (isPlaying) playSentence(parseInt(e.target.value));
                }}
                aria-label="Reading progress"
                aria-valuetext={`Sentence ${currentIdx + 1} of ${sentences.length}`}
                style={{ flex: 1, accentColor: currentTheme.primary }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.8rem' }}>
                <span title="Reading Speed" style={{ color: currentTheme.muted }}>⚡</span>
                <input
                type="range" min="0.5" max="2" step="0.1" value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                aria-label="Reading speed"
                style={{ width: '60px', accentColor: currentTheme.primary }}
                />
                <span style={{ color: currentTheme.muted, minWidth: '35px' }}>{speed}x</span>
            </div>

            <select
                value={selectedVoice ? selectedVoice.name : ''} onChange={(e) => setSelectedVoice(voices.find(v => v.name === e.target.value))}
                aria-label="Narration voice"
                className="input"
                style={{
                background: 'transparent', color: currentTheme.muted, border: `1px solid ${currentTheme.panelBorder}`,
                padding: '2px 5px', borderRadius: '4px', fontSize: '0.8rem', outline: 'none', maxWidth: '150px'
                }}
            >
                <option value="">Default Voice</option>
                {voices.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
            </div>
        </div>
      </div>
      
      {/* Content Area */}
      <div ref={contentRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: window.innerWidth < 768 ? '20px' : '40px', fontSize: focusMode ? '1.5rem' : '1.2rem', lineHeight: '1.8' }}>
        {sentences.map((s, i) => {
          const isActive = i === currentIdx;
          const isBlurred = focusMode && !isActive;
          return (
            <span 
                key={i} 
                onClick={() => {
                setCurrentIdx(i);
                if (isPlaying) playSentence(i);
                }}
                style={{
                padding: '2px 5px',
                borderRadius: '4px',
                cursor: 'pointer',
                background: isActive ? `${currentTheme.primary}33` : 'transparent',
                color: isActive ? currentTheme.primary : currentTheme.text,
                opacity: isBlurred ? 0.2 : 1,
                filter: isBlurred ? 'blur(1px)' : 'none',
                transition: 'all 0.3s',
                marginRight: '5px',
                display: 'inline-block'
                }}
            >
                {s}
            </span>
          )
        })}
      </div>
    </div>
  );
};

export default NarratorPlayer;
