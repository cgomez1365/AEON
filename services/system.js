/**
 * AEON Jarvis — System Service
 * Host telemetry (CPU/RAM broadcast), the Reaper zombie-process sweep,
 * OS-Bridge instant command patterns, and the task cron daemon.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

module.exports = ({ ROOT, getLocalFile, logTrivial, WORKSPACE, writeOSAudit, kernelLLM }) => {

  // ── INSTANT_PATTERNS for the OS-Bridge smart command router ──
  const INSTANT_PATTERNS = [
    { match: /^(start|launch)\s+chrome\s*(.*)/i, handler: (m) => ({ cmd: `start chrome ${m[2] || ''}`.trim(), msg: `Launching Chrome${m[2] ? ': ' + m[2] : ''}` }) },
    { match: /^(start|launch)\s+(.*)/i, handler: (m) => ({ cmd: `start "" "${m[2]}"`, msg: `Launching: ${m[2]}` }) },
    { match: /^(navigate|goto|go to|browse)\s+(.*)/i, handler: (m) => ({ cmd: `start chrome ${m[2].startsWith('http') ? m[2] : 'https://' + m[2]}`, msg: `Navigating to: ${m[2]}` }) },
    { match: /^(mkdir|create folder|make dir)\s+(.*)/i, handler: (m) => ({ cmd: `mkdir "${m[2]}"`, msg: `Creating directory: ${m[2]}` }) },
    { match: /^(dir|ls|list)\s*(.*)/i, handler: (m) => ({ cmd: `dir "${m[2] || '.'}"`, msg: `Listing: ${m[2] || 'current directory'}` }) },
    { match: /^(type|cat|read)\s+(.*)/i, handler: (m) => ({ cmd: `type "${m[2]}"`, msg: `Reading file: ${m[2]}` }) },
    { match: /^(python|node|npm)\s+(.*)/i, handler: (m) => ({ cmd: `${m[1]} ${m[2]}`, msg: `Executing: ${m[1]} ${m[2]}` }) },
    { match: /^open in vscode\s+(.*)/i, handler: (m) => ({ cmd: `code "${m[1].trim()}"`, msg: `Opening in VS Code: ${m[1].trim()}` }) },
    { match: /^open in notepad\s+(.*)/i, handler: (m) => ({ cmd: `notepad "${m[1].trim()}"`, msg: `Opening in Notepad: ${m[1].trim()}` }) },
    { match: /^open folder\s+(.*)/i, handler: (m) => ({ cmd: `explorer "${m[1].trim()}"`, msg: `Opening folder: ${m[1].trim()}` }) },
    { match: /^open in chrome\s+(.*)/i, handler: (m) => ({ cmd: `start chrome "${m[1].trim()}"`, msg: `Opening in Chrome: ${m[1].trim()}` }) },
    { match: /^open terminal\s*(.*)/i, handler: (m) => ({ cmd: `start cmd /k "cd /d ${m[1].trim() || WORKSPACE}"`, msg: `Opening terminal at: ${m[1].trim() || 'AEON'}` }) },
    { match: /^show desktop$/i, handler: () => ({ cmd: `powershell -command "(New-Object -ComObject Shell.Application).MinimizeAll()"`, msg: `Minimizing all windows` }) },
    { match: /^open\s+(.*)/i, handler: (m) => ({ cmd: `start "" "${m[1].replace(/"/g, '')}"`, msg: `Opening: ${m[1]}` }) },
  ];

  // ── Host telemetry loop — broadcast CPU/RAM only when SSE clients exist ──
  let lastCpuInfo = os.cpus();
  const startTelemetry = (getChatRouter = () => null) => setInterval(() => {
    const chatRouter = getChatRouter();
    if (!chatRouter || chatRouter.activeSSEClients?.size === 0) return;
    const currentCpuInfo = os.cpus();
    let idleDiff = 0;
    let totalDiff = 0;
    for (let i = 0; i < currentCpuInfo.length; i++) {
      const prev = lastCpuInfo[i].times;
      const curr = currentCpuInfo[i].times;
      const prevTotal = Object.values(prev).reduce((a, b) => a + b);
      const currTotal = Object.values(curr).reduce((a, b) => a + b);
      idleDiff += curr.idle - prev.idle;
      totalDiff += currTotal - prevTotal;
    }
    const cpuPercent = totalDiff === 0 ? 0 : Math.round(100 - (100 * idleDiff / totalDiff));
    lastCpuInfo = currentCpuInfo;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramPercent = Math.round((usedMem / totalMem) * 100);

    const isWarn = ramPercent > 80;
    global.broadcastTerminalEvent(isWarn ? 'WARN' : 'SYSTEM_METRIC', `VRAM/RAM: ${ramPercent}% | CPU: ${cpuPercent}%`, { cpu: cpuPercent, ram: ramPercent, usedMem, totalMem });
  }, 5000);

  // ── Reaper — kill orphaned FFmpeg + node zombies ──
  const runReaper = async () => {
    return new Promise((resolve) => {
      try {
        const exec = require('child_process').exec;
        let killedZombies = 0;
        let logMsgs = [];

        try {
          require('child_process').execSync('taskkill /F /IM ffmpeg.exe /T', { stdio: 'ignore' });
          killedZombies++;
          logMsgs.push('FFmpeg orphans');
        } catch (e) { logTrivial(e); }

        const hostPid = process.pid;
        exec('wmic process where name="node.exe" get processid', (err, stdout) => {
          if (!err && stdout) {
            const lines = stdout.split('\n');
            lines.forEach(line => {
              const pid = parseInt(line.trim());
              if (pid && pid !== hostPid) {
                try {
                  process.kill(pid, 'SIGKILL');
                  killedZombies++;
                  if (!logMsgs.includes('Node orphans')) logMsgs.push('Node orphans');
                } catch (e) { logTrivial(e); }
              }
            });
          }

          if (killedZombies > 0) {
            global.broadcastTerminalEvent('REAPER', `Terminated ${killedZombies} zombies (${logMsgs.join(', ')}). VRAM/RAM recovering.`);
          } else {
            global.broadcastTerminalEvent('REAPER', `Zero zombies detected. VRAM/RAM nominal.`);
          }
          resolve(true);
        });
      } catch (err) {
        global.broadcastTerminalEvent('CRIT', `[REAPER-ERR] Execution Failed: ${err.message}`);
        resolve(false);
      }
    });
  };

  // ── Task cron daemon — check scheduled tasks every 60s ──
  const TASKS_FILE = path.join(ROOT, 'src', 'aeon-tasks.json');
  function parseCronish(schedule) {
    if (!schedule) return null;
    const s = schedule.toLowerCase().trim();
    if (s.includes('every') && s.includes('hour')) return 3600000;
    if (s.includes('every') && (s.includes('6 hour') || s.includes('6h'))) return 21600000;
    if (s.includes('every') && s.includes('day') || s.includes('daily')) return 86400000;
    if (s.includes('every') && (s.includes('week') || s.includes('monday'))) return 604800000;
    if (s.includes('every') && (s.includes('30 min') || s.includes('30m'))) return 1800000;
    if (s.includes('every') && (s.includes('5 min') || s.includes('5m'))) return 300000;
    if (s.includes('every') && (s.includes('15 min') || s.includes('15m'))) return 900000;
    return null;
  }

  const startTaskCron = () => setInterval(async () => {
    try {
      if (!fs.existsSync(TASKS_FILE)) return;
      const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      const now = Date.now();
      let changed = false;
      for (const task of tasks) {
        if (!task.enabled || !task.type?.includes('schedule') || !task.schedule) continue;
        const interval = parseCronish(task.schedule);
        if (!interval) continue;
        const lastRun = task.lastRun || 0;
        if (now - lastRun < interval) continue;
        task.status = 'running'; task.lastRun = now; task.runCount = (task.runCount || 0) + 1;
        changed = true;
        try {
          if (task.prompt && typeof kernelLLM === 'function') {
            task.lastResult = await kernelLLM(task.prompt, { role: 'chat' });
            task.status = 'completed';
          } else { task.status = 'completed'; task.lastResult = 'No prompt'; }
        } catch (e) { task.status = 'error'; task.lastResult = e.message; }
        console.log(`[TASK CRON] Executed: ${task.name} (${task.status})`);
        if (writeOSAudit) writeOSAudit('TASK_CRON', `${task.name}: ${task.status}`, task.status === 'completed' ? 200 : 500, 0);
      }
      if (changed) fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
    } catch (e) { console.warn('[TASK CRON] error:', e.message); }
  }, 60000);

  return { INSTANT_PATTERNS, startTelemetry, runReaper, startTaskCron };
};
