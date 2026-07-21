// Vercel Serverless Proxy: /api/fs/read
// Local dev never hits this file — src/blocks/host_os/api/fs.cjs owns local
// disk reads there. host_os is targets.vercel:false, so this is the ONLY
// implementation of /api/fs/read when deployed to Vercel: it proxies generic
// JSON reads (DataNotes.jsx, getLocalFile()-mapped db/*.json) to the
// Supabase `app_state` table since there's no persistent local filesystem.
//
// NOTE: this was previously ESM (`import`/`export default`), but
// package.json declares "type": "commonjs" and this file is require()'d
// directly by the auto-generated api/index.js (scripts/gen-vercel-mounts.cjs).
// ESM syntax there throws "Cannot use import statement outside a module" at
// require-time, which the mount loop's try/catch swallows — the route
// silently never mounted. Rewritten as CommonJS plugin-pattern to match
// api/notes.js in this same folder (a proven-working mount).
module.exports = (app, deps) => {
  const respondCors = (res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  };

  const handler = async (req, res) => {
    respondCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    // Soft dependency — same fail-soft contract as services/cloud.js / kernel/supabase.js.
    const supabase = deps && deps.supabase;
    if (!supabase) {
      return res.status(503).json({ error: 'Cloud storage not configured — add Supabase keys in Settings.', content: '[]' });
    }

    try {
      const key = filePath.split('\\').pop().split('/').pop().replace('.json', '');

      const { data, error } = await supabase
        .from('app_state')
        .select('data')
        .eq('key', key)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'File not found in database', content: '[]' });
      }

      return res.status(200).json({ content: JSON.stringify(data.data) });
    } catch (error) {
      console.error('Vercel DB Read Error:', error);
      return res.status(500).json({ error: 'Failed to reach Database: ' + error.message });
    }
  };

  app.post('/api/fs/read', handler);
  app.options('/api/fs/read', handler);
};
