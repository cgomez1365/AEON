/**
 * AEON — legacy entry shim.
 * The monolith was dismantled (Jarvis refactor). The server now lives in:
 *   server/server.js       — composition root
 *   server/block-loader.js — cartridge discovery + sandbox
 *   services/              — settings, storage, cloud, ai, search, media, system
 *   security/security.js   — enforcement middleware + audit + SDI
 * This shim exists because `npm run server`, the Vercel wrapper
 * (api/index.js), and the Dockerfile CMD all point at server.cjs.
 * (The Electron shell that also used it was removed.)
 */
module.exports = require('./server/server.js');
