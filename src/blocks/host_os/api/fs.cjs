const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createFsRouter(deps) {
  const router = express.Router();
  const { isVercel, WORKSPACE, upload, VAULT_ROOT, getDataFile } = deps;

  // ── Edit lock — the hub touches REAL files on the user's disk ──────
  // Default is LOCKED = add-only: browsing, uploading, and new folders are
  // fine; overwriting or deleting anything requires the user to unlock
  // first. Enforced HERE (not just hidden buttons in the UI), persisted so
  // a restart doesn't silently unlock. 423 = HTTP "Locked".
  const LOCK_FILE = getDataFile ? path.join(getDataFile('host_os'), 'fs-lock.json') : null;
  function readLock() {
    try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).locked !== false; }
    catch { return true; } // no file = locked (safe default)
  }
  function writeLock(locked) {
    try {
      fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ locked: !!locked, changedAt: new Date().toISOString() }, null, 2));
    } catch {}
  }

  router.get('/fs/lock', (_req, res) => res.json({ ok: true, locked: readLock() }));
  router.post('/fs/lock', (req, res) => {
    const locked = !!(req.body && req.body.locked);
    writeLock(locked);
    if (deps.writeOSAudit) { try { deps.writeOSAudit('FS_LOCK', locked ? 'locked (add-only)' : 'UNLOCKED (full edit)', 200, 0); } catch {} }
    res.json({ ok: true, locked });
  });

  // POST /api/fs/list
  router.post('/fs/list', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { dirPath } = req.body;
    // Default landing = the Vault. New users start where added files light
    // up the Matrix immediately; the breadcrumb still walks the whole disk.
    const target = dirPath || VAULT_ROOT || WORKSPACE;
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const result = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(target, e.name),
        size: e.isFile() ? fs.statSync(path.join(target, e.name)).size : null
      }));
      res.json({ success: true, path: target, entries: result });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/read
  router.post('/fs/read', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { filePath } = req.body;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.json({ success: true, path: filePath, content, lines: content.split('\n').length });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/write
  router.post('/fs/write', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { filePath, content } = req.body;
    // Add-only lock: creating a NEW file is adding; overwriting an existing
    // one is editing the real disk — that needs the hub unlocked.
    if (readLock() && fs.existsSync(filePath)) {
      return res.status(423).json({ locked: true, error: 'File Manager is in add-only mode. Unlock it (🔓) to edit existing files — changes affect the real files on this computer.' });
    }
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      res.json({ success: true, path: filePath, bytes: Buffer.byteLength(content, 'utf8') });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/mkdir
  router.post('/fs/mkdir', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { dirPath } = req.body;
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      res.json({ success: true, path: dirPath });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/delete
  router.post('/fs/delete', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { targetPath } = req.body;
    if (readLock()) {
      return res.status(423).json({ locked: true, error: 'File Manager is in add-only mode. Unlock it (🔓) to delete — this removes the real file from this computer\'s disk.' });
    }
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
      res.json({ success: true, deleted: targetPath });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/upload
  router.post('/fs/upload', (req, res, next) => {
    console.log('--- Incoming upload request ---');
    next();
  }, upload.array('files', 20), (req, res) => {
    console.log('Upload parsed successfully. Files:', req.files?.length);
    try {
      const uploaded = (req.files || []).map(f => ({
        name: f.originalname,
        path: f.path,
        size: f.size
      }));
      console.log('Sending success response:', uploaded.map(u => u.name));
      res.json({ success: true, uploaded });
    } catch (error) {
      console.error('Upload Error:', error.message);
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // GET /api/fs/serve
  router.get('/fs/serve', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'path query param required' });
    try {
      if (!fs.existsSync(filePath)) return res.status(404).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'File not found' });
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.html': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown' };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  return router;
};
