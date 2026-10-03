// The running AEON's version, from package.json at build time (vite.config.js
// defines __AEON_VERSION__). Blank where nothing defined it (tests, tools).
/* global __AEON_VERSION__ */
export const AEON_VERSION = typeof __AEON_VERSION__ !== 'undefined' ? __AEON_VERSION__ : '';
export const versionLabel = () => (AEON_VERSION ? `v${AEON_VERSION}` : '');
