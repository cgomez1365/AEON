const express = require('express');

module.exports = function createTelemetryRouter(deps) {
  const router = express.Router();
  const { _llmTelemetry, _trackLLM } = deps;

  router.get('/', (req, res) => {
    const models = Object.values(_llmTelemetry.calls).sort((a, b) => b.requests - a.requests);
    res.json({
      totalCalls: _llmTelemetry.totalCalls,
      totalTokens: _llmTelemetry.totalTokens,
      models,
      uptime: Math.floor(process.uptime()),
    });
  });

  router.post('/report', (req, res) => {
    const { engine, model, tokens, latencyMs, success } = req.body;
    if (engine && model) _trackLLM(engine, model, tokens || 0, latencyMs || 0, success !== false);
    res.json({ ok: true });
  });

  return router;
};
