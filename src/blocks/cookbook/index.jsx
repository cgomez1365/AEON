import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Cpu, HardDrive, Download, Play, Square, RefreshCw, Trash2, Copy, Check,
  ChevronDown, ChevronUp, Search, Settings, Zap, ExternalLink, X, Server,
  MemoryStick, Monitor, Sliders, AlertTriangle, CheckCircle, Info, BookOpen,
} from 'lucide-react';

const TABS = [
  { id: 'gpus', label: 'Hardware', icon: Cpu },
  { id: 'whatfits', label: 'What Fits', icon: Sliders },
  { id: 'cached', label: 'Models', icon: HardDrive },
  { id: 'download', label: 'Download', icon: Download },
  { id: 'running', label: 'Active', icon: Zap },
  { id: 'guide', label: 'Guide', icon: BookOpen },
];

// ── Guide — plain-language reference for the terms this block throws at
// you (Q4_K_M, 14B, VRAM, "fits GPU"...). Written for someone with zero
// backend/ML background, one short idea per page. ──────────────────────
const GUIDE_PAGES = [
  {
    title: 'Why this page exists',
    body: [
      "Cookbook shows labels like \"Q4_K_M\", \"14B\", and \"GPU + Offload\" right next to every model. None of that is explained anywhere else in AEON — so here it is.",
      "Nothing here assumes you've written code, built a PC, or studied AI. Each page covers one idea. Use the list on the left to jump around, or just hit Next.",
    ],
  },
  {
    title: 'Cloud vs. Local — what’s the actual difference?',
    body: [
      "A “cloud” model (like the ones behind Gemini, GPT, or Claude) runs on someone else's computer, somewhere on the internet. You send it a question, it sends back an answer, and usually you pay for that trip.",
      "A “local” model runs on your own computer instead. No trip over the internet, no per-question bill — but it borrows your machine's own memory and processing power to think.",
    ],
    callout: "Cookbook is entirely about the second kind: models that live and run on your machine.",
  },
  {
    title: 'Tokens — what you’re actually being charged for',
    body: [
      "A token is a small chunk of text — roughly 4 characters, or about ¾ of a word. “Hello there” is about 3 tokens.",
      "Cloud services almost always bill per token: a little for every token you send in, a little for every token it sends back. That's the “pay-as-you-go” meter running.",
      "Local models don't meter tokens at all — there's no bill to run up, because you're not renting time on anyone else's computer.",
    ],
  },
  {
    title: 'Context window — the model’s short-term memory',
    body: [
      "The context window is how much text — measured in tokens — a model can “see” at one time. Your question, the conversation so far, and its reply all have to fit inside that window together.",
      "A small window means it starts “forgetting” the beginning of a long conversation. A bigger window remembers more — but needs more of your computer's memory to hold it.",
    ],
    callout: "That's what the \"8k ctx\" / \"32k ctx\" dropdown in What Fits controls — 8k ≈ 8,000 tokens of memory for the conversation.",
  },
  {
    title: 'Pay-as-you-go vs. Local — the real cost tradeoff',
    body: [
      "Cloud: nothing to set up, but every question adds to a running tab. Use it a lot, and the bill scales right up with you.",
      "Local: the “cost” is mostly already behind you — your computer's hardware, plus a one-time model download. After that, each question is essentially free (aside from a little electricity).",
    ],
  },
  {
    title: 'VRAM vs. RAM — the two memories that matter here',
    body: [
      "RAM is your computer's general-purpose short-term memory — used by your browser, your apps, everything at once.",
      "VRAM is different: it's memory built into your graphics card (GPU), specifically for heavy visual or math-heavy work — gaming, video, and AI models.",
      "Local AI models run much faster when they fit inside VRAM, because a GPU crunches this particular kind of math far quicker than your computer's main processor can.",
    ],
    callout: "That's why Hardware shows your GPU's VRAM size front and center — it's the number that decides what runs smoothly.",
  },
  {
    title: 'Reading the fit badges',
    body: [
      "Every model in What Fits gets a colored badge telling you how well it matches your hardware, right now:",
      "● Fits GPU (green) — loads entirely into your graphics card's VRAM. Fastest option.",
      "● GPU + Offload (orange) — mostly on the GPU, with the overflow handled by regular RAM. Still works well, just a bit slower.",
      "● CPU/RAM (blue) — runs on your main processor and RAM instead of the GPU. Works, but noticeably slower.",
      "● Too Large (red) — doesn't fit in your available memory at all, at least not at this quantization/context size.",
    ],
  },
  {
    title: 'Quantization — what “Q4”, “Q8”, “FP16” mean',
    body: [
      "A model's “brain” (its weights) can be saved at different levels of precision — similar to saving a photo at different quality settings.",
      "FP16 is the full-precision original: biggest file, most exact, needs the most memory.",
      "Q8, Q6, Q4, Q2 are compressed versions — smaller and faster, with a small, usually unnoticeable dip in quality. “Q4_K_M” just means “compressed to about 4 bits per weight, using the K_M method.”",
    ],
    callout: "Rule of thumb: lower number after the Q = smaller file, less memory needed, runs on more modest hardware.",
  },
  {
    title: 'That “14B”, “7B”, “70B” number',
    body: [
      "“14B” means 14 billion parameters — think of parameters as the number of adjustable “knobs” the model tuned while it was trained.",
      "More knobs generally means a more capable model — better at nuance, reasoning, following instructions. It also means a bigger file and more memory needed to run it.",
      "This is the main tradeoff in What Fits: a bigger B number is usually smarter, but only worth it if your hardware can actually hold it.",
    ],
  },
  {
    title: 'Quick glossary',
    body: [
      "Token — a small chunk of text (≈ 4 characters). What cloud AI meters and bills.",
      "Context window — how much conversation (in tokens) a model can hold in mind at once.",
      "VRAM — memory on your graphics card; the fast lane for local AI.",
      "RAM — your computer's general memory; the fallback lane.",
      "Quantization (Q4/Q8/FP16) — how compressed the model file is. Lower Q = smaller, lighter, still usually good.",
      "Parameters (7B/14B/70B) — the model's size/capacity. Bigger number = generally smarter, needs more memory.",
      "Offload — splitting the model between GPU and regular RAM when it doesn't fully fit in VRAM.",
    ],
  },
];

function GuideTab() {
  const [page, setPage] = useState(0);
  const p = GUIDE_PAGES[page];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {GUIDE_PAGES.map((gp, i) => (
          <button key={gp.title} onClick={() => setPage(i)} style={{
            textAlign: 'left', padding: '8px 10px', borderRadius: '6px', fontSize: '11px',
            border: i === page ? '1px solid var(--color-primary, #00f2ff)' : '1px solid transparent',
            background: i === page ? 'rgba(0,242,255,0.08)' : 'transparent',
            color: i === page ? 'var(--color-primary, #00f2ff)' : 'var(--text-dim, #888)',
            cursor: 'pointer', fontWeight: i === page ? 700 : 500, lineHeight: 1.35,
          }}>
            {i + 1}. {gp.title}
          </button>
        ))}
      </div>
      <div style={{
        border: '1px solid var(--border, #2a2a2a)', borderRadius: '10px', padding: '20px',
        minHeight: '380px', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ fontSize: '10px', color: 'var(--text-dim, #888)', marginBottom: '6px', fontFamily: 'var(--font-mono, monospace)' }}>
          PAGE {page + 1} OF {GUIDE_PAGES.length}
        </div>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.15em' }}>{p.title}</h3>
        <div style={{ fontSize: '13px', lineHeight: 1.7, color: 'var(--text, #ddd)', flex: 1 }}>
          {p.body.map((para, i) => <p key={i} style={{ margin: '0 0 12px 0' }}>{para}</p>)}
          {p.callout && (
            <div style={{
              marginTop: '4px', padding: '10px 12px', borderRadius: '8px',
              border: '1px solid rgba(0,242,255,0.25)', background: 'rgba(0,242,255,0.05)', fontSize: '12px',
            }}>
              {p.callout}
            </div>
          )}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: '16px',
          paddingTop: '12px', borderTop: '1px solid var(--border, #2a2a2a)',
        }}>
          <button onClick={() => setPage(cur => Math.max(0, cur - 1))} disabled={page === 0}
            style={{ ...btnStyle, opacity: page === 0 ? 0.4 : 1, cursor: page === 0 ? 'default' : 'pointer' }}>
            ← Back
          </button>
          <button onClick={() => setPage(cur => Math.min(GUIDE_PAGES.length - 1, cur + 1))} disabled={page === GUIDE_PAGES.length - 1}
            style={{ ...btnStyle, opacity: page === GUIDE_PAGES.length - 1 ? 0.4 : 1, cursor: page === GUIDE_PAGES.length - 1 ? 'default' : 'pointer' }}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

const FIT_COLORS = {
  gpu: '#4caf50',
  offload: '#ff9800',
  cpu: '#2196f3',
  too_large: '#f44336',
  unknown: '#888',
};

const FIT_LABELS = {
  gpu: 'Fits GPU',
  offload: 'GPU + Offload',
  cpu: 'CPU/RAM',
  too_large: 'Too Large',
  unknown: '?',
};

const QUANT_OPTIONS = [
  { value: '', label: 'All Quants' },
  { value: 'Q2_K', label: 'Q2_K' },
  { value: 'Q3_K_M', label: 'Q3_K_M' },
  { value: 'IQ4_XS', label: 'IQ4_XS' },
  { value: 'Q4_K_M', label: 'Q4_K_M' },
  { value: 'Q5_K_M', label: 'Q5_K_M' },
  { value: 'Q6_K', label: 'Q6_K' },
  { value: 'Q8_0', label: 'Q8_0' },
  { value: 'FP16', label: 'FP16' },
  { value: 'AWQ-4bit', label: 'AWQ' },
];

const CTX_PRESETS = [
  { value: 4096, label: '4k' },
  { value: 8192, label: '8k' },
  { value: 16384, label: '16k' },
  { value: 32768, label: '32k' },
  { value: 65536, label: '64k' },
  { value: 131072, label: '128k' },
];

export default function CookbookHardware() {
  const [tab, setTab] = useState('gpus');
  const [gpus, setGpus] = useState(null);
  const [gpuError, setGpuError] = useState('');
  const [cachedModels, setCachedModels] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [dlRepo, setDlRepo] = useState('');
  const [dlStatus, setDlStatus] = useState('');
  const [hfModels, setHfModels] = useState([]);
  const [searchFilter, setSearchFilter] = useState('');
  const [copied, setCopied] = useState(null);
  const [scanning, setScanning] = useState(false);

  // What Fits state
  const [hwSystem, setHwSystem] = useState(null);
  const [hwModels, setHwModels] = useState([]);
  const [hwLoading, setHwLoading] = useState(false);
  const [hwSearch, setHwSearch] = useState('');
  const [hwQuant, setHwQuant] = useState('Q4_K_M');
  const [hwCtx, setHwCtx] = useState(8192);
  const [hwSort, setHwSort] = useState('fit');
  const [hwGpuCount, setHwGpuCount] = useState(null);
  const [hwFitOnly, setHwFitOnly] = useState(false);
  const [hwExpanded, setHwExpanded] = useState(null);
  // Manual hardware simulator
  const [manualMode, setManualMode] = useState('');
  const [manualGpuCount, setManualGpuCount] = useState('1');
  const [manualVramGb, setManualVramGb] = useState('24');
  const [manualRamGb, setManualRamGb] = useState('');
  const [manualBackend, setManualBackend] = useState('cuda');
  const [showManual, setShowManual] = useState(false);
  // Serve profiles
  const [profiles, setProfiles] = useState([]);
  const [profileModel, setProfileModel] = useState('');

  // ── Native Runtime Status ──
  const [lrStatus, setLrStatus] = useState(null); // null=loading, {runtimeReady, readyModels}
  const [lrInstalling, setLrInstalling] = useState(false);
  const fetchLrStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/cookbook/local/status');
      setLrStatus(await res.json());
    } catch { setLrStatus({ runtimeReady: false, readyModels: 0 }); }
  }, []);
  const installRuntime = useCallback(async () => {
    setLrInstalling(true);
    try {
      await fetch('/api/cookbook/local/install-runtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setTab('running');
      pollTasks();
    } catch {}
    // status will update via task completion
  }, []);

  // ── Built-in model catalog (the installer that needs no external tools) ──
  //
  // The only model-install control the UI offered was the HF "Download Model"
  // field, which shells out to the `hf` CLI or `python`. AEON installs neither
  // and never checked for them, so on a clean machine `where python` resolved
  // to the Windows Store alias stub, which exits non-zero with a Store ad — and
  // none of the diagnostic patterns matched that. The install just "failed".
  //
  // Meanwhile services/local-runtime/model-installer.cjs — pure Node HTTPS,
  // SHA-256 verified, GGUF-probed — had no button at all. It does now.
  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState('');
  const [installingModel, setInstallingModel] = useState(null);

  const fetchCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/cookbook/local/catalog');
      const d = await res.json();
      if (d.ok) { setCatalog(d.models || []); setCatalogError(''); }
      else setCatalogError(d.error || 'Could not read the model catalog.');
    } catch (e) { setCatalogError(e.message); }
  }, []);

  const installLocalModel = useCallback(async (modelId) => {
    setInstallingModel(modelId);
    try {
      const res = await fetch('/api/cookbook/local/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setCatalogError(d.error || `Install could not start (${res.status}).`);
        setInstallingModel(null);
      }
    } catch (e) {
      setCatalogError(e.message);
      setInstallingModel(null);
    }
  }, []);

  useEffect(() => { fetchCatalog(); }, [fetchCatalog]);

  // Clear the in-progress marker once status reports the install finished, and
  // surface the reason when it failed rather than silently going idle.
  useEffect(() => {
    const mi = lrStatus?.modelInstall;
    if (!mi || !installingModel) return;
    if (mi.status === 'done') { setInstallingModel(null); fetchCatalog(); }
    else if (mi.status === 'error') {
      setCatalogError(mi.error || 'Model install failed.');
      setInstallingModel(null);
    }
  }, [lrStatus, installingModel, fetchCatalog]);

  // ── GPU Probe ──
  const probeGpus = useCallback(async () => {
    setScanning(true);
    setGpuError('');
    try {
      const res = await fetch('/api/cookbook/gpus');
      const data = await res.json();
      setGpus(data);
      if (!data.ok) setGpuError(data.error || 'Probe failed');
    } catch (e) {
      setGpuError(e.message);
    }
    setScanning(false);
  }, []);

  // ── Cached Models ──
  const scanCached = useCallback(async () => {
    try {
      const res = await fetch('/api/model/cached');
      const data = await res.json();
      setCachedModels(data.models || []);
    } catch {}
  }, []);

  // ── Active Tasks ──
  const pollTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/cookbook/tasks/status');
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch {}
  }, []);

  // ── HF Latest ──
  const loadHfLatest = useCallback(async () => {
    try {
      const vram = gpus?.gpus?.reduce((s, g) => s + (g.total_mb || 0), 0) || 0;
      const vramGb = Math.round(vram / 1024);
      const res = await fetch(`/api/cookbook/hf-latest?vram_gb=${vramGb}&limit=12`);
      const data = await res.json();
      setHfModels(data.models || []);
    } catch {}
  }, [gpus]);

  // ── What Fits: fetch model ranking ──
  const fetchHwfit = useCallback(async (fresh = false) => {
    setHwLoading(true);
    try {
      const params = new URLSearchParams();
      if (hwSearch) params.set('search', hwSearch);
      if (hwQuant) params.set('quant', hwQuant);
      if (hwCtx) params.set('ctx', String(hwCtx));
      if (hwSort) params.set('sort', hwSort);
      if (hwGpuCount !== null) params.set('gpu_count', String(hwGpuCount));
      if (hwFitOnly) params.set('fit_only', 'true');
      if (fresh) params.set('fresh', 'true');
      params.set('limit', '50');
      if (manualMode) {
        params.set('manual_mode', manualMode);
        if (manualMode === 'gpu') {
          params.set('manual_gpu_count', manualGpuCount);
          params.set('manual_vram_gb', manualVramGb);
          params.set('manual_backend', manualBackend);
        }
        if (manualRamGb) params.set('manual_ram_gb', manualRamGb);
      }
      const res = await fetch('/api/hwfit/models?' + params.toString());
      const data = await res.json();
      setHwSystem(data.system || null);
      setHwModels(data.models || []);
    } catch (e) {
      setHwModels([]);
    }
    setHwLoading(false);
  }, [hwSearch, hwQuant, hwCtx, hwSort, hwGpuCount, hwFitOnly, manualMode, manualGpuCount, manualVramGb, manualRamGb, manualBackend]);

  // ── Serve Profiles ──
  const fetchProfiles = useCallback(async (modelName) => {
    setProfileModel(modelName);
    try {
      const res = await fetch(`/api/hwfit/profiles?model=${encodeURIComponent(modelName)}`);
      const data = await res.json();
      setProfiles(data.profiles || []);
    } catch { setProfiles([]); }
  }, []);

  useEffect(() => { probeGpus(); scanCached(); pollTasks(); fetchLrStatus(); }, []);
  useEffect(() => { if (tab === 'download') { loadHfLatest(); } }, [tab, loadHfLatest]);
  useEffect(() => { if (tab === 'whatfits') fetchHwfit(); }, [tab]);
  useEffect(() => {
    const interval = setInterval(pollTasks, 5000);
    return () => clearInterval(interval);
  }, [pollTasks]);
  // Refresh runtime status when a runtime-install task finishes
  useEffect(() => {
    const t = tasks.find(x => x.type === 'runtime-install');
    if (t && (t.status === 'done' || t.status === 'error')) {
      setLrInstalling(false);
      fetchLrStatus();
    }
  }, [tasks, fetchLrStatus]);
  // Debounced hwfit search
  const hwSearchTimer = useRef(null);
  function onHwSearchChange(val) {
    setHwSearch(val);
    if (hwSearchTimer.current) clearTimeout(hwSearchTimer.current);
    hwSearchTimer.current = setTimeout(() => fetchHwfit(), 400);
  }

  // ── Download ──
  async function startDownload(repoOverride) {
    const repo = repoOverride || dlRepo;
    if (!repo.trim()) return;
    setDlStatus('Starting...');
    const hfMatch = repo.match(/^https?:\/\/huggingface\.co\/([^/]+\/[^/?#]+)/);
    const repoId = hfMatch ? hfMatch[1] : repo.trim();
    try {
      const res = await fetch('/api/model/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_id: repoId }),
      });
      const data = await res.json();
      if (data.ok) {
        setDlStatus(`Downloading... (${data.session_id})`);
        setDlRepo('');
        setTab('running');
        pollTasks();
      } else {
        setDlStatus(`Error: ${data.error}`);
      }
    } catch (e) {
      setDlStatus(`Error: ${e.message}`);
    }
  }

  // ── Serve (Quick launch) ──
  async function quickServe(model) {
    const repo = model.repo_id || model.name;
    let cmd;
    if (model.is_gguf) {
      cmd = `llama-server --model "${repo}" --host 0.0.0.0 --port 8080 -ngl 99 -c 8192`;
    } else {
      cmd = `vllm serve ${repo} --host 0.0.0.0 --port 8000 --dtype auto --trust-remote-code`;
    }
    try {
      const res = await fetch('/api/model/serve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_id: repo, cmd }),
      });
      const data = await res.json();
      if (data.ok) {
        setTab('running');
        pollTasks();
      } else {
        alert('Serve failed: ' + (data.error || ''));
      }
    } catch (e) {
      alert('Serve failed: ' + e.message);
    }
  }

  async function stopTask(sessionId) {
    try {
      await fetch(`/api/cookbook/task-stop/${sessionId}`, { method: 'POST' });
      pollTasks();
    } catch {}
  }

  async function killPid(pid) {
    if (!window.confirm(`Kill PID ${pid}?`)) return;
    try {
      await fetch('/api/cookbook/kill-pid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
      });
      setTimeout(probeGpus, 1500);
    } catch {}
  }

  async function deleteCached(repo) {
    if (!window.confirm(`Delete ${repo} from cache?`)) return;
    try {
      await fetch('/api/cookbook/delete-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      });
      scanCached();
    } catch {}
  }

  async function copyText(text, id) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  const activeCount = tasks.filter(t => t.status === 'running' || t.status === 'ready').length;
  const filteredCached = cachedModels.filter(m =>
    !searchFilter || (m.repo_id || '').toLowerCase().includes(searchFilter.toLowerCase())
  );

  // GPU toggle counts for What Fits
  const gpuPoolSize = useMemo(() => {
    if (!hwSystem) return 0;
    const groups = hwSystem.gpu_groups || [];
    if (groups.length) return groups[0]?.count || 0;
    return hwSystem.gpu_count || 0;
  }, [hwSystem]);

  const validGpuCounts = useMemo(() => {
    const counts = [1, 2, 4, 8].filter(n => n <= gpuPoolSize);
    if (gpuPoolSize > 0 && !counts.includes(gpuPoolSize)) counts.push(gpuPoolSize);
    return counts;
  }, [gpuPoolSize]);

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Server size={20} style={{ color: 'var(--color-primary, #00f2ff)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em', fontFamily: 'var(--font-headline, inherit)' }}>Cookbook</h2>
        <span style={{
          fontSize: '10px', opacity: 0.5, fontFamily: 'var(--font-mono, monospace)',
          border: '1px solid rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px',
        }}>
          GPU / Model / Serve Manager
        </span>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim, #888)', margin: '0 0 16px 0' }}>
        Probe hardware, rank models by fit, download from HuggingFace, serve locally
      </p>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
              cursor: 'pointer', transition: 'all 0.15s ease',
              border: isActive ? '1px solid var(--color-primary, #00f2ff)' : '1px solid var(--border, #2a2a2a)',
              background: isActive ? 'rgba(0,242,255,0.08)' : 'transparent',
              color: isActive ? 'var(--color-primary, #00f2ff)' : 'var(--text-dim, #888)',
            }}>
              <Icon size={13} />
              {t.label}
              {t.id === 'running' && activeCount > 0 && (
                <span style={{
                  background: 'var(--color-primary, #00f2ff)', color: '#000',
                  borderRadius: '10px', padding: '1px 6px', fontSize: '10px', fontWeight: 700,
                }}>{activeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Hardware Tab ── */}
      {tab === 'gpus' && (
        <div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button onClick={probeGpus} disabled={scanning} style={{
              ...btnStyle, background: scanning ? 'rgba(255,255,255,0.05)' : 'var(--color-primary, #00f2ff)',
              color: scanning ? 'var(--text-dim)' : '#000',
            }}>
              <RefreshCw size={13} style={scanning ? { animation: 'spin 1s linear infinite' } : {}} />
              {scanning ? 'Scanning...' : 'Probe GPUs'}
            </button>
          </div>

          {gpuError && <div style={errorBox}>{gpuError}</div>}

          {/* Native local runtime status panel */}
          {lrStatus && !lrStatus.runtimeReady && (
            <div style={{ ...cardStyle, marginBottom: '16px', border: '1px solid rgba(0,242,255,0.25)' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>Local AI runtime (llama.cpp)</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '10px' }}>
                Not installed. Install llama.cpp to run free, private AI models locally — no API key needed.
                AEON manages it entirely inside its data directory.
              </div>
              <button onClick={installRuntime} disabled={lrInstalling} style={{
                ...btnStyle,
                background: lrInstalling ? 'rgba(255,255,255,0.05)' : 'var(--color-primary, #00f2ff)',
                color: lrInstalling ? 'var(--text-dim)' : '#000',
              }}>
                <Download size={13} />
                {lrInstalling ? 'Installing...' : 'Install llama.cpp'}
              </button>
            </div>
          )}
          {lrStatus?.runtimeReady && (
            <div style={{ fontSize: '11px', color: '#22d36f', marginBottom: '12px' }}>
              ✓ llama.cpp installed — {lrStatus.readyModels} model{lrStatus.readyModels !== 1 ? 's' : ''} ready
            </div>
          )}

          {/* Built-in model catalog — no Python, no HF CLI, nothing to install first. */}
          {lrStatus?.runtimeReady && catalog.length > 0 && (
            <div style={{ ...cardStyle, marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>Local models</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '10px' }}>
                Downloaded and verified by AEON itself — no Python or Hugging Face CLI required.
                Each file's checksum is checked before it is installed.
              </div>

              {catalogError && <div style={errorBox}>{catalogError}</div>}

              {lrStatus?.modelInstall?.status === 'running' && (
                <div style={{ fontSize: '11px', color: 'var(--color-primary, #00f2ff)', marginBottom: '8px' }}>
                  Installing {lrStatus.modelInstall.target}… {lrStatus.modelInstall.pct || 0}%
                  {lrStatus.modelInstall.log ? ` — ${lrStatus.modelInstall.log}` : ''}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {catalog.map(m => (
                  <div key={m.id} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '7px 9px', borderRadius: '4px',
                    background: 'rgba(255,255,255,0.02)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px' }}>{m.displayName || m.id}</div>
                      <div style={{ fontSize: '10.5px', color: 'var(--text-dim)' }}>
                        {(m.capabilities || []).join(' · ') || 'model'}
                        {m.sizeMb ? ` · ${m.sizeMb} MB` : ''}
                      </div>
                    </div>
                    {m.installed ? (
                      <span style={{ fontSize: '11px', color: '#22d36f' }}>✓ installed</span>
                    ) : (
                      <button
                        onClick={() => installLocalModel(m.id)}
                        disabled={!!installingModel}
                        style={{
                          ...btnStyle,
                          padding: '4px 10px', fontSize: '11px',
                          background: installingModel ? 'rgba(255,255,255,0.05)' : 'var(--color-primary, #00f2ff)',
                          color: installingModel ? 'var(--text-dim)' : '#000',
                        }}>
                        <Download size={12} />
                        {installingModel === m.id ? 'Installing…' : 'Install'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* System Info Card */}
          <SystemInfoCard />

          {gpus?.gpus?.length > 0 ? (
            <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
              {gpus.gpus.map(g => (
                <div key={g.index} style={cardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>
                      GPU {g.index}: {g.name}
                    </span>
                    <span style={{
                      fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                      background: g.busy ? 'rgba(244,67,54,0.15)' : 'rgba(76,175,80,0.15)',
                      color: g.busy ? '#f44336' : '#4caf50',
                    }}>
                      {g.busy ? 'busy' : 'free'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px', color: 'var(--text-dim, #888)' }}>
                    <span>{(g.used_mb / 1024).toFixed(1)} / {(g.total_mb / 1024).toFixed(1)} GB</span>
                    <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: '2px', transition: 'width 0.3s',
                        width: `${g.total_mb ? Math.round(g.used_mb / g.total_mb * 100) : 0}%`,
                        background: g.busy ? '#f44336' : 'var(--color-primary, #00f2ff)',
                      }} />
                    </div>
                    <span>{g.util_pct}% util</span>
                  </div>
                  {g.processes?.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      {g.processes.map(p => (
                        <div key={p.pid} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          fontSize: '10px', padding: '3px 0', borderTop: '1px solid rgba(255,255,255,0.03)',
                        }}>
                          <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.6 }}>
                            PID {p.pid} — {p.name} — {(p.used_mb / 1024).toFixed(1)} GB
                          </span>
                          <button onClick={() => killPid(p.pid)} style={{ ...tinyBtn, color: '#f44336' }}>Kill</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : gpus && !gpuError ? (
            <div style={{ textAlign: 'center', padding: '32px', opacity: 0.5, fontSize: '12px', marginTop: '12px' }}>
              {gpus.note || 'No NVIDIA GPU detected. llama.cpp can still run on CPU.'}
            </div>
          ) : null}

          {gpus?.backend && (
            <div style={{ marginTop: '16px', fontSize: '11px', opacity: 0.4 }}>
              Backend: {gpus.backend} &middot; Source: {gpus.source}
            </div>
          )}
        </div>
      )}

      {/* ── What Fits Tab ── */}
      {tab === 'whatfits' && (
        <WhatFitsTab
          system={hwSystem}
          models={hwModels}
          loading={hwLoading}
          search={hwSearch}
          quant={hwQuant}
          ctx={hwCtx}
          sort={hwSort}
          gpuCount={hwGpuCount}
          fitOnly={hwFitOnly}
          gpuPoolSize={gpuPoolSize}
          validGpuCounts={validGpuCounts}
          showManual={showManual}
          manualMode={manualMode}
          manualGpuCount={manualGpuCount}
          manualVramGb={manualVramGb}
          manualRamGb={manualRamGb}
          manualBackend={manualBackend}
          expanded={hwExpanded}
          profiles={profiles}
          profileModel={profileModel}
          onSearchChange={onHwSearchChange}
          onQuantChange={(v) => { setHwQuant(v); setTimeout(() => fetchHwfit(), 50); }}
          onCtxChange={(v) => { setHwCtx(v); setTimeout(() => fetchHwfit(), 50); }}
          onSortChange={(v) => { setHwSort(v); setTimeout(() => fetchHwfit(), 50); }}
          onGpuCountChange={(v) => { setHwGpuCount(v); setTimeout(() => fetchHwfit(), 50); }}
          onFitOnlyChange={(v) => { setHwFitOnly(v); setTimeout(() => fetchHwfit(), 50); }}
          onRefresh={() => fetchHwfit(true)}
          onToggleManual={() => setShowManual(!showManual)}
          onManualModeChange={setManualMode}
          onManualGpuCountChange={setManualGpuCount}
          onManualVramGbChange={setManualVramGb}
          onManualRamGbChange={setManualRamGb}
          onManualBackendChange={setManualBackend}
          onApplyManual={() => fetchHwfit(true)}
          onClearManual={() => { setManualMode(''); setTimeout(() => fetchHwfit(true), 50); }}
          onExpand={(name) => setHwExpanded(hwExpanded === name ? null : name)}
          onDownload={(name) => startDownload(name)}
          onServe={quickServe}
          onFetchProfiles={fetchProfiles}
        />
      )}

      {/* ── Models Tab (Cached) ── */}
      {tab === 'cached' && (
        <div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <input type="text" placeholder="Search cached models..."
              value={searchFilter} onChange={e => setSearchFilter(e.target.value)}
              aria-label="Search cached models"
              style={inputStyle} />
            <button onClick={scanCached} style={btnStyle}><RefreshCw size={12} /> Scan</button>
          </div>
          {filteredCached.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', opacity: 0.5, fontSize: '12px' }}>
              No cached models found. Download one from the Download tab.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '8px' }}>
              {filteredCached.map(m => (
                <div key={m.repo_id} style={cardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.repo_id}
                        {m.is_gguf && <span style={tagChip('#f59e0b')}>GGUF</span>}
                        {m.is_diffusion && <span style={tagChip('#ec4899')}>Diffusion</span>}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                        {m.size} &middot; {m.nb_files} files
                        {m.status === 'downloading' && <span style={{ color: '#f59e0b' }}> &middot; downloading</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {m.status === 'ready' && (
                        <button onClick={() => quickServe(m)} style={{ ...tinyBtn, color: 'var(--color-primary, #00f2ff)' }}>
                          <Play size={11} /> Serve
                        </button>
                      )}
                      <button onClick={() => deleteCached(m.repo_id)} style={{ ...tinyBtn, color: '#f44336' }}
                        aria-label={`Delete ${m.repo_id} from cache`} title="Delete from cache">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Download Tab ── */}
      {tab === 'download' && (
        <div>
          <div style={{ ...cardStyle, marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>Direct Download</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input type="text" placeholder="org/model-name, qwen2.5:14b, or HF URL"
                value={dlRepo} onChange={e => setDlRepo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') startDownload(); }}
                aria-label="Model repository or name to download"
                style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => startDownload()} disabled={!dlRepo.trim()} style={{
                ...btnStyle,
                background: dlRepo.trim() ? 'var(--color-primary, #00f2ff)' : 'rgba(255,255,255,0.05)',
                color: dlRepo.trim() ? '#000' : 'var(--text-dim)',
              }}>
                <Download size={13} /> Download
              </button>
            </div>
            {dlStatus && <div style={{ fontSize: '11px', marginTop: '6px', color: dlStatus.startsWith('Error') ? '#f44336' : 'var(--text-dim)' }}>{dlStatus}</div>}
            <div style={{ fontSize: '10.5px', marginTop: '8px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              One click is all it takes: models download into AEON's own model store and register
              themselves automatically — Settings, Council, and the terminal see them the moment the download finishes.
            </div>
          </div>

          {hfModels.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Zap size={13} style={{ color: 'var(--color-primary)' }} /> Trending Models
                <button onClick={loadHfLatest} style={tinyBtn} aria-label="Refresh trending models" title="Refresh"><RefreshCw size={10} /></button>
              </div>
              <div style={{ display: 'grid', gap: '6px' }}>
                {hfModels.map(m => (
                  <div key={m.repo_id} onClick={() => setDlRepo(m.repo_id)}
                    role="button" tabIndex={0}
                    aria-label={`Use ${m.repo_id} as download target`}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDlRepo(m.repo_id); }
                    }}
                    style={{ ...cardStyle, cursor: 'pointer', transition: 'border-color 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,242,255,0.3)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border, #2a2a2a)'}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.repo_id.split('/').pop()}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '1px' }}>
                          {m.repo_id.split('/')[0]}
                          {m.needed_vram_gb && ` · ~${m.needed_vram_gb} GB`}
                          {m.downloads && ` · ${m.downloads.toLocaleString()} downloads`}
                        </div>
                      </div>
                      <a href={`https://huggingface.co/${m.repo_id}`} target="_blank" rel="noopener"
                        onClick={e => e.stopPropagation()}
                        style={{ color: 'var(--color-primary)', fontSize: '10px', textDecoration: 'none' }}>
                        HF <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          )}
        </div>
      )}

      {/* ── Active Tasks Tab ── */}
      {tab === 'running' && (
        <div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button onClick={pollTasks} style={btnStyle}><RefreshCw size={12} /> Refresh</button>
          </div>
          {tasks.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', opacity: 0.5, fontSize: '12px' }}>
              No active tasks. Download or serve a model to see it here.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '10px' }}>
              {tasks.map(t => (
                <TaskCard key={t.session_id} task={t}
                  onStop={() => stopTask(t.session_id)}
                  onCopy={() => copyText(t.output_tail || '', t.session_id)}
                  copied={copied === t.session_id}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Guide Tab ── */}
      {tab === 'guide' && <GuideTab />}
    </div>
  );
}

// ── System Info Card (CPU/RAM summary, shown on Hardware tab) ──
function SystemInfoCard() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    fetch('/api/hwfit/system').then(r => r.json()).then(setInfo).catch(() => {});
  }, []);
  if (!info || info.error) return null;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Cpu size={14} style={{ color: 'var(--color-primary, #00f2ff)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '11px' }}>{info.cpu_model}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{info.cpu_cores} cores / {info.cpu_threads} threads</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <MemoryStick size={14} style={{ color: '#8b5cf6', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '11px' }}>{info.total_ram_gb} GB RAM</div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{info.available_ram_gb} GB available</div>
          </div>
        </div>
        {info.has_gpu && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Monitor size={14} style={{ color: '#4caf50', flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '11px' }}>{info.gpu_count}× {shortGpuName(info.gpu_name)}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{info.gpu_vram_gb} GB VRAM total</div>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Server size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '11px' }}>{info.hostname}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{info.platform} · {info.backend}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── What Fits Tab ──
function WhatFitsTab({
  system, models, loading, search, quant, ctx, sort, gpuCount, fitOnly,
  gpuPoolSize, validGpuCounts, showManual, manualMode, manualGpuCount,
  manualVramGb, manualRamGb, manualBackend, expanded, profiles, profileModel,
  onSearchChange, onQuantChange, onCtxChange, onSortChange, onGpuCountChange,
  onFitOnlyChange, onRefresh, onToggleManual, onManualModeChange,
  onManualGpuCountChange, onManualVramGbChange, onManualRamGbChange,
  onManualBackendChange, onApplyManual, onClearManual, onExpand,
  onDownload, onServe, onFetchProfiles,
}) {
  return (
    <div>
      {/* System Summary */}
      {system && !system.error && (
        <div style={{ ...cardStyle, marginBottom: '12px', padding: '10px 14px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', fontSize: '11px' }}>
            {system.has_gpu && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Monitor size={12} style={{ color: '#4caf50' }} />
                <strong>{system.gpu_count}× {shortGpuName(system.gpu_name)}</strong>
                <span style={{ color: 'var(--text-dim)' }}>({system.gpu_vram_gb} GB)</span>
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MemoryStick size={12} style={{ color: '#8b5cf6' }} />
              <strong>{system.total_ram_gb} GB</strong>
              <span style={{ color: 'var(--text-dim)' }}>RAM</span>
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{system.backend}</span>
            {system.manual_hardware && (
              <span style={{ ...tagChip('#ff9800'), fontSize: '9px' }}>SIMULATED</span>
            )}
          </div>
        </div>
      )}

      {/* Controls Row */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Search models..." value={search}
          onChange={e => onSearchChange(e.target.value)}
          aria-label="Search models"
          style={{ ...inputStyle, width: '160px' }} />
        <select value={quant} onChange={e => onQuantChange(e.target.value)} style={selectStyle} aria-label="Filter by quantization">
          {QUANT_OPTIONS.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}
        </select>
        <select value={ctx} onChange={e => onCtxChange(parseInt(e.target.value))} style={selectStyle} aria-label="Filter by context length">
          {CTX_PRESETS.map(c => <option key={c.value} value={c.value}>{c.label} ctx</option>)}
        </select>
        <select value={sort} onChange={e => onSortChange(e.target.value)} style={selectStyle} aria-label="Sort models by">
          <option value="fit">Sort: Fit</option>
          <option value="tightest">Sort: Tightest</option>
          <option value="size">Sort: Size</option>
          <option value="newest">Sort: Newest</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-dim)', cursor: 'pointer' }}>
          <input type="checkbox" checked={fitOnly} onChange={e => onFitOnlyChange(e.target.checked)}
            style={{ accentColor: 'var(--color-primary)' }} />
          Fits only
        </label>
      </div>

      {/* GPU Toggle Buttons */}
      {gpuPoolSize > 0 && (
        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <button onClick={() => onGpuCountChange(0)} style={{
            ...gpuBtn, ...(gpuCount === 0 ? gpuBtnActive : {}),
          }}>RAM</button>
          {validGpuCounts.map(n => (
            <button key={n} onClick={() => onGpuCountChange(n)} style={{
              ...gpuBtn, ...(gpuCount === n ? gpuBtnActive : {}),
            }}>
              {n === 1 ? 'GPU' : `${n} GPU`}
            </button>
          ))}
          {gpuCount !== null && (
            <button onClick={() => onGpuCountChange(null)} style={{ ...tinyBtn, fontSize: '10px', color: 'var(--text-dim)' }}>
              <X size={10} /> Clear
            </button>
          )}
        </div>
      )}

      {/* Manual Hardware Simulator */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={onRefresh} disabled={loading} style={btnStyle}>
            <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            {loading ? 'Scanning...' : 'Rescan'}
          </button>
          <button onClick={onToggleManual} style={{ ...tinyBtn, fontSize: '11px' }}>
            <Settings size={11} /> {showManual ? 'Hide' : 'What If...'}
          </button>
          {manualMode && (
            <button onClick={onClearManual} style={{ ...tinyBtn, fontSize: '10px', color: '#f44336' }}>
              <X size={10} /> Clear Manual
            </button>
          )}
        </div>

        {showManual && (
          <div style={{ ...cardStyle, marginTop: '8px', padding: '12px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-dim)' }}>
              Hardware Simulator — "What if I had..."
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={fieldLabel}>
                Mode
                <select value={manualMode} onChange={e => onManualModeChange(e.target.value)} style={{ ...selectStyle, width: '90px' }}>
                  <option value="">Off</option>
                  <option value="gpu">GPU</option>
                  <option value="ram">RAM Only</option>
                </select>
              </label>
              {manualMode === 'gpu' && (
                <>
                  <label style={fieldLabel}>
                    GPUs
                    <input type="number" min="1" max="16" value={manualGpuCount}
                      onChange={e => onManualGpuCountChange(e.target.value)}
                      style={{ ...inputStyle, width: '60px' }} />
                  </label>
                  <label style={fieldLabel}>
                    VRAM/GPU (GB)
                    <input type="number" min="1" step="1" value={manualVramGb}
                      onChange={e => onManualVramGbChange(e.target.value)}
                      style={{ ...inputStyle, width: '80px' }} />
                  </label>
                  <label style={fieldLabel}>
                    Backend
                    <select value={manualBackend} onChange={e => onManualBackendChange(e.target.value)} style={{ ...selectStyle, width: '90px' }}>
                      <option value="cuda">CUDA</option>
                      <option value="rocm">ROCm</option>
                      <option value="metal">Metal</option>
                    </select>
                  </label>
                </>
              )}
              <label style={fieldLabel}>
                RAM (GB)
                <input type="number" min="1" step="1" value={manualRamGb} placeholder="auto"
                  onChange={e => onManualRamGbChange(e.target.value)}
                  style={{ ...inputStyle, width: '80px' }} />
              </label>
              <button onClick={onApplyManual} disabled={!manualMode} style={{
                ...btnStyle, background: manualMode ? '#ff9800' : 'rgba(255,255,255,0.05)',
                color: manualMode ? '#000' : 'var(--text-dim)',
              }}>
                Simulate
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Model List */}
      {loading && models.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', opacity: 0.5, fontSize: '12px' }}>
          Scanning hardware & ranking models...
        </div>
      ) : models.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', opacity: 0.5, fontSize: '12px' }}>
          No models found. Try adjusting filters or clearing the search.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '6px' }}>
          {models.map(m => (
            <ModelFitCard key={m.name + (m.quant || '')} model={m}
              isExpanded={expanded === m.name}
              profiles={profileModel === m.name ? profiles : []}
              onExpand={() => onExpand(m.name)}
              onDownload={() => onDownload(m.name)}
              onServe={() => onServe({ repo_id: m.name, is_gguf: (m.quant || '').startsWith('Q') || (m.quant || '').startsWith('IQ') })}
              onFetchProfiles={() => onFetchProfiles(m.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Model Fit Card ──
function ModelFitCard({ model, isExpanded, profiles, onExpand, onDownload, onServe, onFetchProfiles }) {
  const fitColor = FIT_COLORS[model.fit] || '#888';
  const fitLabel = FIT_LABELS[model.fit] || model.fit;
  const shortName = model.short_name || (model.name || '').split('/').pop();
  const org = (model.name || '').includes('/') ? model.name.split('/')[0] : '';

  return (
    <div style={{
      ...cardStyle, padding: '10px 14px',
      borderLeft: `3px solid ${fitColor}`,
      cursor: 'pointer', transition: 'border-color 0.15s',
    }}
      onClick={onExpand}
      role="button" tabIndex={0} aria-expanded={isExpanded}
      aria-label={`${shortName}, ${fitLabel}, ${model.params_b}B parameters. ${isExpanded ? 'Collapse' : 'Expand'} details`}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); }
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = fitColor}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border, #2a2a2a)'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Fit badge */}
        <span style={{
          fontSize: '9px', padding: '2px 8px', borderRadius: '10px', fontWeight: 700,
          background: `color-mix(in srgb, ${fitColor} 15%, transparent)`,
          color: fitColor, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {fitLabel}
        </span>

        {/* Name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {shortName}
          </div>
          {org && <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{org}</div>}
        </div>

        {/* Size + Quant */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '11px', fontWeight: 600 }}>{model.params_b}B</div>
          <div style={{ fontSize: '9px', color: 'var(--text-dim)' }}>
            {model.quant} · ~{model.needed_gb || '?'} GB
          </div>
        </div>

        {/* Headroom */}
        {model.fit === 'gpu' && model.headroom_pct !== undefined && (
          <div style={{
            width: '32px', height: '32px', borderRadius: '50%', display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 700,
            background: `conic-gradient(${fitColor} ${100 - model.headroom_pct}%, rgba(255,255,255,0.05) 0)`,
            color: 'var(--text, #e0e0e0)', flexShrink: 0,
          }}>
            {model.headroom_pct}%
          </div>
        )}

        <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
          <button onClick={onDownload} style={{ ...tinyBtn, color: 'var(--color-primary)' }} title="Download" aria-label={`Download ${shortName}`}>
            <Download size={12} />
          </button>
          {model.fit !== 'too_large' && (
            <button onClick={onServe} style={{ ...tinyBtn, color: '#4caf50' }} title="Quick Serve" aria-label={`Quick serve ${shortName}`}>
              <Play size={12} />
            </button>
          )}
        </div>

        {isExpanded ? <ChevronUp size={14} style={{ flexShrink: 0 }} /> : <ChevronDown size={14} style={{ flexShrink: 0 }} />}
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}
          onClick={e => e.stopPropagation()}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px', marginBottom: '10px' }}>
            <div><span style={{ color: 'var(--text-dim)' }}>Parameters:</span> {model.params_b}B</div>
            <div><span style={{ color: 'var(--text-dim)' }}>Quantization:</span> {model.quant}</div>
            <div><span style={{ color: 'var(--text-dim)' }}>Context:</span> {model.context ? model.context.toLocaleString() : '—'}</div>
            <div><span style={{ color: 'var(--text-dim)' }}>Max Context:</span> {model.context_length ? model.context_length.toLocaleString() : '—'}</div>
            <div><span style={{ color: 'var(--text-dim)' }}>Est. VRAM:</span> {model.needed_gb || '?'} GB</div>
            <div><span style={{ color: 'var(--text-dim)' }}>Fit:</span> <span style={{ color: fitColor }}>{fitLabel}</span></div>
            {model.available_gb && <div><span style={{ color: 'var(--text-dim)' }}>Available:</span> {model.available_gb} GB</div>}
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <a href={`https://huggingface.co/${model.name}`} target="_blank" rel="noopener"
              style={{ ...tinyBtn, color: 'var(--color-primary)', textDecoration: 'none', fontSize: '11px' }}>
              <ExternalLink size={10} /> HuggingFace
            </a>
            <button onClick={onFetchProfiles} style={{ ...tinyBtn, fontSize: '11px' }}>
              <Sliders size={10} /> Serve Profiles
            </button>
          </div>

          {/* Serve Profiles */}
          {profiles.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-dim)' }}>
                Serve Profiles
              </div>
              <div style={{ display: 'grid', gap: '6px' }}>
                {profiles.map(p => (
                  <div key={p.name} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 10px', borderRadius: '6px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    fontSize: '11px',
                  }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{p.name}</span>
                      <span style={{ color: 'var(--text-dim)', marginLeft: '8px' }}>
                        {p.quant} · ctx {p.context.toLocaleString()} · ~{p.est_vram_gb} GB
                      </span>
                    </div>
                    <span style={{
                      fontSize: '9px', padding: '2px 6px', borderRadius: '8px',
                      background: `color-mix(in srgb, ${FIT_COLORS[p.fit] || '#888'} 15%, transparent)`,
                      color: FIT_COLORS[p.fit] || '#888',
                    }}>
                      {p.fit === 'gpu' ? 'GPU' : p.fit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Task Card ──
function TaskCard({ task, onStop, onCopy, copied }) {
  // An error with no matched diagnosis used to show a bare red "ERROR" pill
  // with the actual reason hidden behind a click — auto-expand that case so
  // the raw log is visible immediately instead of looking like a dead end.
  // TaskCard is keyed by session_id and stays mounted across status changes
  // (running -> error), so this can't be initial useState alone — it has to
  // react to the transition too.
  const [expanded, setExpanded] = useState(task.status === 'error' && !task.diagnosis);
  const autoExpanded = useRef(expanded);
  useEffect(() => {
    if (task.status === 'error' && !task.diagnosis && !autoExpanded.current) {
      autoExpanded.current = true;
      setExpanded(true);
    }
  }, [task.status, task.diagnosis]);
  const statusColor = {
    running: 'var(--color-primary, #00f2ff)',
    ready: '#4caf50',
    completed: '#4caf50',
    error: '#f44336',
    stopped: '#888',
  }[task.status] || '#888';

  return (
    <div style={{
      background: 'var(--color-surface, #1a1a1a)',
      border: `1px solid ${task.status === 'error' ? 'rgba(244,67,54,0.3)' : 'var(--border, #2a2a2a)'}`,
      borderRadius: '10px', padding: '14px', transition: 'all 0.2s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
        role="button" tabIndex={0} aria-expanded={expanded}
        aria-label={`${task.model}, ${task.status}. ${expanded ? 'Collapse' : 'Expand'} task details`}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); }
        }}>
        <span style={{
          fontSize: '9px', padding: '2px 8px', borderRadius: '4px', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.5px',
          background: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)',
        }}>{task.type}</span>
        <span style={{ flex: 1, fontSize: '13px', fontWeight: 600 }}>{task.model}</span>
        {task.progress && (
          <span style={{ fontSize: '11px', color: statusColor }}>{task.progress}</span>
        )}
        <span style={{
          fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
          background: `color-mix(in srgb, ${statusColor} 15%, transparent)`,
          color: statusColor, fontWeight: 600,
        }}>{task.status}</span>
        <div style={{ display: 'flex', gap: '4px' }} onClick={e => e.stopPropagation()}>
          {task.status === 'running' && (
            <button onClick={onStop} style={{ ...tinyBtn, color: '#f44336' }} aria-label="Stop task" title="Stop task"><Square size={11} /></button>
          )}
          <button onClick={onCopy} style={tinyBtn} aria-label={copied ? 'Output copied' : 'Copy output'} title="Copy output">
            {copied ? <Check size={11} style={{ color: '#4caf50' }} /> : <Copy size={11} />}
          </button>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {task.diagnosis && (
        <div style={{
          marginTop: '8px', padding: '8px 10px', borderRadius: '6px', fontSize: '11px',
          background: 'rgba(244,67,54,0.06)', border: '1px solid rgba(244,67,54,0.15)',
          color: '#f44336',
        }}>
          <div style={{ marginBottom: '4px' }}>{task.diagnosis.message}</div>
          {task.diagnosis.suggestions?.length > 0 && (
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
              {task.diagnosis.suggestions.map((s, i) => (
                <span key={i} style={{
                  fontSize: '9px', padding: '2px 6px', borderRadius: '4px',
                  background: 'rgba(244,67,54,0.1)', border: '1px solid rgba(244,67,54,0.2)',
                }}>
                  {s.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {expanded && task.output_tail && (
        <pre style={{
          marginTop: '10px', padding: '10px', borderRadius: '6px', fontSize: '10px',
          background: 'rgba(0,0,0,0.3)', color: 'var(--text-dim)',
          overflow: 'auto', maxHeight: '300px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          fontFamily: 'var(--font-mono, monospace)',
        }}>
          {task.output_tail}
        </pre>
      )}
    </div>
  );
}

// ── Helpers ──
function shortGpuName(name) {
  return String(name || 'GPU')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^AMD\s+(Radeon\s+)?/i, '')
    .trim() || 'GPU';
}

// ── Shared Styles ──
const cardStyle = {
  background: 'var(--color-surface, #1a1a1a)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: '10px', padding: '12px',
};

const btnStyle = {
  display: 'flex', alignItems: 'center', gap: '5px',
  padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 600,
  cursor: 'pointer', border: '1px solid var(--border, #2a2a2a)',
  background: 'rgba(255,255,255,0.05)', color: 'var(--text, #e0e0e0)',
  transition: 'all 0.15s',
};

const tinyBtn = {
  background: 'none', border: 'none', color: 'var(--text-dim, #888)',
  cursor: 'pointer', padding: '3px', borderRadius: '4px', display: 'flex',
  alignItems: 'center', gap: '3px', fontSize: '11px',
};

const inputStyle = {
  padding: '7px 10px', borderRadius: '8px', fontSize: '12px',
  border: '1px solid var(--border, #2a2a2a)',
  background: 'rgba(0,0,0,0.2)', color: 'var(--text, #e0e0e0)',
  // No outline:none here — WCAG 2.4.7 requires a visible focus indicator and
  // this component has no CSS-class-based :focus rule to replace it with, so
  // we keep the browser's native focus ring instead of suppressing it.
  fontFamily: 'inherit',
};

const selectStyle = {
  padding: '7px 8px', borderRadius: '8px', fontSize: '11px',
  border: '1px solid var(--border, #2a2a2a)',
  background: 'rgba(0,0,0,0.2)', color: 'var(--text, #e0e0e0)',
  // See inputStyle note — native focus ring intentionally left in place.
  cursor: 'pointer',
};

const errorBox = {
  padding: '10px 14px', borderRadius: '8px', fontSize: '12px',
  background: 'rgba(244,67,54,0.08)', border: '1px solid rgba(244,67,54,0.2)',
  color: '#f44336', marginBottom: '12px',
};

const tagChip = (color) => ({
  fontSize: '9px', padding: '1px 6px', borderRadius: '4px', marginLeft: '6px',
  background: `color-mix(in srgb, ${color} 15%, transparent)`, color,
  fontWeight: 600, verticalAlign: 'middle',
});

const gpuBtn = {
  padding: '5px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
  cursor: 'pointer', border: '1px solid var(--border, #2a2a2a)',
  background: 'transparent', color: 'var(--text-dim, #888)',
  transition: 'all 0.15s',
};

const gpuBtnActive = {
  border: '1px solid var(--color-primary, #00f2ff)',
  background: 'rgba(0,242,255,0.08)',
  color: 'var(--color-primary, #00f2ff)',
};

const fieldLabel = {
  display: 'flex', flexDirection: 'column', gap: '3px',
  fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600,
};
