const { createClient } = require("@supabase/supabase-js");
const { vaultSync } = require('../../../kernel/vaultSync.cjs');
const cloud = require('../../../kernel/server-utils/cloudGuard.cjs');

// =============================================
//  /api/notes — Cloud Notes CRUD
//  Stores and retrieves CEO notes from Supabase.
//  Table: aeon_notes (id, title, body, tags, created_at, updated_at)
//  Auth: anon key + open RLS policy (server-only, no browser exposure)
//
//  Offline behaviour (BO-E4): with no Supabase credentials this used to build
//  a client from `undefined` and await forever — GET and POST both hung with
//  no response at all. It now refuses immediately with 503, and every query
//  carries a deadline so "configured but unreachable" is bounded too.
// =============================================

const { supabaseConfig } = cloud;

const getSupabase = () => {
  const { url, key } = supabaseConfig();
  return createClient(url, key);
};

// Route: /api/notes
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cloud.requireCloud(res, { service: 'Supabase', feature: 'Cloud Notes' })) return;

  const supabase = getSupabase();

  // ── GET /api/notes — List all notes ──────────────────────────
  if (req.method === 'GET') {
    const { tag, q } = req.query;
    let query = supabase.from('aeon_notes').select('*').order('updated_at', { ascending: false });
    if (tag) query = query.contains('tags', [tag]);
    if (q) query = query.ilike('body', `%${q}%`);
    const { data, error } = await query.limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, notes: data });
  }

  // ── POST /api/notes — Create a new note ──────────────────────
  if (req.method === 'POST') {
    const { title, body, tags = [] } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });
    
    // Auto-tag notes created via this API as 'ceo_note' unless they come from an agent that overrides tags
    const finalTags = [...new Set([...tags, 'ceo_note'])];

    const { data, error } = await supabase.from('aeon_notes').insert([{
      title: title || `Note — ${new Date().toLocaleDateString()}`,
      body,
      tags: finalTags,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]).select().single();
    if (error) return res.status(500).json({ error: error.message });
    try { (async () => { const { count } = await supabase.from('aeon_notes').select('*', { count: 'exact', head: true }); vaultSync('files', { total_files: { value: count || 0, unit: 'count', context: 'total notes in aeon_notes' }, last_upload: { value: new Date().toISOString(), unit: 'timestamp', context: 'last note created' }, _summary: `Note created: "${data.title}" (${count || 0} total)` }); })(); } catch(e) { /* non-critical */ }
    return res.status(201).json({ success: true, note: data });
  }

  // ── PUT /api/notes — Update existing note ────────────────────
  if (req.method === 'PUT') {
    const { id, title, body, tags } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (body !== undefined) updates.body = body;
    if (tags !== undefined) updates.tags = tags;
    const { data, error } = await supabase.from('aeon_notes').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    try { (async () => { const { count } = await supabase.from('aeon_notes').select('*', { count: 'exact', head: true }); vaultSync('files', { total_files: { value: count || 0, unit: 'count', context: 'total notes in aeon_notes' }, last_upload: { value: new Date().toISOString(), unit: 'timestamp', context: 'last note updated' }, _summary: `Note updated: "${data.title}" (${count || 0} total)` }); })(); } catch(e) { /* non-critical */ }
    return res.status(200).json({ success: true, note: data });
  }

  // ── DELETE /api/notes — Delete a note ────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const { error } = await supabase.from('aeon_notes').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    try { (async () => { const { count } = await supabase.from('aeon_notes').select('*', { count: 'exact', head: true }); vaultSync('files', { total_files: { value: count || 0, unit: 'count', context: 'total notes in aeon_notes' }, last_upload: { value: new Date().toISOString(), unit: 'timestamp', context: 'last note deletion' }, _summary: `Note deleted: id=${id} (${count || 0} remaining)` }); })(); } catch(e) { /* non-critical */ }
    return res.status(200).json({ success: true, deleted: id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports = (app, deps) => {
  // Supports GET, POST, PUT, DELETE by delegating to the internal handler.
  // The handler is wrapped in a deadline so a wedged upstream ends the REQUEST
  // rather than holding the socket open indefinitely (BO-E4).
  const methods = ['get', 'post', 'put', 'delete', 'options'];
  methods.forEach(m => app[m]('/api/notes', (req, res) => {
    cloud.withDeadline(Promise.resolve().then(() => _handler(req, res)), cloud.DEFAULT_DEADLINE_MS, 'Cloud Notes')
      .catch(err => { if (!res.headersSent) cloud.sendFailure(res, err, 'Cloud Notes'); });
  }));
};
