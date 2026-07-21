const express = require('express');

module.exports = function createEventsRouter(deps) {
  const router = express.Router();
  const { aeonTerminalStream } = deps;

  router.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: ' + JSON.stringify({ type: 'connected', ts: Date.now() }) + '\n\n');

    const onLog = (evt) => {
      res.write('data: ' + JSON.stringify(evt) + '\n\n');
    };
    aeonTerminalStream.on('log', onLog);
    req.on('close', () => aeonTerminalStream.removeListener('log', onLog));
  });

  return router;
};
