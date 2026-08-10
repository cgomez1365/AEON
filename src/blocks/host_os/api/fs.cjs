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
  //
  // BO-D2e #16/#17. Two defects, both from the same missing step: this took
  // `filePath` and handed it straight to readFileSync.
  //
  //   /read              → "ENOENT ... open ''"  — a raw Node error, empty
  //                        path, naming neither the command nor a remedy.
  //                        The dispatcher's argument contract now refuses
  //                        this first; the check here is the backstop for a
  //                        direct API caller.
  //   /read VP_CONTEXT.md → looked in Desktop\AEON\ and reported not-found,
  //                        while the file sat in Desktop\Reports\. A relative
  //                        path resolved against process.cwd() — the repo the
  //                        server happened to be started from — even though
  //                        this command's own description says "from the
  //                        workspace".
  //
  // Relative paths now resolve against the workspace, which makes that
  // description true. Absolute paths are untouched: the File Manager
  // deliberately browses the whole disk (see /fs/list).
  router.post('/fs/read', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { filePath } = req.body || {};
    const requested = typeof filePath === 'string' ? filePath.trim() : '';
    if (!requested) {
      return res.status(400).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'filePath is required. Usage: /read <filePath> — relative paths resolve against the workspace.',
      });
    }

    const root = WORKSPACE || VAULT_ROOT || process.cwd();
    const resolved = path.isAbsolute(requested) ? requested : path.resolve(root, requested);

    try {
      const content = fs.readFileSync(resolved, 'utf8');
      res.json({ success: true, path: resolved, content, lines: content.split('\n').length });
    } catch (error) {
      // §08 — say WHERE it looked. "Not found" without the path it tried is
      // what sent the operator hunting for a file that was never missing.
      const notFound = error.code === 'ENOENT';
      res.status(notFound ? 404 : 500).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: notFound
          ? `Not found: ${resolved}`
          : error.message,
        ...(notFound && !path.isAbsolute(requested)
          ? { searchedIn: root, hint: `Relative paths resolve against the workspace (${root}). Pass an absolute path to read outside it.` }
          : {}),
      });
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
  }, (req, res, next) => {
    // BO-H8b — multer had no error handler. LIMIT_FILE_SIZE against the 50 MB
    // cap, and any error the storage engine passes to cb(), had nowhere to
    // land: it fell through to the global handler as an opaque 500, or worse.
    // Wrapping it here keeps the failure attached to the route that caused it
    // and gives the size limit the 413 it has always deserved.
    upload.array('files', 20)(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      const tooMany = err.code === 'LIMIT_FILE_COUNT';
      res.status(tooBig ? 413 : 400).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: tooBig ? 'File exceeds the 50 MB upload limit.'
          : tooMany ? 'Too many files — 20 per upload.'
          : err.message,
        code: err.code || 'UPLOAD_FAILED',
      });
    });
  }, (req, res) => {
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
