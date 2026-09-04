const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createFsRouter(deps) {
  const router = express.Router();
  const { isVercel, WORKSPACE, upload, VAULT_ROOT, getDataFile } = deps;

  // ── Path containment ──────────────────────────────────────────────
  // Every route below took a path straight from the request body and handed
  // it to fs. `{"targetPath": "/Users/me/.ssh/id_rsa"}` against /fs/delete
  // did exactly what it says. The File Manager UI only ever navigates inside
  // the roots below, so nothing legitimate is lost by requiring it — and
  // "the UI would never send that" is not a control, it is an assumption
  // about a client that anyone can replace with curl.
  //
  // Browsing the whole disk is a deliberate feature of /fs/list (see its
  // comment), and the hub can legitimately edit, upload to, and delete inside
  // any folder it can browse — so reads and writes share one boundary rather
  // than writes being pinned to the workspace. Narrowing writes to the
  // workspace alone would have broken the ordinary "browse to ~/Documents and
  // drop a file there" flow the File Manager exists for.
  //
  // What the boundary actually buys: the process cannot be steered outside
  // the operator's own home (no /etc, /System, /Library, no other user's
  // files), and cannot touch credentials or persistence hooks even inside it.
  const os = require('os');
  const HOME = path.resolve(os.homedir());

  const ROOTS = [HOME, WORKSPACE, VAULT_ROOT].filter(Boolean).map(r => path.resolve(r));

  // Refused inside an allowed root. Credential stores and shell configuration
  // are what a path-traversal bug is worth stealing; LaunchAgents and the
  // startup folders are what it is worth writing, since a file placed there
  // runs on next login. A file manager needs none of them.
  const DENIED = [
    '.ssh', '.aws', '.gnupg', '.config/gcloud', '.kube', '.docker',
    '.npmrc', '.netrc', '.git-credentials', '.zsh_history', '.bash_history',
    '.zshrc', '.bashrc', '.profile', '.zprofile', '.zshenv', '.bash_profile',
    'Library/Keychains', 'Library/LaunchAgents', 'Library/LaunchDaemons',
    'AppData/Roaming/Microsoft/Windows/Start Menu',
    // AEON's own secrets — the vault is reachable through the kernel's vault
    // API, which authorizes each read, never as raw bytes over the file API.
    'secrets', '.env', '.git',
  ];

  function containmentError(resolved, roots) {
    return `Path is outside the allowed area. "${resolved}" is not within ${roots.join(' or ')}.`;
  }

  /**
   * Resolve a request-supplied path and confirm it stays inside `roots`.
   *
   * Resolution happens BEFORE the prefix test, so "../" is already collapsed
   * by the time containment is judged — testing the raw string would pass
   * `${WORKSPACE}/../../etc/passwd`. The separator on the prefix test matters
   * too: without it "/Vault" would also match "/Vault-backup".
   *
   * @returns {{ok: true, path: string} | {ok: false, error: string, status: number}}
   */
  function safePath(input, { write = false } = {}) {
    const requested = typeof input === 'string' ? input.trim() : '';
    if (!requested) return { ok: false, status: 400, error: 'A file path is required.' };
    if (requested.includes('\0')) return { ok: false, status: 400, error: 'Path contains an invalid character.' };

    const roots = ROOTS;
    if (!roots.length) return { ok: false, status: 500, error: 'No workspace is configured on this install.' };

    const base = WORKSPACE || VAULT_ROOT || HOME;
    const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(base, requested));

    const inside = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!inside) return { ok: false, status: 403, error: containmentError(resolved, roots) };

    // A root itself may be listed and read, but never written over or removed
    // — deleting HOME or the workspace is not an operation the file manager
    // offers, and no legitimate caller asks for it.
    if (write && roots.includes(resolved)) {
      return { ok: false, status: 403, error: 'That is a top-level folder. Change what is inside it, not the folder itself.' };
    }

    // Compare against the path relative to its root so a denied segment is
    // matched as a real path component, not as a substring of a longer name
    // ("my.env.notes" is not ".env", "sshkeys" is not ".ssh").
    const root = roots.find(r => resolved === r || resolved.startsWith(r + path.sep));
    const rel = path.relative(root, resolved);
    const segments = rel.split(path.sep).filter(Boolean);
    for (const denied of DENIED) {
      const parts = denied.split('/');
      for (let i = 0; i + parts.length <= segments.length; i++) {
        if (parts.every((p, j) => segments[i + j] === p)) {
          return { ok: false, status: 403, error: `"${denied}" holds credentials or shell configuration and is not reachable through the file manager.` };
        }
      }
    }

    return { ok: true, path: resolved };
  }

  // Reject with the reason the caller can act on. §08: say what was refused
  // and why, not a bare 403.
  function refuse(req, res, verdict) {
    return res.status(verdict.status).json({
      correlation_id: req.correlationId || 'AEON-SYS',
      error: verdict.error,
      blocked: true,
    });
  }

  // ── Desktop-only ──────────────────────────────────────────────────
  // Every route in this router reaches the host filesystem, which exists only
  // where AEON runs as a desktop process; on Vercel the repo FS is read-only
  // and belongs to the deployment, not the operator. This was previously the
  // same `if (isVercel)` line repeated at the top of six handlers, which is
  // six chances to forget it — /fs/lock and /fs/serve had in fact already
  // forgotten. One gate in front of the router cannot be skipped by a route
  // added later.
  router.use((req, res, next) => {
    if (isVercel) {
      return res.status(403).json({
        error: 'The file manager reads this computer\'s own disk, so it only runs on the desktop app.',
      });
    }
    next();
  });

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
    const { dirPath } = req.body;
    // Default landing = the Vault. New users start where added files light
    // up the Matrix immediately; the breadcrumb still walks the whole disk.
    const requested = dirPath || VAULT_ROOT || WORKSPACE;
    const verdict = safePath(requested);
    if (!verdict.ok) return refuse(req, res, verdict);
    const target = verdict.path;
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
    const { filePath } = req.body || {};
    const requested = typeof filePath === 'string' ? filePath.trim() : '';
    if (!requested) {
      return res.status(400).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'filePath is required. Usage: /read <filePath> — relative paths resolve against the workspace.',
      });
    }

    const root = WORKSPACE || VAULT_ROOT || process.cwd();
    const verdict = safePath(requested);
    if (!verdict.ok) return refuse(req, res, verdict);
    const resolved = verdict.path;

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
    const { filePath, content } = req.body;
    const verdict = safePath(filePath, { write: true });
    if (!verdict.ok) return refuse(req, res, verdict);
    const target = verdict.path;
    // Add-only lock: creating a NEW file is adding; overwriting an existing
    // one is editing the real disk — that needs the hub unlocked.
    if (readLock() && fs.existsSync(target)) {
      return res.status(423).json({ locked: true, error: 'File Manager is in add-only mode. Unlock it (🔓) to edit existing files — changes affect the real files on this computer.' });
    }
    try {
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      res.json({ success: true, path: target, bytes: Buffer.byteLength(content, 'utf8') });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/mkdir
  //
  // Creating a folder is ADDING, which the add-only lock permits by design —
  // the same reason /fs/upload is allowed while locked. It still refuses to
  // write over something that already exists there: silently succeeding on a
  // path already occupied by a file is a lie about what happened.
  router.post('/fs/mkdir', (req, res) => {
    const { dirPath } = req.body;
    const verdict = safePath(dirPath, { write: true });
    if (!verdict.ok) return refuse(req, res, verdict);
    const target = verdict.path;
    try {
      if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
        return res.status(409).json({
          correlation_id: req.correlationId || 'AEON-SYS',
          error: `A file already exists at ${target}. Pick a different folder name.`,
        });
      }
      fs.mkdirSync(target, { recursive: true });
      res.json({ success: true, path: target });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/rename — rename in place, or move to another folder.
  //
  // BO-BUG F-3. The hub could create, read, write, upload and delete, but not
  // rename or move: a file put in the wrong folder had to be downloaded and
  // re-uploaded to get anywhere else. Both are the same rename(2) call, so
  // they are one route — `to` is a full destination path, which lets the UI
  // send either a sibling name or a path in another folder without the server
  // having to guess which one was meant.
  router.post('/fs/rename', (req, res) => {
    const { from, to } = req.body || {};

    // Moving a file changes where it lives on the real disk — that is an edit,
    // not an add, and it needs the hub unlocked exactly as delete does.
    if (readLock()) {
      return res.status(423).json({ locked: true, error: 'File Manager is in add-only mode. Unlock it (🔓) to rename or move — this changes the real file on this computer.' });
    }

    const src = safePath(from, { write: true });
    if (!src.ok) return refuse(req, res, src);
    const dst = safePath(to, { write: true });
    if (!dst.ok) return refuse(req, res, dst);

    try {
      if (!fs.existsSync(src.path)) {
        return res.status(404).json({ correlation_id: req.correlationId || 'AEON-SYS', error: `Not found: ${src.path}` });
      }
      // Never overwrite silently. The operator asked to move one file, not to
      // destroy another that happened to share the destination name.
      if (fs.existsSync(dst.path)) {
        return res.status(409).json({
          correlation_id: req.correlationId || 'AEON-SYS',
          error: `${path.basename(dst.path)} already exists in that folder. Rename it or pick another destination.`,
        });
      }
      fs.mkdirSync(path.dirname(dst.path), { recursive: true });
      fs.renameSync(src.path, dst.path);
      if (deps.writeOSAudit) { try { deps.writeOSAudit('FS_RENAME', `${src.path} → ${dst.path}`, 200, 0); } catch {} }
      res.json({ success: true, from: src.path, to: dst.path });
    } catch (error) {
      // EXDEV: source and destination are on different volumes, where rename(2)
      // cannot work. Copy-then-unlink is the standard fallback and is what the
      // operator meant by "move".
      if (error.code === 'EXDEV') {
        try {
          fs.copyFileSync(src.path, dst.path);
          fs.unlinkSync(src.path);
          return res.json({ success: true, from: src.path, to: dst.path, crossDevice: true });
        } catch (e2) {
          return res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: e2.message });
        }
      }
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  // POST /api/fs/delete
  router.post('/fs/delete', (req, res) => {
    const { targetPath } = req.body;
    if (readLock()) {
      return res.status(423).json({ locked: true, error: 'File Manager is in add-only mode. Unlock it (🔓) to delete — this removes the real file from this computer\'s disk.' });
    }
    const verdict = safePath(targetPath, { write: true });
    if (!verdict.ok) return refuse(req, res, verdict);
    const target = verdict.path;
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
      if (deps.writeOSAudit) { try { deps.writeOSAudit('FS_DELETE', target, 200, 0); } catch {} }
      res.json({ success: true, deleted: target });
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
    const verdict = safePath(filePath);
    if (!verdict.ok) return refuse(req, res, verdict);
    const target = verdict.path;
    try {
      if (!fs.existsSync(target)) return res.status(404).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'File not found' });
      const ext = path.extname(target).toLowerCase();
      const mimeMap = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.html': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown' };
      // Anything not on the map is sent as a download rather than rendered.
      // Serving arbitrary disk content inline lets an .html or .svg from the
      // vault execute script in the app's own origin — same-origin access to
      // everything the operator is signed into.
      const known = mimeMap[ext];
      res.setHeader('Content-Type', known || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const inlineSafe = known && ext !== '.html' && ext !== '.svg';
      if (req.query.download === '1' || !inlineSafe) {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(target).replace(/"/g, '')}"`);
      }
      fs.createReadStream(target).pipe(res);
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message });
    }
  });

  return router;
};
