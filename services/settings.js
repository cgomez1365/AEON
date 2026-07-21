/**
 * AEON Jarvis — Settings Service
 * Single reader for aeon-settings.json (the nervous system's kernel view).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The settings block API and the first-run guard both use src/aeon-settings.json.
// This service MUST read the same file — it previously pointed at a nonexistent
// root-level file, so the whole kernel ran on the hardcoded fallback below
// (wrong roles, no prefs). Found 2026-07-16.
const SETTINGS_FILE = path.join(ROOT, 'src', 'aeon-settings.json');

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch {
    // Every role defaults to the same shared local model rather than a
    // specific tag per role — this fires only when aeon-settings.json can't
    // be read at all, so it should degrade to "whatever's installed," not
    // assume a specific coder/reasoning model exists.
    let m = process.env.OLLAMA_MODEL || null;
    if (!m) {
      // Whatever the Cookbook registry says is installed — never an assumed tag.
      try {
        const rt = JSON.parse(fs.readFileSync(path.join(process.env.DATA_PATH || path.join(ROOT, 'data'), 'local-runtime.json'), 'utf8'));
        m = rt?.models?.find(x => x.backend === 'ollama' && x.ready !== false)?.id || null;
      } catch {}
    }
    return { models: { chat: { provider: 'ollama', model: m }, grading: { provider: 'ollama', model: m }, research: { provider: 'ollama', model: m }, creative: { provider: 'ollama', model: m }, agent_worker: { provider: 'ollama', model: m }, agent_heavy: { provider: 'ollama', model: m }, agent_final: { provider: 'ollama', model: m } }, roulette: false, prefs: { allow_local_llm: true } };
  }
};

module.exports = { loadSettings, SETTINGS_FILE };
