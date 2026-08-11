const express = require('express');

module.exports = function createAIRouter(deps) {
  const router = express.Router();
  const { kernelLLM, kernelVision } = deps;

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
