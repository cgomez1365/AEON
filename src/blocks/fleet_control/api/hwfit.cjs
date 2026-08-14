// routes/hwfit.js — Hardware Fitness: system detection, GPU grouping, VRAM-based model ranking
// Ported from hwfit_routes.py. Runs natively on Windows via child_process + os module.
const express = require('express');
const os = require('os');
const { execFile } = require('child_process');

const MANUAL_BACKENDS = new Set(['cuda', 'rocm', 'metal', 'cpu_x86', 'cpu_arm']);

module.exports = function createHwfitRouter(deps) {
  const router = express.Router();
  const detectionCache = {};
  const CACHE_TTL = 30 * 60 * 1000;

  // execFile, not exec: no shell is involved, so nothing here can ever be
  // reinterpreted as a command. Callers pass an executable and an argument
  // array. These probes are fixed literals today; the shape guarantees they
  // stay safe if a caller ever becomes dynamic.
  function runCmd(file, args = [], timeout = 10000) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err ? err.code : 0 });
      });
    });
  }

  // ── CPU Detection ──────────────────────────────────────────────

  function detectCpu() {
    const cpus = os.cpus();
    if (!cpus.length) return { model: 'Unknown', cores: 0, threads: 0, arch: os.arch() };
    const model = cpus[0].model.replace(/\s+/g, ' ').trim();
    const physicalCores = new Set(cpus.map(c => c.model)).size > 1
      ? cpus.length : Math.ceil(cpus.length / 2);
    return {
      model,
      cores: physicalCores,
      threads: cpus.length,
      arch: os.arch(),
      speed_mhz: cpus[0].speed,
    };
  }

  // ── RAM Detection ──────────────────────────────────────────────

  function detectRam() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const gb = (b) => Math.round(b / (1024 ** 3) * 10) / 10;

    // Operator finding F-03, 2026-08-12 — a MacBook Pro showed "32 GB RAM ·
    // 0.2 GB available" beside "Models are judged against 32.0 GB". Two
    // contradictory readings, inches apart, on the screen where the operator
    // decides which model to install.
    //
    // Both numbers were true and one was meaningless. os.freemem() reports
    // pages that are free RIGHT NOW; macOS deliberately spends almost all of
    // them on cache and reclaims on demand, so a perfectly healthy 32 GB Mac
    // reports a fraction of a gigabyte. Labelling that "available" invites the
    // reading "this machine has no room", which is false.
    //
    // The recommender ranks against TOTAL, so total is named as the basis and
    // the instantaneous figure is labelled for what it is. Nothing here changes
    // what fits — it changes what the operator is told, which is the defect.
    const misleadingFree = process.platform === 'darwin';

    return {
      total_gb: gb(totalBytes),
      free_now_gb: gb(freeBytes),
      // The figure the fit calculation actually uses. Stated, not implied.
      ranking_basis_gb: gb(totalBytes),
      free_now_note: misleadingFree
        ? 'macOS keeps free pages in cache and reclaims them on demand, so this reads far lower than the memory actually available to a model.'
        : null,
      // Retained for existing consumers; it has always been os.freemem().
      available_gb: gb(freeBytes),
    };
  }

  // ── GPU Detection (nvidia-smi) ─────────────────────────────────

  async function detectGpus() {
    const result = await runCmd('nvidia-smi', ['--query-gpu=index,name,memory.free,memory.total,memory.used,utilization.gpu,uuid', '--format=csv,noheader,nounits']);
    if (!result.ok || !result.stdout) return { gpus: [], error: result.stderr || 'nvidia-smi not found' };

    const gpus = [];
    for (const line of result.stdout.split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 7) continue;
      try {
        gpus.push({
          index: parseInt(parts[0]),
          name: parts[1],
          uuid: parts[6],
          vram_gb: Math.round(parseFloat(parts[3]) / 1024 * 10) / 10,
          free_gb: Math.round(parseFloat(parts[2]) / 1024 * 10) / 10,
          used_gb: Math.round(parseFloat(parts[4]) / 1024 * 10) / 10,
          util_pct: parseInt(parseFloat(parts[5])),
        });
      } catch { continue; }
    }
    return { gpus };
  }

  // ── GPU Grouping (homogeneous pools for tensor parallelism) ────

  function groupGpus(gpus) {
    const nameMap = {};
    for (const g of gpus) {
      const key = g.name;
      if (!nameMap[key]) nameMap[key] = { name: key, vram_each: g.vram_gb, count: 0, indices: [], vram_total: 0 };
      nameMap[key].count++;
      nameMap[key].indices.push(g.index);
      nameMap[key].vram_total = Math.round((nameMap[key].vram_total + g.vram_gb) * 10) / 10;
    }
    const groups = Object.values(nameMap).sort((a, b) => b.vram_total - a.vram_total);
    return groups;
  }

  // ── Full System Detection ──────────────────────────────────────

  async function detectSystem(fresh = false) {
    const cacheKey = 'local';
    if (!fresh && detectionCache[cacheKey] && (Date.now() - detectionCache[cacheKey].ts) < CACHE_TTL) {
      return { ...detectionCache[cacheKey].data };
    }

    const cpu = detectCpu();
    const ram = detectRam();
    const gpuResult = await detectGpus();
    const gpus = gpuResult.gpus || [];
    const gpuGroups = groupGpus(gpus);
    const totalVram = gpus.reduce((s, g) => s + g.vram_gb, 0);

    let backend = 'cpu_x86';
    if (cpu.arch === 'arm64' || cpu.arch === 'arm') backend = 'cpu_arm';
    if (gpus.length > 0) backend = 'cuda';

    const system = {
      hostname: os.hostname(),
      platform: process.platform === 'win32' ? 'windows' : process.platform,
      cpu_model: cpu.model,
      cpu_cores: cpu.cores,
      cpu_threads: cpu.threads,
      cpu_arch: cpu.arch,
      total_ram_gb: ram.total_gb,
      available_ram_gb: ram.available_gb,
      // F-03 — carried through so the UI can label the instantaneous figure
      // honestly and name the basis the recommender actually ranks against.
      free_now_gb: ram.free_now_gb,
      free_now_note: ram.free_now_note,
      ranking_basis_gb: ram.ranking_basis_gb,
      has_gpu: gpus.length > 0,
      gpu_name: gpus.length > 0 ? gpus[0].name : null,
      gpu_vram_gb: Math.round(totalVram * 10) / 10,
      gpu_count: gpus.length,
      gpus: gpus.map(g => ({ index: g.index, name: g.name, vram_gb: g.vram_gb })),
      gpu_groups: gpuGroups,
      homogeneous: gpuGroups.length <= 1,
      backend,
    };

    detectionCache[cacheKey] = { data: system, ts: Date.now() };
    return { ...system };
  }

  // ── Manual Hardware Override ───────────────────────────────────

  function applyManualHardware(system, opts) {
    const mode = (opts.manual_mode || '').toLowerCase();
    if (mode !== 'gpu' && mode !== 'ram') return system;

    let overrideRam = parseFloat(opts.manual_ram_gb) || 0;
    overrideRam = Math.max(0, overrideRam);
    if (overrideRam > 0) {
      system.available_ram_gb = Math.round(overrideRam * 10) / 10;
      system.total_ram_gb = Math.round(overrideRam * 10) / 10;
    }
    system.manual_hardware = true;

    if (mode === 'ram') {
      system.has_gpu = false;
      system.gpu_name = null;
      system.gpu_vram_gb = 0;
      system.gpu_count = 0;
      system.gpus = [];
      system.gpu_groups = [];
      system.backend = 'cpu_x86';
      delete system.unified_memory;
      return system;
    }

    let count = parseInt(opts.manual_gpu_count) || 1;
    let vramEach = parseFloat(opts.manual_vram_gb) || 8.0;
    count = Math.max(1, Math.min(count, 16));
    vramEach = Math.max(1.0, vramEach);
    let backend = (opts.manual_backend || system.backend || 'cuda').toLowerCase();
    if (!MANUAL_BACKENDS.has(backend)) backend = 'cuda';

    const totalVram = Math.round(vramEach * count * 10) / 10;
    const gpuName = `Simulated ${backend.toUpperCase()} GPU` + (count > 1 ? ` × ${count}` : '');

    system.has_gpu = true;
    system.gpu_name = gpuName;
    system.gpu_vram_gb = totalVram;
    system.gpu_count = count;
    system.gpus = Array.from({ length: count }, (_, i) => ({ index: i, name: gpuName, vram_gb: vramEach }));
    system.gpu_groups = [{
      name: gpuName,
      vram_each: vramEach,
      count,
      indices: Array.from({ length: count }, (_, i) => i),
      vram_total: totalVram,
    }];
    system.homogeneous = true;
    system.backend = backend;
    if (backend === 'metal') system.unified_memory = true;
    else delete system.unified_memory;

    return system;
  }

  // ── VRAM Estimation ────────────────────────────────────────────

  const QUANT_BYTES = {
    'fp32': 4.0, 'f32': 4.0,
    'fp16': 2.0, 'f16': 2.0, 'bf16': 2.0,
    'fp8': 1.0,
    'int8': 1.0, 'q8_0': 1.0, 'q8': 1.0,
    'int4': 0.5, 'q4_0': 0.5, 'q4_1': 0.55, 'q4_k_m': 0.55, 'q4_k_s': 0.5,
    'q5_0': 0.625, 'q5_1': 0.65, 'q5_k_m': 0.65, 'q5_k_s': 0.625,
    'q6_k': 0.75,
    'q3_k_s': 0.375, 'q3_k_m': 0.4, 'q3_k_l': 0.42,
    'q2_k': 0.3, 'q2_k_s': 0.28,
    'iq4_xs': 0.47, 'iq4_nl': 0.5,
    'iq3_xxs': 0.33, 'iq3_xs': 0.37, 'iq3_s': 0.38, 'iq3_m': 0.39,
    'iq2_xxs': 0.25, 'iq2_xs': 0.28, 'iq2_s': 0.3,
    'iq1_s': 0.18, 'iq1_m': 0.2,
    'awq': 0.5, 'awq-4bit': 0.5,
    'gptq': 0.5, 'gptq-4bit': 0.5,
    'exl2': 0.5,
  };

  function estimateVramGb(paramsB, quant, contextLen) {
    const bpp = QUANT_BYTES[(quant || 'fp16').toLowerCase()] || 2.0;
    const weightsGb = paramsB * bpp;
    const kvCacheGb = contextLen ? (paramsB * 0.0002 * contextLen / 1024) : 0;
    const overheadGb = Math.max(0.5, weightsGb * 0.1);
    return Math.round((weightsGb + kvCacheGb + overheadGb) * 10) / 10;
  }

  function extractParamsFromName(name) {
    const m = (name || '').match(/[-_/](\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])/);
    return m ? parseFloat(m[1]) : null;
  }

  function extractQuantFromName(name) {
    const m = (name || '').match(/(?:UD-)?(IQ[0-9]_[A-Z0-9_]+|Q[0-9](?:_[A-Z0-9]+)+|BF16|F16|FP16|FP8|F32|AWQ|GPTQ|EXL2)/i);
    return m ? m[0].toUpperCase() : null;
  }

  function fitModel(model, system, targetContext) {
    const paramsB = model.params_b || extractParamsFromName(model.name || model.repo_id || '');
    if (!paramsB) return { fit: 'unknown', reason: 'Cannot determine model size' };

    const quant = model.quant || extractQuantFromName(model.name || model.repo_id || '') || 'fp16';
    const ctx = targetContext || 4096;
    const neededGb = estimateVramGb(paramsB, quant, ctx);

    const gpuVram = system.gpu_vram_gb || 0;
    const ramGb = system.available_ram_gb || system.total_ram_gb || 0;

    if (system.has_gpu && gpuVram > 0) {
      if (neededGb <= gpuVram * 0.9) {
        return {
          fit: 'gpu', label: 'Fits GPU',
          needed_gb: neededGb, available_gb: gpuVram,
          headroom_pct: Math.round((1 - neededGb / gpuVram) * 100),
          quant, params_b: paramsB, context: ctx,
        };
      }
      if (neededGb <= gpuVram + ramGb * 0.5) {
        return {
          fit: 'offload', label: 'GPU + CPU Offload',
          needed_gb: neededGb, gpu_gb: gpuVram, ram_gb: ramGb,
          quant, params_b: paramsB, context: ctx,
        };
      }
    }

    const bpp = QUANT_BYTES[(quant || '').toLowerCase()] || 2.0;
    const ramNeeded = paramsB * bpp * 1.15;
    if (ramNeeded <= ramGb * 0.85) {
      return {
        fit: 'cpu', label: 'CPU/RAM Only',
        needed_gb: Math.round(ramNeeded * 10) / 10, available_gb: ramGb,
        quant, params_b: paramsB, context: ctx,
      };
    }

    return {
      fit: 'too_large', label: 'Does Not Fit',
      needed_gb: neededGb, available_gpu_gb: gpuVram, available_ram_gb: ramGb,
      quant, params_b: paramsB, context: ctx,
    };
  }

  // ── Built-in Model Catalog (popular models for ranking) ────────

  const MODEL_CATALOG = [
    { name: 'Qwen/Qwen2.5-0.5B', params_b: 0.5, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-1.5B', params_b: 1.5, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-3B', params_b: 3, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-7B', params_b: 7, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-14B', params_b: 14, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-32B', params_b: 32, context_length: 32768 },
    { name: 'Qwen/Qwen2.5-72B', params_b: 72, context_length: 32768 },
    { name: 'Qwen/Qwen3-0.6B', params_b: 0.6, context_length: 32768 },
    { name: 'Qwen/Qwen3-1.7B', params_b: 1.7, context_length: 32768 },
    { name: 'Qwen/Qwen3-4B', params_b: 4, context_length: 32768 },
    { name: 'Qwen/Qwen3-8B', params_b: 8, context_length: 32768 },
    { name: 'Qwen/Qwen3-14B', params_b: 14, context_length: 32768 },
    { name: 'Qwen/Qwen3-32B', params_b: 32, context_length: 32768 },
    { name: 'meta-llama/Llama-3.2-1B', params_b: 1, context_length: 131072 },
    { name: 'meta-llama/Llama-3.2-3B', params_b: 3, context_length: 131072 },
    { name: 'meta-llama/Llama-3.1-8B', params_b: 8, context_length: 131072 },
    { name: 'meta-llama/Llama-3.1-70B', params_b: 70, context_length: 131072 },
    { name: 'meta-llama/Llama-3.3-70B', params_b: 70, context_length: 131072 },
    { name: 'google/gemma-3-1b', params_b: 1, context_length: 32768 },
    { name: 'google/gemma-3-4b', params_b: 4, context_length: 32768 },
    { name: 'google/gemma-3-12b', params_b: 12, context_length: 32768 },
    { name: 'google/gemma-3-27b', params_b: 27, context_length: 32768 },
    { name: 'mistralai/Mistral-7B-v0.3', params_b: 7, context_length: 32768 },
    { name: 'mistralai/Mistral-Small-24B', params_b: 24, context_length: 32768 },
    { name: 'deepseek-ai/DeepSeek-R1-0528', params_b: 685, context_length: 65536 },
    { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', params_b: 1.5, context_length: 32768 },
    { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', params_b: 7, context_length: 32768 },
    { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', params_b: 14, context_length: 32768 },
    { name: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', params_b: 32, context_length: 32768 },
    { name: 'deepseek-ai/DeepSeek-V3-0324', params_b: 685, context_length: 65536 },
    { name: 'microsoft/phi-4', params_b: 14, context_length: 16384 },
    { name: 'microsoft/Phi-3.5-mini-instruct', params_b: 3.8, context_length: 131072 },
    { name: 'NousResearch/Hermes-3-Llama-3.1-8B', params_b: 8, context_length: 131072 },
    { name: 'nvidia/Llama-3.1-Nemotron-70B', params_b: 70, context_length: 131072 },
    { name: 'codellama/CodeLlama-7b-hf', params_b: 7, context_length: 16384 },
    { name: 'codellama/CodeLlama-13b-hf', params_b: 13, context_length: 16384 },
    { name: 'codellama/CodeLlama-34b-hf', params_b: 34, context_length: 16384 },
  ];

  const QUANT_VARIANTS = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'FP16', 'AWQ-4bit'];

  function rankModels(system, opts = {}) {
    const { search, quant, limit = 50, sort = 'fit', targetContext, fitOnly = false } = opts;
    const catalog = MODEL_CATALOG;

    let results = [];
    for (const model of catalog) {
      const name = model.name || '';
      if (search && !name.toLowerCase().includes(search.toLowerCase())) continue;

      const effectiveQuant = quant || 'Q4_K_M';
      const ctx = targetContext || Math.min(model.context_length || 4096, 32768);
      const result = fitModel({ ...model, quant: effectiveQuant }, system, ctx);

      if (fitOnly && (result.fit === 'too_large' || result.fit === 'unknown')) continue;

      const shortName = name.split('/').pop();
      results.push({
        name,
        short_name: shortName,
        params_b: model.params_b,
        context_length: model.context_length,
        quant: effectiveQuant,
        ...result,
      });
    }

    if (sort === 'fit' || sort === 'tightest') {
      const order = { gpu: 0, offload: 1, cpu: 2, too_large: 3, unknown: 4 };
      results.sort((a, b) => {
        const fitDiff = (order[a.fit] || 4) - (order[b.fit] || 4);
        if (fitDiff !== 0) return fitDiff;
        if (sort === 'tightest') return (a.headroom_pct || 100) - (b.headroom_pct || 100);
        return (b.params_b || 0) - (a.params_b || 0);
      });
    } else if (sort === 'size') {
      results.sort((a, b) => (b.params_b || 0) - (a.params_b || 0));
    } else if (sort === 'newest') {
      // catalog order is roughly newest-first
    }

    return results.slice(0, limit);
  }

  // ── Serve Profiles (Quality / Balanced / Speed) ────────────────

  function computeServeProfiles(system, model) {
    const paramsB = model.params_b || extractParamsFromName(model.name || '');
    if (!paramsB) return [];
    const gpuVram = system.gpu_vram_gb || 0;
    const ramGb = system.total_ram_gb || 0;

    const profiles = [];

    const qualityCtx = Math.min(model.context_length || 8192, 32768);
    const qualityFit = fitModel({ params_b: paramsB, quant: 'Q6_K' }, system, qualityCtx);
    if (qualityFit.fit === 'gpu' || qualityFit.fit === 'offload') {
      profiles.push({
        name: 'Quality',
        quant: 'Q6_K',
        context: qualityCtx,
        n_gpu_layers: qualityFit.fit === 'gpu' ? -1 : Math.floor(paramsB * 3),
        fit: qualityFit.fit,
        est_vram_gb: qualityFit.needed_gb,
      });
    }

    const balancedCtx = Math.min(model.context_length || 8192, 16384);
    const balancedFit = fitModel({ params_b: paramsB, quant: 'Q4_K_M' }, system, balancedCtx);
    if (balancedFit.fit !== 'too_large') {
      profiles.push({
        name: 'Balanced',
        quant: 'Q4_K_M',
        context: balancedCtx,
        n_gpu_layers: balancedFit.fit === 'gpu' ? -1 : Math.floor(paramsB * 2),
        fit: balancedFit.fit,
        est_vram_gb: balancedFit.needed_gb,
      });
    }

    const speedFit = fitModel({ params_b: paramsB, quant: 'IQ4_XS' }, system, 4096);
    if (speedFit.fit !== 'too_large') {
      profiles.push({
        name: 'Speed',
        quant: 'IQ4_XS',
        context: 4096,
        n_gpu_layers: -1,
        fit: speedFit.fit,
        est_vram_gb: speedFit.needed_gb,
      });
    }

    return profiles;
  }

  // ── Routes ─────────────────────────────────────────────────────

  router.get('/hwfit/system', async (req, res) => {
    try {
      const fresh = req.query.fresh === 'true';
      const system = await detectSystem(fresh);
      res.json(system);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  router.get('/hwfit/models', async (req, res) => {
    try {
      const fresh = req.query.fresh === 'true';
      let system = await detectSystem(fresh);

      if (req.query.ignore_detected_gpu === 'true') {
        system.has_gpu = false;
        system.gpu_name = null;
        system.gpu_vram_gb = 0;
        system.gpu_count = 0;
        system.gpus = [];
        system.gpu_groups = [];
      }
      if (req.query.ignore_detected_ram === 'true') {
        system.available_ram_gb = 0;
        system.total_ram_gb = 0;
      }

      system = applyManualHardware(system, {
        manual_mode: req.query.manual_mode || '',
        manual_gpu_count: req.query.manual_gpu_count || '',
        manual_vram_gb: req.query.manual_vram_gb || '',
        manual_ram_gb: req.query.manual_ram_gb || '',
        manual_backend: req.query.manual_backend || '',
      });

      system.detected_gpu_vram_gb = system.gpu_vram_gb;
      system.detected_gpu_count = system.gpu_count;

      const groups = system.gpu_groups || [];
      let grp = null;
      if (groups.length) {
        const gidx = parseInt(req.query.gpu_group) || 0;
        if (gidx >= 0 && gidx < groups.length) grp = groups[gidx];
      }

      const gpuCountParam = req.query.gpu_count;
      if (gpuCountParam !== undefined && gpuCountParam !== '') {
        const n = parseInt(gpuCountParam);
        if (!isNaN(n)) {
          if (n === 0) {
            system.has_gpu = false;
            system.gpu_vram_gb = 0;
            system.gpu_count = 0;
            system.gpu_only = false;
          } else if (grp) {
            const clamped = Math.max(1, Math.min(n, grp.count));
            system.gpu_count = clamped;
            system.gpu_vram_gb = Math.round(grp.vram_each * clamped * 10) / 10;
            system.gpu_name = grp.name;
            system.active_group = { ...grp, use_count: clamped };
            system.gpu_only = true;
          } else {
            const singleVram = (system.gpu_vram_gb || 0) / Math.max(system.gpu_count || 1, 1);
            system.gpu_count = Math.max(1, n);
            system.gpu_vram_gb = Math.round(singleVram * Math.max(1, n) * 10) / 10;
            system.gpu_only = true;
          }
        }
      } else if (grp) {
        system.gpu_count = grp.count;
        system.gpu_vram_gb = Math.round(grp.vram_each * grp.count * 10) / 10;
        system.gpu_name = grp.name;
        system.active_group = { ...grp, use_count: grp.count };
      }

      let targetContext = null;
      if (req.query.ctx) {
        targetContext = parseInt(req.query.ctx);
        if (isNaN(targetContext)) targetContext = null;
        else targetContext = Math.max(1024, Math.min(targetContext, 1000000));
      }

      const results = rankModels(system, {
        search: req.query.search || '',
        quant: req.query.quant || '',
        limit: parseInt(req.query.limit) || 50,
        sort: req.query.sort || 'fit',
        targetContext,
        fitOnly: req.query.fit_only === 'true',
      });

      res.json({ system, models: results });
    } catch (e) {
      res.json({ system: { error: e.message }, models: [], error: e.message });
    }
  });

  router.get('/hwfit/profiles', async (req, res) => {
    try {
      const fresh = req.query.fresh === 'true';
      const system = await detectSystem(fresh);
      if (system.error) return res.json({ system, profiles: [], error: system.error });

      const modelName = req.query.model || '';
      if (!modelName) return res.json({ system, profiles: [], error: 'model param required' });

      const norm = (s) => (s || '').toLowerCase().split('/').pop()
        .replace(/[-_.]?gguf$/i, '')
        .replace(/[-_.](q\d[^/]*|iq\d[^/]*|fp8|bf16|f16|awq[^/]*|gptq[^/]*)$/i, '');

      const want = norm(modelName);
      let match = MODEL_CATALOG.find(m => m.name === modelName);
      if (!match) {
        match = MODEL_CATALOG.find(m => {
          const n = norm(m.name);
          return n && (n === want || want.endsWith(n) || n.endsWith(want));
        });
      }
      if (!match) {
        const paramsB = extractParamsFromName(modelName);
        if (paramsB) {
          match = { name: modelName, params_b: paramsB, context_length: 32768 };
        }
      }
      if (!match) return res.json({ system, profiles: [], error: 'model not in catalog' });

      const profiles = computeServeProfiles(system, match);
      const modelCtxMax = match.context_length || 0;

      res.json({ system, profiles, model_ctx_max: modelCtxMax });
    } catch (e) {
      res.json({ system: { error: e.message }, profiles: [], error: e.message });
    }
  });

  router.get('/hwfit/fit', async (req, res) => {
    try {
      const fresh = req.query.fresh === 'true';
      let system = await detectSystem(fresh);
      system = applyManualHardware(system, {
        manual_mode: req.query.manual_mode || '',
        manual_gpu_count: req.query.manual_gpu_count || '',
        manual_vram_gb: req.query.manual_vram_gb || '',
        manual_ram_gb: req.query.manual_ram_gb || '',
        manual_backend: req.query.manual_backend || '',
      });

      const modelName = req.query.model || '';
      const paramsB = parseFloat(req.query.params_b) || extractParamsFromName(modelName) || null;
      if (!paramsB) return res.json({ error: 'Cannot determine model size. Pass params_b or include size in model name.' });

      const quant = req.query.quant || extractQuantFromName(modelName) || 'Q4_K_M';
      const ctx = parseInt(req.query.ctx) || 4096;

      const result = fitModel({ params_b: paramsB, quant }, system, ctx);
      res.json({ system, ...result });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  return router;
};
