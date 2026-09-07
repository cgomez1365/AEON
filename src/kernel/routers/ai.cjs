const express = require('express');

const kernelContext = require('../context.cjs');

const IDENTITY = 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise. When the user asks you to do something, do it directly. When you use a retrieved document, cite its source file.';

module.exports = function createAIRouter(deps) {
  const router = express.Router();
  const { kernelLLM, kernelVision, VAULT_ROOT = null, _loadSettings = null } = deps;

  // POST /api/ai/converse — a conversational turn with both memory tiers.
  //
  // BO-MEM M1b. The terminal had no conversational path at all: free text
  // either resolved to a registered command or died with "nothing matched",
  // and its only model seam was POST /api/ai — a bare prompt, no memory, no
  // vault. So the same question answered with sources in the browser was
  // answered from the model's training data at the command line.
  //
  // This is that turn, served by the kernel so the terminal never assembles
  // memory itself (Doctrine R04: it holds session state, never memory of
  // record) and both surfaces get the same recall policy from the same place
  // (R05). The caller supplies the line and the recent turns of its own
  // session; everything else is policy and lives in src/kernel/context.cjs.
  router.post('/converse', async (req, res) => {
    const { message, history = [], contextTokens } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }
    if (typeof kernelLLM !== 'function') {
      return res.status(503).json({
        error: 'No model is available to answer.',
        noProviderAvailable: true,
        remedy: 'Assign a model to the chat role in Settings → Model Assignment, or install a local model in Cookbook.',
      });
    }

    let prefs = {};
    let skills = [];
    try {
      const settings = _loadSettings ? _loadSettings() : null;
      prefs = settings?.prefs?.brain_settings || {};
      skills = (settings?.prefs?.brain_skills || [])
        .filter(sk => sk.status === 'approved' && sk.body)
        .slice(0, prefs.skill_max_injected || 30);
    } catch { /* settings are optional; a missing file is a fresh install */ }

    const wake = kernelContext.WAKE_RE.test(message);
    const assembled = await kernelContext.assembleContext(message, {
      // Forwarded so the internal recall call is not refused by the guard —
      // and if it IS refused, the refusal is reported as a refusal.
      auth: { authorization: req.headers.authorization, cookie: req.headers.cookie },
      vaultRoot: VAULT_ROOT,
      // 8k is the documented safe floor. A local model may have less; the
      // budget arithmetic degrades gracefully (documents drop whole, and the
      // model is told) rather than overflowing.
      contextTokens: Number(contextTokens) || 8192,
      wake,
      memoryEnabled: prefs.memory_in_context !== false,
      autoMemoryEnabled: !!prefs.auto_memory,
      maxCount: wake ? 0 : Math.max(prefs.memory_max_context || 25, 0),
      skills,
    });

    const prompt = kernelContext.composePrompt({
      identity: IDENTITY,
      memoryText: assembled.memory.text,
      history,
      query: assembled.query,
      recallContext: assembled.recall.context,
    });

    try {
      const text = await kernelLLM(prompt, { role: 'chat' });
      res.json({
        text,
        role: 'chat',
        query: assembled.query,
        // Everything the caller needs to say what this turn consulted (R01,
        // R03): counts, whether recall actually ran, and the citations.
        meta: assembled.meta,
        citations: assembled.meta.citations,
      });
    } catch (err) {
      const status = err.noProviderAvailable ? 503 : 500;
      res.status(status).json({
        error: err.message,
        noProviderAvailable: !!err.noProviderAvailable,
        remedy: err.noProviderAvailable
          ? 'Assign a model to the chat role in Settings → Model Assignment, or install a local model in Cookbook.'
          : undefined,
        meta: assembled.meta,
      });
    }
  });

  router.post('/', async (req, res) => {
    const { prompt, role, provider, model, background, advisorModel } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
      const text = await kernelLLM(prompt, { role, provider, model, background, advisorModel });
      res.json({ text, role: role || 'chat' });
    } catch (err) {
      // 503 = nothing is configured to answer (no API key, no local chat
      // model) — a state the user can fix, so it must not read as an internal
      // error. 500 stays for real faults. The 409 "local needs confirming"
      // branch is gone with the gate it served (BO-H1c): nothing has set
      // needsLocalConfirm since BO-2 removed it.
      const status = err.noProviderAvailable ? 503 : 500;
      res.status(status).json({
        error: err.message,
        noProviderAvailable: !!err.noProviderAvailable,
      });
    }
  });

  // POST /api/ai/vision — read an image via the "vision" role (Settings →
  // Model Assignment). Single entry point shared by the Neural Terminal's
  // image upload and the Mission Runner's read_image tool.
  router.post('/vision', async (req, res) => {
    const { image, prompt, provider, model } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image (data: URI) required' });
    if (!kernelVision) return res.status(501).json({ error: 'vision not available on this deployment' });
    try {
      const text = await kernelVision(image, prompt || 'Describe this image in detail.', provider ? { provider, model } : {});
      res.json({ text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
