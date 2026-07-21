const SB_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

export async function sbRead(blockTag) {
  if (!SB_URL) return null;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/aeon_blocks?block_tag=eq.${blockTag}&select=payload`, { headers: sbH });
    const rows = await res.json();
    return rows?.[0]?.payload || null;
  } catch { return null; }
}

export async function sbWrite(blockTag, payload) {
  if (!SB_URL) return;
  try {
    await fetch(`${SB_URL}/rest/v1/aeon_blocks`, {
      method: 'POST',
      headers: { ...sbH, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ block_tag: blockTag, payload, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

export async function fetchWithFallback(apiPath, blockTag, opts = {}) {
  try {
    const res = await fetch(apiPath, opts);
    if (res.ok) return res.json();
  } catch {}
  if (blockTag) {
    const data = await sbRead(blockTag);
    if (data) return data;
  }
  return null;
}

export { SB_URL, SB_KEY, sbH };
