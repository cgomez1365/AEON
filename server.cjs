/**
 * AEON — legacy entry shim.
 * The monolith was dismantled (Jarvis refactor). The server now lives in:
 *   server/server.js       — composition root
 *   server/block-loader.js — cartridge discovery + sandbox
 *   services/              — settings, storage, cloud, ai, search, media, system
 *   security/security.js   — enforcement middleware + audit + SDI
 * This shim exists because Electron (electron/main.js), npm run server, and
 * the Vercel wrapper (api/index.js) all point at server.cjs.
 */
module.exports = require('./server/server.js');
