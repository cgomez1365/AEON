// No hardcoded machine path fallback — an unset VITE_AEON_WORKSPACE means the
// frontend simply doesn't know the workspace root. Consumers that send this
// to the backend as a dirPath (files/index.jsx) already fall back to the
// server's own correctly-resolved WORKSPACE when they receive an empty
// string (see host_os/api/fs.cjs: `dirPath || WORKSPACE`) — a hardcoded
// fallback here silently pointed every fresh clone at this dev machine's
// path instead of letting that real fallback do its job.
const AEON_WORKSPACE = import.meta.env.VITE_AEON_WORKSPACE || '';

export const WORKSPACE = AEON_WORKSPACE;
// (Removed legacy GEMINI_DATA / SECOND_BRAIN / AGENTS_DIR exports — they pointed
// at the old Command Center `Data\.gemini\...` layout that no longer exists. The
// Second Brain / Matrix now lives under the block's own Vault. Only the dead,
// unmounted DataNotes.jsx referenced them, and it has been removed.)

export const SB_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
