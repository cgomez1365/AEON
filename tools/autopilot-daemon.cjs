const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const isVercel = require('../src/kernel/runtime.cjs').isCloud();
const getLocalFile = (filename) => isVercel ? path.join('/tmp', filename) : path.join(__dirname, '..', filename);
const KERNEL_BASE = process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`;

const LEDGER_PATH = getLocalFile('autopilot_ledger.json');
const COMPONENTS_DIR = getLocalFile('public/media/components');
const MUSIC_DIR = getLocalFile('public/media/music');
const STAGING_DIR = getLocalFile('public/media/staging');

let daemonLoop = null;

const MAX_DAILY_UPLOADS = 5;

let state = {
  producerRunning: false,
  uploaderRunning: false,
  totalProduced: 0,
  totalUploaded: 0,
  batchProduced: 0,
  diskUsedGB: 0,
  diskQuotaGB: 100,
  todayUploads: 0,
  maxDailyUploads: MAX_DAILY_UPLOADS,
  lastUploadDate: '',
  status: 'IDLE',
  config: {
    batchSize: 50,
    cooldownMinutes: 5,
    diskQuotaGB: 100
  }
};

let ledger = {
  queue: [],
  history: []
};

function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    try {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      // Keep state in sync with ledger where possible
      state.totalProduced = (ledger.history || []).length + (ledger.queue || []).length;
      state.totalUploaded = (ledger.history || []).filter(i => i.status === 'uploaded').length;
    } catch(e) {}
  }
}

function saveLedger() {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function updateDiskUsage() {
  if (fs.existsSync(STAGING_DIR)) {
    const files = fs.readdirSync(STAGING_DIR);
    let size = 0;
    files.forEach(f => {
      const p = path.join(STAGING_DIR, f);
      if (fs.statSync(p).isFile()) size += fs.statSync(p).size;
    });
    state.diskUsedGB = parseFloat((size / (1024 * 1024 * 1024)).toFixed(2));
  } else {
    state.diskUsedGB = 0;
  }
}

function getRandomItems(arr, count) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function generateRandomVideo() {
  return new Promise((resolve, reject) => {
    state.status = 'ASSEMBLING';
    
    if (!fs.existsSync(COMPONENTS_DIR)) return reject(new Error('No components directory'));
    const components = fs.readdirSync(COMPONENTS_DIR).filter(f => f.endsWith('.mp4'));
    if (components.length === 0) return reject(new Error('No component blocks available.'));

    if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

    // Pick 2 to 4 random components
    const count = Math.floor(Math.random() * 3) + 2;
    const selectedComps = getRandomItems(components, Math.min(count, components.length));

    let selectedMusic = 'silence';
    if (fs.existsSync(MUSIC_DIR)) {
      const tracks = fs.readdirSync(MUSIC_DIR).filter(f => f.endsWith('.mp3'));
      if (tracks.length > 0) selectedMusic = tracks[Math.floor(Math.random() * tracks.length)];
    }

    const jobId = `auto_${Date.now()}`;
    const concatListPath = path.join(STAGING_DIR, `concat_${jobId}.txt`);
    const outputPath = path.join(STAGING_DIR, `assembled_${jobId}.mp4`);

    let concatTxt = '';
    selectedComps.forEach(comp => {
      concatTxt += `file '${path.join(COMPONENTS_DIR, comp).replace(/\\/g, '/')}'\n`;
    });
    fs.writeFileSync(concatListPath, concatTxt);

    let cmd = ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0']);

    if (selectedMusic !== 'silence') {
      const audioInput = path.join(MUSIC_DIR, selectedMusic);
      cmd = cmd.input(audioInput)
               .inputOptions(['-stream_loop', '-1'])
               .outputOptions([
                 '-c:v copy',
                 '-c:a aac',
                 '-map 0:v:0',
                 '-map 1:a:0',
                 '-shortest',
                 '-movflags +faststart'
               ]);
    } else {
      cmd = cmd.outputOptions([
        '-c copy',
        '-movflags +faststart'
      ]);
    }

    cmd.save(outputPath)
      .on('end', () => {
        try { fs.unlinkSync(concatListPath); } catch(e){}
        state.batchProduced++;
        state.totalProduced++;
        updateDiskUsage();
        
        const title = `Auto-Gen: ${selectedComps.map(c => c.split('.')[0]).join(' + ')}`;
        ledger.queue.push({
          id: jobId,
          status: 'queued',
          title,
          durationMinutes: 1,
          path: outputPath,
          ts: Date.now()
        });
        saveLedger();

        // Push a lightweight production record into Second Brain so the terminal
        // can recall what autopilot has produced (video files themselves aren't indexed).
        fetch(`${KERNEL_BASE}/api/crn/second-brain/ingest/document`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_path: `Autopilot_Log/${jobId}.md`,
            content: `# ${title}\n\nJob ID: ${jobId}\nProduced: ${new Date().toISOString()}\nComponents: ${selectedComps.join(', ')}\nMusic: ${selectedMusic}\nOutput: ${outputPath}`,
          }),
        }).catch(() => {}); // best-effort — never block production on indexing

        if (typeof global.broadcastTerminalEvent === 'function') {
          global.broadcastTerminalEvent('SYSTEM_METRIC', `[AUTOPILOT] Generated video ${jobId}`);
        }
        resolve(outputPath);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(concatListPath); } catch(e){}
        reject(err);
      });
  });
}

async function generateTitle(components) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return `AEON Holographic Render #${Date.now().toString().slice(-6)}`;
  try {
    const names = components.map(c => c.replace(/\.mp4$/i, '').replace(/[_-]/g, ' ')).join(', ');
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: `Generate a short catchy YouTube Shorts title (under 60 chars) for a 4K holographic ambient visual featuring: ${names}. Just the title, no quotes.` }],
        max_tokens: 30, temperature: 0.9,
      }),
    });
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '') || `AEON 4K Hologram #${Date.now().toString().slice(-6)}`;
  } catch { return `AEON 4K Holographic Render #${Date.now().toString().slice(-6)}`; }
}

async function processQueue() {
  const nextItem = ledger.queue.find(i => i.status === 'queued');
  if (!nextItem) return;

  state.status = 'UPLOADING';
  nextItem.status = 'uploading';
  saveLedger();

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  const today = new Date().toISOString().slice(0, 10);
  if (state.lastUploadDate !== today) { state.todayUploads = 0; state.lastUploadDate = today; }
  if (state.todayUploads >= MAX_DAILY_UPLOADS) {
    console.log(`[AUTOPILOT] Daily upload quota reached (${MAX_DAILY_UPLOADS}). Holding queue.`);
    nextItem.status = 'queued';
    saveLedger();
    state.status = 'QUOTA_HOLD';
    return;
  }

  if (!clientId || !clientSecret || !refreshToken || !fs.existsSync(nextItem.path)) {
    console.error('[AUTOPILOT] Missing YouTube creds or video file — skipping upload');
    nextItem.status = 'failed';
    nextItem.error = !fs.existsSync(nextItem.path) ? 'Video file missing' : 'YouTube credentials not configured';
    ledger.queue = ledger.queue.filter(i => i.id !== nextItem.id);
    ledger.history.unshift(nextItem);
    saveLedger();
    state.status = 'IDLE';
    return;
  }

  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const title = await generateTitle(nextItem.title ? [nextItem.title] : ['hologram']);
    const response = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title,
          description: `4K Holographic Ambient Visual\nGenerated by AEON Command Center\n\n#shorts #holographic #ambient #4k #aeon #generativeart`,
          tags: ['shorts', 'holographic', 'ambient', '4k', 'aeon', 'generative art', 'ASMR', 'relaxing'],
          categoryId: '28',
        },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      },
      media: { mimeType: 'video/mp4', body: fs.createReadStream(nextItem.path) },
    });

    nextItem.status = 'uploaded';
    nextItem.youtubeUrl = `https://youtu.be/${response.data.id}`;
    state.todayUploads++;
    console.log(`[AUTOPILOT] YouTube Upload #${state.todayUploads}/${MAX_DAILY_UPLOADS}: ${nextItem.youtubeUrl}`);
  } catch (err) {
    console.error('[AUTOPILOT] YouTube upload failed:', err.message);
    nextItem.status = 'failed';
    nextItem.error = err.message;
  }

  ledger.queue = ledger.queue.filter(i => i.id !== nextItem.id);
  ledger.history.unshift(nextItem);
  state.totalUploaded++;
  saveLedger();

  try { fs.unlinkSync(nextItem.path); } catch {}
  updateDiskUsage();

  if (typeof global.broadcastTerminalEvent === 'function') {
    global.broadcastTerminalEvent('SYSTEM_METRIC', `[AUTOPILOT] ${nextItem.status === 'uploaded' ? 'Uploaded' : 'Failed'}: ${nextItem.id}`);
  }
  state.status = 'IDLE';
}

async function daemonTick() {
  if (!state.producerRunning) return;

  if (state.batchProduced >= state.config.batchSize) {
    state.producerRunning = false;
    state.status = 'BATCH COMPLETE';
    if (typeof global.broadcastTerminalEvent === 'function') {
      global.broadcastTerminalEvent('SYSTEM_METRIC', `[AUTOPILOT] Batch of ${state.config.batchSize} complete.`);
    }
    return;
  }

  if (state.diskUsedGB >= state.config.diskQuotaGB) {
    state.producerRunning = false;
    state.status = 'DISK QUOTA REACHED';
    return;
  }

  try {
    if (state.status === 'IDLE') {
      await generateRandomVideo();
      const cooldownMs = state.config.cooldownMinutes * 60 * 1000;
      state.status = `COOLDOWN`;
      setTimeout(() => {
        if (state.producerRunning) {
          state.status = 'IDLE';
          daemonTick();
        }
      }, cooldownMs);
    }
  } catch(err) {
    console.error('[AUTOPILOT] Error:', err);
    state.status = 'ERROR: ' + err.message;
    state.producerRunning = false;
  }
}

function startDaemon() {
  if (daemonLoop) clearInterval(daemonLoop);
  state.producerRunning = true;
  state.batchProduced = 0;
  state.status = 'IDLE';
  updateDiskUsage();
  daemonLoop = setInterval(daemonTick, 3000);
  daemonTick();
}

function stopDaemon() {
  if (daemonLoop) clearInterval(daemonLoop);
  daemonLoop = null;
  state.producerRunning = false;
  state.status = 'STOPPED';
}

module.exports.setupAutopilot = (app) => {
  loadLedger();

  app.get('/api/autopilot/status', (req, res) => {
    updateDiskUsage();
    res.json(state);
  });

  app.get('/api/autopilot/ledger', (req, res) => {
    res.json({ ledger });
  });

  app.post('/api/autopilot/start', (req, res) => {
    const { batchSize, cooldownMinutes, diskQuotaGB } = req.body || {};
    if (batchSize) state.config.batchSize = batchSize;
    if (cooldownMinutes) state.config.cooldownMinutes = cooldownMinutes;
    if (diskQuotaGB) state.config.diskQuotaGB = diskQuotaGB;
    
    startDaemon();
    res.json({ success: true, state });
  });

  app.post('/api/autopilot/stop', (req, res) => {
    stopDaemon();
    res.json({ success: true, state });
  });

  app.post('/api/autopilot/upload-now', (req, res) => {
    const nextItem = ledger.queue.find(i => i.status === 'queued');
    if (!nextItem) return res.json({ empty: true });
    
    processQueue();
    res.json({ success: true, message: 'Upload triggered' });
  });
};
