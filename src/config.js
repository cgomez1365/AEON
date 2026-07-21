// No hardcoded machine path fallback — an unset VITE_AEON_WORKSPACE means the
// frontend simply doesn't know the workspace root. Consumers that send this
// to the backend as a dirPath (files/index.jsx) already fall back to the
// server's own correctly-resolved WORKSPACE when they receive an empty
// string (see host_os/api/fs.cjs: `dirPath || WORKSPACE`) — a hardcoded
// fallback here silently pointed every fresh clone at this dev machine's
// path instead of letting that real fallback do its job.
const AEON_WORKSPACE = import.meta.env.VITE_AEON_WORKSPACE || '';

export const WORKSPACE = AEON_WORKSPACE;
export const GEMINI_DATA = AEON_WORKSPACE + '\\Data\\.gemini';
export const SECOND_BRAIN = AEON_WORKSPACE + '\\Data\\.gemini\\Second Brain';
export const AGENTS_DIR = GEMINI_DATA + '\\.Agents';

export const SB_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
