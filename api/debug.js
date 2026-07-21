// Minimal debug endpoint — does the Express app even load?
module.exports = (req, res) => {
  try {
    const app = require('../server.cjs');
    res.json({ ok: true, type: typeof app, routes: app._router ? app._router.stack.filter(l => l.route).length : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack.split('\n').slice(0, 8) });
  }
};
