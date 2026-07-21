export const AUDIO_THEMES = [
  { id: 'lofi_chill', name: '☕ Lofi Chill (Procedural)' },
  { id: 'lofi_upbeat', name: '☀️ Lofi Upbeat (Procedural)' },
  { id: 'lofi_melancholic', name: '🌧️ Lofi Melancholic (Procedural)' },
  { id: 'lofi_jazz', name: '🎷 Lofi Jazz (Procedural)' },
  { id: 'lofi_study', name: '📚 Lofi Deep Study (Procedural)' },
  { id: 'dark_ambient', name: 'Dark Ambient Drone' },
  { id: 'ethereal', name: 'Ethereal Cosmic Choirs' },
  { id: 'binaural', name: 'Binaural Delta Waves' },
  { id: 'cyberpunk', name: 'Cyberpunk Bass Pulse' },
  { id: 'soft_piano', name: '🎹 Soft Math Piano' },
  { id: 'silence', name: 'No Music (Silence)' }
];

export function playAudio(themeId, audioCtxRef, analyserRef, destNodeRef, sourceNodeRef, setIsPlayingTheme) {
  // First, stop existing audio
  if (sourceNodeRef.current) {
    try { sourceNodeRef.current.stop(); } catch(e){}
    sourceNodeRef.current.disconnect();
    sourceNodeRef.current = null;
  }
  setIsPlayingTheme(false);

  if (themeId === 'silence') return;

  if (!audioCtxRef.current) {
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
  }
  const ctx = audioCtxRef.current;
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  if (!analyserRef.current) {
    analyserRef.current = ctx.createAnalyser();
    analyserRef.current.fftSize = 256;
  }

  if (!destNodeRef.current) {
    destNodeRef.current = ctx.createMediaStreamDestination();
  }

  ctx.activeThemeId = themeId;

  // Load real audio file if it is an ingested track (ends in .mp3, .wav, or .m4a)
  if (themeId.endsWith('.mp3') || themeId.endsWith('.wav') || themeId.endsWith('.m4a')) {
    const audioUrl = `/music/${themeId}`;
    fetch(audioUrl)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.arrayBuffer();
      })
      .then(arrayBuffer => ctx.decodeAudioData(arrayBuffer))
      .then(audioBuffer => {
        if (ctx.activeThemeId !== themeId) return;
        
        const bufferSource = ctx.createBufferSource();
        bufferSource.buffer = audioBuffer;
        bufferSource.loop = true;

        bufferSource.connect(analyserRef.current);
        bufferSource.connect(destNodeRef.current);
        analyserRef.current.connect(ctx.destination);

        bufferSource.start();
        sourceNodeRef.current = bufferSource;
        setIsPlayingTheme(true);
      })
      .catch(err => console.error('[AEON AUDIO] Ingested track play failed:', err.message));
    return;
  }

  const sampleRate = ctx.sampleRate;
  const duration = 120; // 2 minutes procedural generation buffer
  const buffer = ctx.createBuffer(1, sampleRate * duration, sampleRate);
  const channelData = buffer.getChannelData(0);

  const PI = Math.PI;
  const mod = (a, b) => a - b * Math.floor(a / b);

  // ---------------------------------------------------------
  // LOFI PROCEDURAL PARAMETERS (Randomized every time)
  // ---------------------------------------------------------
  
  // Randomize BPM slightly between 70 and 90 for general Lofi
  const isUpbeat = themeId === 'lofi_upbeat';
  const isMelancholic = themeId === 'lofi_melancholic';
  const isJazz = themeId === 'lofi_jazz';
  
  const baseBPM = isUpbeat ? (85 + Math.random()*15) : 
                  isMelancholic ? (65 + Math.random()*10) : 
                  isJazz ? (75 + Math.random()*20) : (70 + Math.random()*15); // Chill / Study
  
  const bps = baseBPM / 60;
  const beatDuration = 1 / bps;
  const barDuration = beatDuration * 4;

  // Randomize Chords based on mood
  const majorChords = [
    [130.81, 164.81, 196.00, 246.94], // Cmaj7
    [146.83, 174.61, 220.00, 261.63], // Dmin7
    [164.81, 196.00, 246.94, 293.66], // Emin7
    [174.61, 220.00, 261.63, 329.63]  // Fmaj7
  ];
  
  const minorChords = [
    [110.00, 130.81, 164.81, 196.00], // Amin7
    [146.83, 174.61, 220.00, 261.63], // Dmin7
    [164.81, 196.00, 246.94, 293.66], // Emin7
    [130.81, 164.81, 196.00, 246.94]  // Cmaj7
  ];

  const jazzChords = [
    [155.56, 196.00, 233.08, 277.18], // Ebmaj7
    [146.83, 174.61, 220.00, 261.63], // Dmin7
    [196.00, 246.94, 293.66, 349.23], // G7
    [130.81, 164.81, 196.00, 246.94]  // Cmaj7
  ];

  const activeChords = isMelancholic ? minorChords : isJazz ? jazzChords : majorChords;
  
  // Randomize melody instrument
  const hasMelody = Math.random() > 0.3; // 70% chance to have a distinct melody
  const melodyOctaveMultiplier = Math.random() > 0.5 ? 2.0 : 4.0;
  
  // Vinyl Crackle Intensity
  const crackleLevel = 0.02 + Math.random() * 0.05;

  for (let i = 0; i < channelData.length; i++) {
    const t = i / sampleRate;
    let val = 0;

    if (themeId.startsWith('lofi')) {
      // 1. Vinyl Crackle
      const crackle = (Math.random() - 0.5) * crackleLevel * (Math.random() > 0.99 ? 1.0 : 0.08);

      // 2. Drums (Kick, Snare, Hi-hat)
      const beatInBar = mod(t, barDuration) / beatDuration; // 0 to 4
      
      // Kick: On beats 1 and sometimes roughly 2.5 or 3.5
      const kickEnv1 = Math.exp(-15 * mod(t, barDuration)); // Beat 1
      const kickEnv2 = Math.exp(-15 * mod(t - beatDuration * 2.5, barDuration)); // Syncopated
      const kickTrigger = kickEnv1 + (Math.random() > 0.5 ? kickEnv2 : 0);
      const kick = Math.sin(2 * PI * (50 * Math.exp(-20*mod(t, barDuration/8)))) * 0.4 * kickTrigger; // Pitch drop

      // Snare: On beats 2 and 4
      const snareTrigger1 = Math.exp(-20 * mod(t - beatDuration, barDuration));
      const snareTrigger2 = Math.exp(-20 * mod(t - beatDuration * 3, barDuration));
      const snareNoise = (Math.random() - 0.5) * 0.25 * (snareTrigger1 + snareTrigger2);
      const snareTone = Math.sin(2 * PI * 180 * t) * 0.1 * (snareTrigger1 + snareTrigger2);
      const snare = snareNoise + snareTone;

      // Hi-hat: 8th notes
      const hatTrigger = Math.exp(-30 * mod(t, beatDuration / 2));
      const hat = (Math.random() - 0.5) * 0.08 * hatTrigger;

      // 3. Chords (Rhodes / E-Piano style)
      // Change chord every bar (or every 2 bars)
      const chordChangeRate = Math.random() > 0.5 ? barDuration : barDuration * 2;
      const chordIdx = Math.floor(t / chordChangeRate) % activeChords.length;
      const freqs = activeChords[chordIdx];
      
      let synthChords = 0;
      // Soft attack, medium decay envelope for chords
      const chordEnv = (t % chordChangeRate) < 0.5 ? (t % chordChangeRate)*2 : Math.exp(-0.5 * ((t % chordChangeRate) - 0.5));
      
      freqs.forEach((f) => {
        // Add slight detune for warmth
        synthChords += Math.sin(2 * PI * f * t) * 0.06;
        synthChords += Math.sin(2 * PI * (f * 1.005) * t) * 0.03;
      });
      // Tremolo effect
      synthChords *= (0.8 + 0.2 * Math.sin(2 * PI * t * (bps * 2)));
      synthChords *= chordEnv;

      // 4. Bassline (Follows chord root)
      const rootFreq = freqs[0] / 2; // Drop an octave
      // Bass plays on beat 1, and maybe 3.5
      const bassEnv = kickTrigger; // Follow kick pattern loosely
      const bass = Math.sin(2 * PI * rootFreq * t) * 0.3 * bassEnv;

      // 5. Melody (Sparse pentatonic notes)
      let melody = 0;
      if (hasMelody) {
        // Play a note every few beats randomly
        if (Math.floor(t * bps * 2) % 3 === 0) { 
           const noteIdx = Math.floor(t * bps * 0.5) % freqs.length;
           const noteFreq = freqs[noteIdx] * melodyOctaveMultiplier;
           const melEnv = Math.exp(-2 * mod(t, beatDuration * 1.5));
           melody = Math.sin(2 * PI * noteFreq * t) * 0.05 * melEnv;
        }
      }

      val = kick + snare + hat + synthChords + bass + melody + crackle;
      
    } else if (themeId === 'dark_ambient') {
      val = 
        Math.sin(2 * PI * t * (220 + 73 * Math.floor(mod(t / 8, 3)))) * 0.15 * (0.5 + 0.5 * Math.sin(2 * PI * t / 8)) +
        Math.sin(2 * PI * 55 * t) * 0.4 * Math.exp(-3 * mod(t, 2)) +
        Math.sin(2 * PI * 880 * t) * 0.03 * (0.5 + 0.5 * Math.sin(2 * PI * t / 16)) +
        Math.sin(2 * PI * t * (330 + 50 * Math.sin(2 * PI * t / 32))) * 0.08;
    } else if (themeId === 'ethereal') {
      const step = Math.floor(t * 2) % 4;
      const freq = step === 0 ? 528 : step === 1 ? 396 : step === 2 ? 639 : step === 3 ? 741 : 528;
      val =
        Math.sin(2 * PI * t * freq) * 0.12 * (0.8 + 0.2 * Math.sin(2 * PI * t * 3)) +
        Math.sin(2 * PI * 264 * t * (1 + 0.003 * Math.sin(2 * PI * t * 5))) * 0.15 * (0.5 + 0.5 * Math.sin(2 * PI * t / 12)) +
        Math.sin(2 * PI * 1056 * t) * 0.02 * (0.3 + 0.7 * Math.sin(2 * PI * t / 6)) +
        Math.sin(2 * PI * 396 * t) * 0.08 * Math.exp(-2 * mod(t, 4));
    } else if (themeId === 'binaural') {
      val = 
        Math.sin(2 * PI * 200 * t) * 0.4 +
        Math.sin(2 * PI * 100 * t) * 0.12 * (0.5 + 0.5 * Math.sin(2 * PI * t / 16)) +
        Math.sin(2 * PI * 204 * t) * 0.4 +
        Math.sin(2 * PI * 102 * t) * 0.12 * (0.5 + 0.5 * Math.sin(2 * PI * t / 16)) +
        Math.sin(2 * PI * 300 * t) * 0.04 * Math.exp(-1.5 * mod(t, 8));
    } else if (themeId === 'cyberpunk') {
      const step4 = Math.floor(t * 4) % 4;
      const freq4 = step4 === 0 ? 65 : step4 === 1 ? 77 : step4 === 2 ? 98 : step4 === 3 ? 116 : 65;
      val =
        Math.sin(2 * PI * 60 * t) * 0.5 * Math.exp(-8 * mod(t, 0.5)) +
        Math.sin(2 * PI * t * freq4) * 0.25 * (0.3 + 0.7 * Math.exp(-3 * mod(t, 0.25))) +
        Math.sin(2 * PI * 8000 * t) * 0.04 * Math.exp(-30 * mod(t + 0.25, 0.5)) +
        Math.sin(2 * PI * 260 * t) * 0.15 * Math.exp(-5 * mod(t, 1)) * (1 + 0.5 * Math.sin(2 * PI * t * 20));
    } else if (themeId === 'soft_piano') {
      const chordRoots = [130.81, 146.83, 164.81, 174.61]; 
      const root = chordRoots[Math.floor(t / 8) % chordRoots.length];
      const noteIdx = Math.floor(t * 1.5) % 4;
      const noteFreq = root * [1.0, 1.25, 1.5, 1.875][noteIdx];
      const noteTrigger = Math.exp(-3.0 * mod(t, 1 / 1.5));
      const note = Math.sin(2 * PI * noteFreq * t) * noteTrigger * 0.18;
      const drone = Math.sin(2 * PI * (root / 2) * t) * 0.1;
      val = note + drone;
    }

    channelData[i] = Math.max(-0.95, Math.min(0.95, val));
  }

  const bufferSource = ctx.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.loop = true;

  bufferSource.connect(analyserRef.current);
  bufferSource.connect(destNodeRef.current);
  analyserRef.current.connect(ctx.destination);

  bufferSource.start();
  sourceNodeRef.current = bufferSource;
  setIsPlayingTheme(true);
}
