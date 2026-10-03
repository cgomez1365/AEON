const express = require('express');

const kernelContext = require('../context.cjs');
const blockSettings = require('../blockSettings.cjs');
const agentsKernel = require('../agents.cjs');

// The identity, then how it is laid out on screen — one voice, in that order.
// kernelContext.FORMATTING is shared with the streaming path so the terminal
// and the browser cannot be told two different things; see its definition in
// src/kernel/context.cjs for why it is two sentences and why the second one
// is not optional.
const IDENTITY = 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise. When the user asks you to do something, do it directly. When you use a retrieved document, cite its source file. '
  + kernelContext.FORMATTING;

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
    const { message, history = [], contextTokens, agent: agentRef = null } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message required' });
    }
    // The same agent rules as the streaming chat: a wake that names an agent
    // hands it the turn; otherwise the caller's agent, else the operator's own.
    let agents = [];
    try { agents = agentsKernel.list(VAULT_ROOT, { withStats: false }); } catch {}
    const woke = agentsKernel.detectWake(message, agents);
    const agent = woke.agent || (agentRef ? agentsKernel.get(VAULT_ROOT, agentRef, agents) : null) || agents.find((a) => a.self) || null;
    if (typeof kernelLLM !== 'function') {
      return res.status(503).json({
        error: 'No model is available to answer.',
        noProviderAvailable: true,
        remedy: 'Assign a model to the chat role in Settings → Model Assignment, or install a local model in Cookbook.',
      });
    }

    let prefs = {};
    let skills = [];
    let mem = blockSettings.get('memory_core', {});
    try {
      const settings = _loadSettings ? _loadSettings() : null;
      prefs = settings?.prefs?.brain_settings || {};
      mem = blockSettings.get('memory_core', settings || {});
      skills = (settings?.prefs?.brain_skills || [])
        .filter(sk => sk.status === 'approved' && sk.body)
        .slice(0, prefs.skill_max_injected || 30);
    } catch { /* settings are optional; a missing file is a fresh install */ }

    const wake = woke.wake;
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
      memoryEnabled: mem.memory_in_context !== false,
      autoMemoryEnabled: !!mem.auto_memory,
      // Same default as the streaming route: two chats, one memory rule.
      maxCount: wake ? 0 : Math.max(Number(mem.memory_max_context) || 200, 0),
      skills,
      agent,
    });

    const prompt = kernelContext.composePrompt({
      identity: agentsKernel.identityFor(agent, IDENTITY),
      memoryText: assembled.memory.text,
      history,
      query: assembled.query,
      recallContext: assembled.recall.context,
    });

    try {
      const text = await kernelLLM(prompt, { role: 'chat', ...agentsKernel.callOptions(agent) });
      res.json({
        text,
        role: 'chat',
        agent: agent ? { id: agent.id, name: agent.name, self: !!agent.self } : null,
        query: assembled.query,
        // Everything the caller needs to say what this turn consulted (R01,
        // R03): counts, whether recall actually ran, and the citations.
        meta: assembled.meta,
        citations: assembled.meta.citations,
      });
    } catch (err) {
      // 429 = temporary (a rate limit): the caller should wait, not report a
      // fault. It was 500, so a block could not tell "wait a minute" from
      // "something broke" (agent C2, 2026-09-23).
      const status = err.rateLimited ? 429 : err.noProviderAvailable ? 503 : 500;
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
    const { prompt, role, provider, model, background, advisorModel, agent: agentRef } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    // `agent` runs the call as one of the operator's agents: its model, and
    // its privacy (a Local only agent is never answered by a cloud model).
    // A block can give its unattended jobs an agent of their own this way.
    let agentOpts = {};
    if (agentRef) {
      const agent = agentsKernel.get(VAULT_ROOT, agentRef);
      if (!agent) return res.status(404).json({ error: `No agent called "${agentRef}". GET /api/agents lists them.` });
      agentOpts = agentsKernel.callOptions(agent);
    }
    try {
      const text = await kernelLLM(prompt, {
        role, background, advisorModel, ...agentOpts,
        ...(provider ? { provider } : {}), ...(model ? { model } : {}),
      });
      res.json({ text, role: role || 'chat' });
    } catch (err) {
      // 503 = nothing is configured to answer (no API key, no local chat
      // model) — a state the user can fix, so it must not read as an internal
      // error. 500 stays for real faults. The 409 "local needs confirming"
      // branch is gone with the gate it served (BO-H1c): nothing has set
      // needsLocalConfirm since BO-2 removed it.
      // 429 = temporary (a rate limit): the caller should wait, not report a
      // fault. It was 500, so a block could not tell "wait a minute" from
      // "something broke" (agent C2, 2026-09-23).
      const status = err.rateLimited ? 429 : err.noProviderAvailable ? 503 : 500;
      res.status(status).json({
        error: err.message,
        noProviderAvailable: !!err.noProviderAvailable,
        ...(err.rateLimited ? { retryable: true, provider: err.provider || null } : {}),
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
