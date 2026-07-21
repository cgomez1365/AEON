const WebSocket = require('ws');

module.exports = function attachWS(server, deps) {
  const { aeonTerminalStream } = deps;
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

    const onLog = (evt) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(evt));
      }
    };
    aeonTerminalStream.on('log', onLog);

    ws.on('close', () => aeonTerminalStream.removeListener('log', onLog));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
      } catch {}
    });
  });

  console.log('[KERNEL] WebSocket server attached at /ws');
  return wss;
};
