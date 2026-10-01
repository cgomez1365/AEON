/**
 * AEON Terminal 2.0 — the window, not the switchboard.
 *
 * The terminal knows two verbs (sigil router):
 *   bare text → POST /api/chat/stream   (LLM, role from settings)
 *   /command  → POST /api/commands/dispatch (manifest-discovered registry)
 *
 * '>' used to run arbitrary OS commands. That route is gone: mixing chat, app
 * commands, key entry and raw shell in one input box gave the user no way to
 * know when they were changing their computer. Named OS operations live at
 * /api/os/action with typed arguments.
 *
 * Everything else lives in block manifests and the kernel:
 *   - command palette populated from GET /api/commands + client UI commands
 *   - confirmation gates arrive as 428 responses; rendered as inline
 *     firewall-intercept cards ([Y] execute / [N] deny)
 *   - every execution is an event chip: [0042] CMD /gpu … RUNNING → EXIT 0
 *   - failures stay in the transcript (failure-as-narrative, no toasts);
 *     provider fallbacks arrive as SSE `warning` events
 *
 * No hardcoded block logic, no provider keys, no environment checks.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Loader, Cpu, Clock, Zap, ChevronRight, ChevronDown, ShieldAlert, Paperclip, Square, X as XIcon, Archive, History, Plus, Trash2, Pencil, BookmarkPlus, Check, Sparkles } from 'lucide-react';
import { describeStreamFailure, SELF_REPORTED_HEADER } from '../utils/interceptorPolicy.js';
import { describeDispatchOutcome, describeDenial, describeCommandOutput } from '../utils/commandOutcome.js';

// ── Markdown rendering — the panel is a narrow column and nothing leaves it ──
//
// react-markdown was handed a components map with exactly ONE entry (the
// anchor), so every other element rendered at browser defaults. An unstyled
// <table> sizes itself to its content: in a 380px column the right-hand column
// wrapped to one character per line and ran past the panel edge — the operator's
// report of 2026-09-17, "responses will sometimes leak out of confinement".
//
// The answer is containment, not smaller type. A wide table gets its own
// horizontal scroller and scrolls sideways INSIDE the terminal; code gets its
// own; prose breaks a token wider than the column instead of pushing the
// layout. Nothing here shrinks or truncates an answer — the content is intact,
// it is the box that now holds the line.
//
// Defined at module scope on purpose. A components map rebuilt on every render
// is a new component TYPE on every render, so React would remount the whole
// answer and reset every table's scroll position on each streamed token.

// react-markdown dropped the `inline` prop in v9, and a hast node carries no
// parent pointer, so a <code> cannot tell on its own whether it is a fenced
// block or a word in a sentence. The only honest answer comes from the
// ancestor that knows: <pre> says so.
const InPre = React.createContext(false);

// Every component merges an incoming `style` LAST. remark-gfm turns a table's
// alignment row into `style` on th/td, and spreading our own style after it
// would silently drop the operator's column alignment.
// Exported so the containment can be GATED rather than eyeballed — see
// tests/terminal-output-containment.test.js. Nothing else imports it today.
export const MD = {
  a: ({ node, style, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer"
      style={{ color: '#00f2ff', overflowWrap: 'anywhere', ...style }} />
  ),
  p: ({ node, style, ...rest }) => (
    <p {...rest} style={{ margin: '0 0 6px', lineHeight: 1.55, overflowWrap: 'anywhere', ...style }} />
  ),

  // A compact scale. In a 400px column the browser's 2em <h1> reads as
  // shouting and eats a third of the width, so hierarchy is carried by weight
  // and colour with only a little size behind it.
  h1: ({ node, style, ...rest }) => (
    <h1 {...rest} style={{ fontSize: 14.5, fontWeight: 700, color: '#e8f0fa', letterSpacing: '0.02em', margin: '12px 0 5px', paddingBottom: 3, borderBottom: '1px solid #1e2d45', overflowWrap: 'anywhere', ...style }} />
  ),
  h2: ({ node, style, ...rest }) => (
    <h2 {...rest} style={{ fontSize: 13, fontWeight: 700, color: '#e8f0fa', letterSpacing: '0.02em', margin: '10px 0 4px', overflowWrap: 'anywhere', ...style }} />
  ),
  h3: ({ node, style, ...rest }) => (
    <h3 {...rest} style={{ fontSize: 12.2, fontWeight: 700, color: '#b9cbe0', margin: '9px 0 3px', overflowWrap: 'anywhere', ...style }} />
  ),
  h4: ({ node, style, ...rest }) => (
    <h4 {...rest} style={{ fontSize: 11.5, fontWeight: 700, color: '#8aa0b8', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '8px 0 3px', overflowWrap: 'anywhere', ...style }} />
  ),

  ul: ({ node, style, ...rest }) => (
    <ul {...rest} style={{ margin: '4px 0 7px', paddingLeft: 18, ...style }} />
  ),
  ol: ({ node, style, ...rest }) => (
    <ol {...rest} style={{ margin: '4px 0 7px', paddingLeft: 20, ...style }} />
  ),
  li: ({ node, style, ...rest }) => (
    <li {...rest} style={{ margin: '2px 0', lineHeight: 1.5, overflowWrap: 'anywhere', ...style }} />
  ),

  // The table scrolls SIDEWAYS inside its own box. Without this wrapper the
  // table's min-content width is the sum of its columns, and a grid/flex
  // ancestor has no choice but to grow or be overrun.
  table: ({ node, style, ...rest }) => (
    <div style={{ overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%', margin: '6px 0' }}>
      <table {...rest} style={{ borderCollapse: 'collapse', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', ...style }} />
    </div>
  ),
  thead: ({ node, style, ...rest }) => (
    <thead {...rest} style={{ background: 'rgba(0,242,255,0.06)', ...style }} />
  ),
  // nowrap on a cell is what stops the one-character-per-line column: the cell
  // wraps as a unit inside the scroller instead of being squeezed to nothing.
  th: ({ node, style, ...rest }) => (
    <th {...rest} style={{ border: '1px solid #1e2d45', padding: '4px 9px', textAlign: 'left', whiteSpace: 'nowrap', color: '#e8f0fa', fontWeight: 600, letterSpacing: '0.04em', ...style }} />
  ),
  td: ({ node, style, ...rest }) => (
    <td {...rest} style={{ border: '1px solid #16233a', padding: '3px 9px', whiteSpace: 'nowrap', verticalAlign: 'top', ...style }} />
  ),

  pre: ({ node, style, children, ...rest }) => (
    <InPre.Provider value={true}>
      <pre {...rest} style={{ margin: '6px 0', padding: '8px 10px', background: 'rgba(8,13,22,0.85)', border: '1px solid #16233a', borderRadius: 3, overflowX: 'auto', maxWidth: '100%', fontSize: 11.5, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre', ...style }}>{children}</pre>
    </InPre.Provider>
  ),
  code: ({ node, style, children, ...rest }) => {
    const block = React.useContext(InPre);
    // Inside <pre> the block above already owns the scroller, the face and the
    // padding; a second set here would double them.
    if (block) {
      return <code {...rest} style={{ background: 'none', border: 'none', padding: 0, fontSize: 'inherit', fontFamily: 'inherit', ...style }}>{children}</code>;
    }
    // overflow-wrap: anywhere, not white-space: nowrap. A token that fits moves
    // to the next line whole — never broken mid-token — and only a token wider
    // than the entire column is broken, which beats it leaving the panel.
    return (
      <code {...rest} style={{ background: 'rgba(0,242,255,0.07)', border: '1px solid #16233a', borderRadius: 2, padding: '0 4px', fontSize: '0.92em', fontFamily: "'JetBrains Mono', monospace", overflowWrap: 'anywhere', ...style }}>{children}</code>
    );
  },

  blockquote: ({ node, style, ...rest }) => (
    <blockquote {...rest} style={{ margin: '6px 0', padding: '2px 0 2px 10px', borderLeft: '2px solid #1e3a52', color: '#8aa0b8', ...style }} />
  ),
  hr: ({ node, style, ...rest }) => (
    <hr {...rest} style={{ border: 'none', borderTop: '1px solid #1e2d45', margin: '10px 0', ...style }} />
  ),
  strong: ({ node, style, ...rest }) => (
    <strong {...rest} style={{ color: '#e8f0fa', fontWeight: 600, ...style }} />
  ),
  em: ({ node, style, ...rest }) => (
    <em {...rest} style={{ fontStyle: 'italic', color: '#b9cbe0', ...style }} />
  ),
  img: ({ node, style, ...rest }) => (
    <img {...rest} style={{ maxWidth: '100%', height: 'auto', display: 'block', borderRadius: 3, margin: '6px 0', ...style }} />
  ),
};

// UI-only commands — act on the terminal or app itself, never the server.
// Block commands come from GET /api/commands (manifest-discovered); add nothing here.
const UI_COMMANDS = [
  { cmd: '/clear', desc: 'Clear the terminal history' },
  { cmd: '/help',  desc: 'List every available command' },
  { cmd: '/open',  desc: 'Open any block by name — /open matrix' },
  { cmd: '/model', desc: 'Open the model hotswap picker' },
];

let PID = 0;
const nextPid = () => String(++PID).padStart(4, '0');

// ── Event chip: one execution rendered as a process line ──────────────
function EventChip({ ev, onToggle }) {
  // D2c — five states, and only two of them carry an exit code. This used to
  // be a binary: 'ok' was green EXIT 0 and everything else was red EXIT 1,
  // so a command still WAITING on the operator had to be drawn as one or the
  // other. It was drawn as EXIT 0, above the red EXIT 1 of the run that
  // followed. EXIT 0 and EXIT 1 are claims about a finished run; a challenge
  // and a denial are not finished runs.
  const COLORS = {
    running: '#00f2ff',
    pending: '#ffb454',   // amber — waiting on a human
    ok: '#39ff14',
    denied: '#7d93a8',    // grey — the operator answered, nothing ran
    fail: '#ff4455',
  };
  const color = COLORS[ev.status] || COLORS.fail;
  const statusText =
    ev.status === 'running' ? 'RUNNING'
      : ev.status === 'pending' ? 'AWAITING APPROVAL'
        : ev.status === 'denied' ? 'DENIED'
          : ev.status === 'ok' ? `EXIT 0${ev.latencyMs ? ` · ${ev.latencyMs}ms` : ''}`
            : 'EXIT 1';
  return (
    <div style={{ borderTop: `1px solid ${color}33`, borderRight: `1px solid ${color}33`, borderBottom: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 3, margin: '4px 0', background: 'rgba(10,16,26,0.6)' }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>
        {ev.expanded ? <ChevronDown size={11} color={color} /> : <ChevronRight size={11} color={color} />}
        <span style={{ color: '#4a5568' }}>[{ev.pid}]</span>
        <span style={{ color, letterSpacing: '0.08em' }}>{ev.kind}</span>
        <span style={{ color: '#c8d6e8', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.label}</span>
        {(ev.status === 'running' || ev.status === 'pending') && <Loader size={11} color={color} className="spin" />}
        <span style={{ color, fontSize: 10 }}>{statusText}</span>
      </div>
      {ev.expanded && (
        <div className="chip-output" style={{ padding: '6px 12px 8px 30px', fontSize: 11, color: '#8aa0b8', borderTop: `1px solid ${color}22`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto', overflowX: 'hidden' }}>
          {/* Markdown, so a command that returns links returns LINKS. /orion
              used to print its sources as raw JSON in this box. */}
          {ev.output
            ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{ev.output}</ReactMarkdown>
            : '(no output)'}
        </div>
      )}
    </div>
  );
}

// ── Firewall intercept: inline confirmation for dangerous commands ────
function InterceptCard({ prompt, onAllow, onDeny }) {
  return (
    <div style={{ border: '1px solid #f59e0b', borderRadius: 3, margin: '6px 0', padding: '10px 14px', background: 'rgba(245,158,11,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: 11, letterSpacing: '0.1em', marginBottom: 6 }}>
        <ShieldAlert size={13} /> FIREWALL INTERCEPT
      </div>
      <div style={{ fontSize: 12, color: '#c8d6e8', marginBottom: 10, fontFamily: 'monospace' }}>{prompt}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onAllow} style={{ background: 'rgba(57,255,20,0.12)', border: '1px solid #39ff14', color: '#39ff14', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>[Y] EXECUTE</button>
        <button onClick={onDeny} style={{ background: 'rgba(255,68,85,0.1)', border: '1px solid #ff4455', color: '#ff4455', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>[N] DENY</button>
      </div>
    </div>
  );
}

const BOOT_MSG = { id: 0, type: 'msg', role: 'system', content: 'AEON Operator Console — link established. Type / for commands.' };

// The palette row has room for a clause, not the kernel's full sentence. The
// full reason stays on the row's title (hover) and in /help, and dispatching
// the command prints it in full — this is a preview, not a substitute.
function shortReason(reason) {
  const r = String(reason || '');
  if (/embedding model/i.test(r)) return 'needs an embedding model — download one in Cookbook';
  if (/Supabase/i.test(r)) return 'needs Supabase';
  if (/needs: /.test(r)) return r.replace(/^.*needs: /, 'needs ').replace(/\. Add them.*$/, '');
  return r.replace(/^\/\S+ /, '').split(/[.—]/)[0].trim() || 'unavailable';
}

// ── Pure pieces of the component below, exported so the node suite can hold
// them to account (tests/sweep-terminal-*.test.js). Nothing else imports them.

const isTurn = (e) => e && e.type === 'msg' && (e.role === 'user' || e.role === 'assistant');

/**
 * Split an SSE buffer into complete frames and keep the unfinished tail.
 *
 * The chat reader used to split on lines and pair each `event:` line with the
 * NEXT line of the same read. A read that ended between the two — nothing in
 * HTTP stops that, and the `done` frame, which carries the whole answer, is the
 * likeliest to be cut — threw the event line away, and its data line arrived
 * next read with nothing in front of it and was skipped too. A lost `done`
 * loses the truncation flag (a cut-off answer read as finished) and the token
 * count; a lost `error` left a blank turn. A frame ends at a blank line — the
 * server writes `event: X\ndata: …\n\n` — so that is the only boundary trusted.
 */
export function takeSSEFrames(buffer) {
  const parts = String(buffer).split('\n\n');
  const rest = parts.pop();
  const frames = [];
  for (const part of parts) {
    let event = 'message';
    const data = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

/**
 * Put a notice ABOVE the entry it explains.
 *
 * A fallback notice ("openrouter out of credits → groq") arrives while the
 * answer's bubble is already on screen, streaming. It was appended after it,
 * so when every provider failed the error bubble sat above its own causes
 * and read as if the switches came afterwards (2026-09-30). The bubble's id
 * is the anchor; with no such entry the notice goes at the end.
 */
export function insertBefore(feed, beforeId, entry) {
  const list = Array.isArray(feed) ? feed : [];
  const i = list.findIndex(e => e && e.id === beforeId);
  if (i === -1) return [...list, entry];
  return [...list.slice(0, i), entry, ...list.slice(i)];
}

/**
 * The part of the feed that is the conversation.
 *
 * A pending VAULT PLACEMENT card carries the dropped file itself as base64 (up
 * to 25 MB). It is a question waiting on the operator, not part of the chat, and
 * it rode along in every save: a 5–7 MB drop pushed each save body past the
 * server's 10 MB limit, and smaller ones were copied into every saved chat file.
 */
//
// A command chip's output is kept whole on screen but capped in the saved copy:
// a few /doc or /read chips of long documents pushed a save past the same
// limit, and then every per-turn save failed with 413 and New chat was refused
// for that chat indefinitely.
export const SAVED_CHIP_OUTPUT_MAX = 32 * 1024;
export function sessionEntries(feed) {
  return (Array.isArray(feed) ? feed : []).filter(e => e && e.type !== 'filedrop').map((e) => {
    if (e.type !== 'chip' || typeof e.output !== 'string' || e.output.length <= SAVED_CHIP_OUTPUT_MAX) return e;
    const more = e.output.length - SAVED_CHIP_OUTPUT_MAX;
    return { ...e, output: `${e.output.slice(0, SAVED_CHIP_OUTPUT_MAX)}\n[… ${more} more characters — shortened in the saved copy of this chat]` };
  });
}

/**
 * What a save response means.
 *
 * The route answers its failures as JSON too, so "a body arrived" is not
 * success. A 404/500 body is { error } and was read as a saved chat — the
 * button printed "Saved: undefined" — and the 404 echoes the id it could not
 * find, which was then adopted as this chat's id, so every later save 404'd.
 * 'gone' is that 404 for an id we sent: the record was deleted elsewhere or no
 * longer parses, and the conversation has to be kept as a new one. Only the
 * route's own answer counts (it names the id it looked for) — a 404 because
 * the Dashboard block is not mounted must not fork the chat into a new record.
 */
//
// 'unavailable' is that other 404, and the 503 a STOPPED block answers: chat
// history lives in the Dashboard block, and no save can land until it is back.
// Every turn used to add "[SESSION] This chat was not saved — HTTP 404", and
// New chat — the operator's way to reset the console — was refused for good.
export function readSaveResponse({ ok, status, body, sentId }) {
  if (ok && body && body.id) return { kind: 'saved', id: body.id, name: body.name, nameSetBy: body.nameSetBy };
  if (status === 404 && sentId && body && body.id === sentId) return { kind: 'gone' };
  if ((status === 404 || status === 503) && !(body && body.id)) {
    return {
      kind: 'unavailable',
      error: status === 503
        ? 'chat history is served by the Dashboard block, which is stopped. Start it: node tools/aeon-cli.cjs block start dashboard'
        : 'chat history is served by the Dashboard block, which is not installed. Restore it: node tools/aeon-cli.cjs block restore dashboard',
    };
  }
  return { kind: 'failed', error: (body && body.error) || `HTTP ${status}` };
}

// Chromium and WebKit refuse a beacon (and a keepalive fetch) whose payload is
// over 64 KiB: sendBeacon returns false and sends nothing. Headroom is left for
// the request's own framing.
export const BEACON_MAX_BYTES = 60 * 1024;

// How many times one page asks the model to title one chat (see saveSession).
const NAMING_TRIES = 3;

/**
 * What the page can still send as it closes.
 *
 * The beacon used to post the whole feed every time and ignore the answer, so
 * once a chat passed 64 KiB — a few long answers — a refresh or close sent
 * nothing, silently. Turns are now saved as they finish, so a close usually has
 * nothing left to send ('saved'); when it does and it is too big for a beacon,
 * the caller is told so instead of guessing.
 */
export function unloadSave({ feed, savedFeed, sessionId }) {
  if (!(feed || []).some(isTurn)) return { send: false, reason: 'empty' };
  if (feed === savedFeed) return { send: false, reason: 'saved' };
  const body = JSON.stringify({ id: sessionId || null, messages: sessionEntries(feed), autoSaved: true });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > BEACON_MAX_BYTES) return { send: false, reason: 'too_large', bytes };
  return { send: true, body, bytes };
}

/**
 * /clear lets a chat go — and must let go of its saved record too.
 *
 * It used to empty the feed and keep the id, so the next turn's save posted
 * the new conversation under the old id: the route replaces messages whole,
 * and the saved chat was overwritten under its old title without a word. New
 * chat has always dropped the id; /clear now does the same. The reset is done
 * now AND queued behind any save still in flight, because a save that lands
 * after /clear adopts the old id again.
 */
export function forgetSavedChat({ currentSessionId, savedFeedRef, saveChain }) {
  const forget = () => { currentSessionId.current = null; savedFeedRef.current = null; };
  forget();
  saveChain.current = saveChain.current.then(forget);
}

/**
 * The line the terminal prints after a distil.
 *
 * A repeat of an unchanged chat is refused before any model is asked, and the
 * server says so in `message`. Printing "nothing durable found — 0 candidates"
 * over that told the operator the chat held nothing worth keeping, when it had
 * simply been distilled already.
 */
export function distillSummary(d) {
  const n = d?.added?.length || 0;
  if (n) return `🧠 Added ${n} ${n === 1 ? 'memory' : 'memories'} to Memory Core from this chat.`;
  if (d?.alreadyDistilled || d?.message) return `🧠 ${d.message || 'Nothing new — this chat was already distilled.'}`;
  return `🧠 Nothing durable found in this chat — ${d?.candidates || 0} candidates, none new.`;
}

const Terminal2 = ({ onUsageUpdate }) => {
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState(null); // { dataUri, name }
  const fileInputRef = useRef(null);
  const docInputRef = useRef(null);   // /upload → native file picker (documents)
  const textareaRef = useRef(null);   // the chat field's own height, grown as it fills
  // Was a fixed-height <input>, one line, that scrolled its own text
  // sideways for anything longer — CEO, 2026-09-20: "chat box needs to be
  // a flex field". `rows={1}` sets a true minimum; this grows it to fit up
  // to the CSS maxHeight (160px, ~7 lines) and lets it scroll internally
  // past that, rather than pushing the whole terminal panel taller.
  // Height is measured from scrollHeight AFTER setting height to 'auto' —
  // reading scrollHeight without that reset would only ever grow, never
  // shrink, because the box's own prior height caps what scrollHeight can
  // report from itself.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);
  const [feed, setFeed] = useState([BOOT_MSG]);
  const [distilling, setDistilling] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [commands, setCommands] = useState([]);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const scrollRef = useRef();
  const feedId = useRef(1);
  // D1c — the generation currently in flight: { controller, streamId, msgId }.
  const activeChatRef = useRef(null);

  // ── Chat session persistence ──────────────────────────────────────────────
  const [sessions, setSessions] = useState([]);         // list metadata
  const [showSessions, setShowSessions] = useState(false);
  const [sessionSaving, setSessionSaving] = useState(false);
  // Which saved session this feed IS. Without it every save minted a new id, so
  // save-after-load forked the conversation and the unload beacon wrote a fresh
  // record on every refresh — one chat became a pile of near-duplicates.
  const currentSessionId = useRef(null);
  const [renaming, setRenaming] = useState(null);   // { id, value }
  const feedRef = useRef(feed); // always-fresh ref for unload handlers
  useEffect(() => { feedRef.current = feed; }, [feed]);
  const sessionIdRef = currentSessionId;
  // The feed exactly as the server last confirmed it saved. The same array
  // means nothing has changed since, so a hide or a close has nothing to send.
  const savedFeedRef = useRef(null);
  // Saves run one at a time. Two in flight for a chat that has no id yet would
  // each mint a record — the fork currentSessionId exists to prevent — and a
  // save after every turn makes that overlap ordinary rather than rare.
  const saveChain = useRef(Promise.resolve());
  // Session id → how many times this page has asked the model to title it
  // (see saveSession).
  const namingAsked = useRef(new Map());
  // Chat history unavailable (Dashboard block stopped or removed) has been said
  // once; automatic saves do not repeat it every turn until a save lands.
  const historyDownSaid = useRef(false);
  // Bumped when an operator action finishes; the effect below saves on it.
  const [turnsDone, setTurnsDone] = useState(0);
  const [sessionsError, setSessionsError] = useState(null);

  const fetchSessions = useCallback(async () => {
    // The list used to be whatever a 200 carried, and the server answered 200
    // [] for a folder it could not read — so the panel said "No saved sessions
    // yet" about chats that were all still on disk. A failure is now shown as
    // one.
    try {
      const r = await fetch('/api/terminal/sessions');
      const d = await r.json().catch(() => null);
      if (r.ok && Array.isArray(d)) { setSessions(d); setSessionsError(null); }
      else setSessionsError(d?.error || `HTTP ${r.status}`);
    } catch (e) { setSessionsError(e.message); }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // ── Two different verbs, deliberately next to each other ──
  //
  // SAVE keeps the chat: the whole thing, word for word, so it can be reopened
  // another day. DISTILL keeps what the chat was ABOUT: a handful of durable
  // facts in Memory Core that ride into future conversations. One is an
  // archive, the other is learning, and the operator wants them separate.
  //
  // This sends the LIVE feed rather than letting the server hunt for a saved
  // file. Memory Core's own button reads the newest session on disk, which is
  // right for it and wrong here: an active chat is not written out until it is
  // saved, so "distil what I am looking at" read whatever was saved last -
  // the operator distilled a Stephen King conversation and got memories about
  // an unrelated session that happened to be newer on disk.
  const distillToMemory = useCallback(async () => {
    const msgs = (feedRef.current || [])
      .filter(m => m.type === 'msg' && (m.role === 'user' || m.role === 'assistant'));
    if (msgs.length < 2) {
      push({ type: 'msg', role: 'system', content: 'Nothing to distil yet — have a conversation first.' });
      return;
    }
    setDistilling(true);
    try {
      const transcript = msgs.slice(-30)
        .map(m => `${m.role}: ${String(m.content || '').slice(0, 400)}`).join('\n');
      const r = await fetch('/api/memory/distill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      push({ type: 'msg', role: 'system', content: distillSummary(d) });
    } catch (e) {
      push({ type: 'msg', role: 'error', content: `[DISTILL] ${e.message}` });
    } finally { setDistilling(false); }
  }, []);

  // Resolves to { id, name, … } once the server has the chat, or null when
  // there was nothing to save or the save failed — and a failure is said in the
  // feed, never swallowed: every caller used to read a { error } body as saved.
  const saveSession = useCallback(({ name, autoSaved = false } = {}) => {
    const run = saveChain.current.then(async () => {
      const snapshot = feedRef.current;
      if (!snapshot.some(isTurn)) return null;
      setSessionSaving(true);
      const post = async (id) => {
        const r = await fetch('/api/terminal/sessions', {
          // The outcome is reported in the feed below, so the global banner
          // stays out of it (a 5xx still raises it — interceptorPolicy).
          method: 'POST', headers: { 'Content-Type': 'application/json', [SELF_REPORTED_HEADER]: '1' },
          body: JSON.stringify({ id, name, messages: sessionEntries(snapshot), autoSaved }),
        });
        const body = await r.json().catch(() => null);
        return readSaveResponse({ ok: r.ok, status: r.status, body, sentId: id });
      };
      try {
        let out = await post(currentSessionId.current);
        if (out.kind === 'unavailable') {
          if (!autoSaved || !historyDownSaid.current) {
            historyDownSaid.current = true;
            push({ type: 'msg', role: 'error', content: `[SESSION] This chat is not being saved — ${out.error}` });
          }
          return { unavailable: true };
        }
        historyDownSaid.current = false;
        if (out.kind === 'gone') {
          // The record this chat was saved to is gone — deleted in another tab
          // or device, or its file no longer parses. Holding on to its id made
          // every later save 404 and the conversation was never written again.
          currentSessionId.current = null;
          out = await post(null);
          if (out.kind === 'saved') push({ type: 'msg', role: 'system', content: `💾 The saved copy of this chat was gone, so it was saved again as a new chat: ${out.name}` });
        }
        if (out.kind !== 'saved') throw new Error(out.error);
        currentSessionId.current = out.id;
        savedFeedRef.current = snapshot;
        // Ask the model for a better title in the background. The
        // deterministic title is already in place, so this never blocks and a
        // failure changes nothing. The server refuses if the operator has
        // renamed this chat (R10). Chats save after every turn, so this is
        // bounded: from the second question on (after the first, the title
        // covered one question), at most NAMING_TRIES times per chat per page,
        // and not again once it is settled — a model title, a chat the
        // operator named, or no model to ask. A failed or unusable answer
        // used to end it for the page.
        const asked = namingAsked.current.get(out.id) || 0;
        const questions = snapshot.filter((m) => m.type === 'msg' && m.role === 'user').length;
        if (out.nameSetBy === 'auto' && questions >= 2 && asked < NAMING_TRIES) {
          namingAsked.current.set(out.id, asked + 1);
          fetch(`/api/terminal/sessions/${out.id}/name`, { method: 'POST' })
            .then((r) => r.json().catch(() => null))
            .then((d) => {
              if (d && (d.nameSetBy === 'model' || d.code === 'operator_named' || d.code === 'no_model')) namingAsked.current.set(out.id, NAMING_TRIES);
              return fetchSessions();
            })
            .catch(() => {});
        }
        await fetchSessions();
        return out;
      } catch (e) {
        push({ type: 'msg', role: 'error', content: `[SESSION] This chat was not saved — ${e.message}` });
        return null;
      } finally { setSessionSaving(false); }
    });
    saveChain.current = run;   // never rejects: the body catches its own failures
    return run;
  }, [fetchSessions]);

  const loadSession = useCallback(async (id) => {
    try {
      const r = await fetch(`/api/terminal/sessions/${id}`);
      const d = await r.json();
      if (d.messages) {
        // Swapped behind any save still in flight, and feedRef set now rather
        // than on the next commit: a save of the previous chat that finished
        // after this adopted ITS id over this one, and a save that started in
        // the gap wrote the previous chat's feed into this record.
        // The chain must never reject — every later save waits on it — so a
        // record that will not load is caught inside and reported below.
        let swapErr = null;
        await (saveChain.current = saveChain.current.then(() => {
          try {
            const nextId = Math.max(...d.messages.map(m => m?.id || 0), 0) + 1;
            const next = [...d.messages, { id: nextId, type: 'msg', role: 'system', content: `📂 Loaded: ${d.name}` }];
            feedId.current = nextId + 1;
            feedRef.current = next;
            savedFeedRef.current = next; // as saved; the "Loaded" line is not a turn
            // Adopt the session so the next save updates it instead of forking.
            currentSessionId.current = d.id;
            setFeed(next);
          } catch (err) { swapErr = err; }
        }));
        if (swapErr) throw swapErr;
        setShowSessions(false);
      }
    } catch (e) {
      setFeed(prev => [...prev, { id: feedId.current++, type: 'msg', role: 'error', content: `[SESSION] ${e.message}` }]);
    }
  }, []);

  // Delete is permanent (the route unlinks). A row listed as unreadable may
  // still hold most of a conversation — a half-written file, or a record whose
  // inner id does not match its file name — so it asks first. A refused
  // delete is said in the feed; it used to vanish silently.
  const deleteSession = useCallback(async (id, e, s = null) => {
    e.stopPropagation();
    if (s?.unreadable && !window.confirm(
      `"${id}.json" could not be opened as a saved chat (${s.error}), but the file may still hold most of the conversation.\n\nDelete it permanently? To keep it, cancel and open the file from the Vault's Agents/Aeon/chat_sessions folder.`)) return;
    try {
      const r = await fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        push({ type: 'msg', role: 'error', content: `[SESSION] ${id} was not deleted — ${d?.error || `HTTP ${r.status}`}` });
        return;
      }
      if (currentSessionId.current === id) currentSessionId.current = null;
      await fetchSessions();
    } catch (err) {
      push({ type: 'msg', role: 'error', content: `[SESSION] ${id} was not deleted — ${err.message}` });
    }
  }, [fetchSessions]);

  // Rename. The operator's word is final — the server marks the title
  // operator-set and the naming route refuses to touch it afterwards (R10).
  const renameSession = useCallback(async (id, name) => {
    const next = String(name || '').trim();
    if (!next) { setRenaming(null); return; }
    try {
      await fetch(`/api/terminal/sessions/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      await fetchSessions();
    } catch {}
    setRenaming(null);
  }, [fetchSessions]);

  // Put this conversation into the Second Brain, on purpose (R09). Saved chats
  // are deliberately NOT indexed automatically; this is the decision. Only the
  // operator's own turns are stored, so the model's words never become a source
  // a later answer can cite.
  const rememberSession = useCallback(async (id, e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/terminal/sessions/${id}/remember`, { method: 'POST' });
      const d = await r.json();
      setFeed(prev => [...prev, {
        id: feedId.current++, type: 'msg',
        role: d.ok ? 'system' : 'error',
        content: d.ok
          ? `🧠 Added to the Second Brain — ${d.ingested} of your turns are now searchable.`
          : `[REMEMBER] ${d.error}${d.remedy ? ` — ${d.remedy}` : ''}`,
      }]);
      await fetchSessions();
    } catch (err) {
      setFeed(prev => [...prev, { id: feedId.current++, type: 'msg', role: 'error', content: `[REMEMBER] ${err.message}` }]);
    }
  }, [fetchSessions]);

  // New chat — save current, start fresh
  const newChat = useCallback(async () => {
    const hasTurns = feedRef.current.some(isTurn);
    const saved = await saveSession({ autoSaved: true });
    // The result used to be ignored: a failed save was followed by a fresh
    // console anyway, and the only copy of the conversation left the screen.
    // saveSession has already said why it failed; the chat stays.
    // With chat history unavailable (the Dashboard block is stopped or
    // removed) no save can land until it is back, so the chat goes, and the
    // console says it was not kept.
    if (hasTurns && !saved) {
      push({ type: 'msg', role: 'system', content: 'New chat not started — this one is not saved yet, so it stays on screen. Try again, or /clear it to let it go.' });
      return;
    }
    const fresh = [{ ...BOOT_MSG, content: saved?.unavailable && hasTurns
      ? 'AEON Operator Console — new session started. The last chat was not kept: chat history is unavailable until the Dashboard block is back.'
      : 'AEON Operator Console — new session started.' }];
    // feedRef now, not on the next commit: a hide-save queued behind the save
    // above ran in that gap with the old feed and no id, and forked the chat
    // into a duplicate record.
    feedRef.current = fresh;
    setFeed(fresh);
    feedId.current = 1;
    currentSessionId.current = null;   // the next save is a NEW record, on purpose
    setShowSessions(false);
  }, [saveSession]);

  // Auto-save on page unload / tab hide (refresh, close, sleep).
  //
  // Found live, 2026-09-20 ("multiple saves for one chat"): a tab hide is NOT
  // a teardown — the page is still fully alive — but this used to route it
  // through the same sendBeacon fire-and-forget call as an actual unload.
  // sendBeacon has no response to read, so currentSessionId.current never
  // learned the id the server just minted; every later hide (alt-tab, switch
  // apps, lock the screen) repeated that with the ref still null, and each one
  // minted ANOTHER new session carrying the whole growing feed — one real chat
  // forked into a pile of near-duplicate saves, worst on a session that was
  // never explicitly saved by hand. A hide now goes through the normal
  // saveSession() — the same call the Save button makes — which awaits the
  // response and adopts the id, so the second hide updates instead of
  // forking. sendBeacon stays, but only for beforeunload, the one case where
  // the page really may not survive long enough for a normal fetch to land.
  //
  // Neither was ever enough on its own: a beacon over 64 KiB is refused, and
  // the hide save that fires during a close is an ordinary fetch the browser
  // cancels. So a chat is also saved each time a turn finishes (the effect
  // after this one) and a close only has to carry what changed since.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const plan = unloadSave({ feed: feedRef.current, savedFeed: savedFeedRef.current, sessionId: sessionIdRef.current });
      if (plan.reason === 'too_large') {
        console.warn(`[SESSION] ${plan.bytes} bytes is over the browser's beacon limit — the turns since the last save were not sent on close.`);
        return;
      }
      if (!plan.send) return;
      // Must use a Blob with application/json so the express JSON parser picks it up.
      const sent = navigator.sendBeacon('/api/terminal/sessions', new Blob([plan.body], { type: 'application/json' }));
      if (!sent) console.warn('[SESSION] the browser refused the closing save — the turns since the last save were not sent.');
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && feedRef.current !== savedFeedRef.current) saveSession({ autoSaved: true });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [saveSession]);

  // Save once each operator action has finished. An effect rather than a call
  // at the end of dispatch: the turn's last patch (the final text, streaming
  // off) is only in feedRef after it commits, and effects run in order, so the
  // feedRef effect above has already run by the time this one does.
  useEffect(() => {
    if (turnsDone) saveSession({ autoSaved: true });
  }, [turnsDone, saveSession]);

  const push = useCallback((entry) => {
    const id = feedId.current++;
    setFeed(prev => [...prev, { id, ...entry }]);
    return id;
  }, []);
  const pushBefore = useCallback((beforeId, entry) => {
    const id = feedId.current++;
    setFeed(prev => insertBefore(prev, beforeId, { id, ...entry }));
    return id;
  }, []);
  const patch = useCallback((id, updates) => {
    setFeed(prev => prev.map(e => e.id === id ? { ...e, ...(typeof updates === 'function' ? updates(e) : updates) } : e));
  }, []);

  // ── Pull the command registry from the kernel ──
  //
  // Unavailable commands are KEPT, not filtered. Filtering them made /ask,
  // /recall and /scan disappear on any install without an embedding model,
  // which read as "the command was removed" (CEO, 2026-09-10). They now show
  // dimmed with the kernel's own reason (c.reason), and dispatching one
  // returns the same sentence as a 409 — nothing is hidden, nothing lies.
  const loadCommands = useCallback(() => {
    fetch('/api/commands').then(r => r.json())
      .then(d => setCommands([...UI_COMMANDS, ...(d.commands || [])]))
      .catch(() => setCommands(prev => prev.length ? prev : [...UI_COMMANDS]));
  }, []);
  useEffect(() => { loadCommands(); }, [loadCommands]);

  // ── Model hotswap: providers grouped by key availability ──
  // Each group's `models` is {id, free}[], already sorted server-side
  // (src/kernel/modelIntelligence.cjs): free first, then a size/capability
  // guess read off the model name — never a real benchmark, hence `sortNote`.
  const [modelGroups, setModelGroups] = useState([]);
  const [modelSortNote, setModelSortNote] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const refreshModelGroups = () => fetch('/api/console/models').then(r => r.json())
    .then(d => { setModelGroups(d.groups || []); setModelSortNote(d.sortNote || ''); }).catch(() => {});
  // Lazy-load: fetch fresh data each time the picker opens so a key added in Settings appears immediately.
  useEffect(() => { if (showModelPicker) refreshModelGroups(); }, [showModelPicker]);

  const hotswapModel = async (provider, model) => {
    setShowModelPicker(false);
    if (!model) return;
    try {
      const res = await fetch('/api/console/model-swap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'chat', provider, model }),
      });
      const d = await res.json();
      push({ type: 'msg', role: d.ok ? 'system' : 'error', content: d.message || d.error || `chat → ${provider}/${model}` });
    } catch (e) { push({ type: 'msg', role: 'error', content: `[HOTSWAP] ${e.message}` }); }
  };

  // ── Drag & drop → vault placement recommendation ──
  const [dragOver, setDragOver] = useState(false);
  // One intake for a dropped file and for /upload's picker: read the bytes in
  // the browser, ask where it belongs, show the placement card. The operator
  // never leaves the terminal to put a reference file into the Matrix.
  const stageFile = async (file, via = 'drop') => {
    const tag = via === 'upload' ? 'UPLOAD' : 'DROP';
    if (file.size > 25 * 1024 * 1024) { push({ type: 'msg', role: 'error', content: `[${tag}] ${file.name} is over 25MB — use the Files block for large files.` }); return; }
    push({ type: 'msg', role: 'system', content: `📥 Reading ${file.name}… asking where it belongs in your Vault.` });
    const buf = await file.arrayBuffer();
    let binary = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = btoa(binary);
    try {
      const res = await fetch('/api/console/file-drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: b64, encoding: 'base64' }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'drop failed');
      push({ type: 'filedrop', name: file.name, content: b64, recommendation: d.recommendation, folders: d.folders || [], newFolder: '' });
    } catch (err) {
      const msg = /failed to fetch|networkerror|load failed/i.test(err.message) ? 'The AEON server is not reachable. Start it (npm run dev / node server.cjs) and try again — nothing was written.' : err.message;
      push({ type: 'msg', role: 'error', content: `[${tag}] ${msg}` });
    }
  };
  const onDrop = async (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) await stageFile(file, 'drop');
  };
  const onDocSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) { push({ type: 'msg', role: 'system', content: 'Upload cancelled — no file chosen.' }); return; }
    await stageFile(file, 'upload');
  };

  // Saving used to POST /console/file-save — a raw write into the vault that
  // indexed nothing, so the file was invisible to /recall until the next scan.
  // It now goes through the Matrix upload route: written, indexed, summarised.
  const saveDrop = async (entry, folder) => {
    const dest = String(folder || '').trim();
    if (!dest) { push({ type: 'msg', role: 'error', content: '[VAULT] Pick a folder, or type a new one.' }); return; }
    setFeed(prev => prev.filter(e => e.id !== entry.id));
    const chipId = push({ type: 'chip', pid: nextPid(), kind: 'CMD', label: `/upload ${entry.name} → ${dest}`, status: 'running', expanded: false });
    const t0 = Date.now();
    try {
      const res = await fetch('/api/crn/second-brain/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.name, contentBase64: entry.content, dest }),
      });
      const d = await res.json().catch(() => ({}));
      patch(chipId, { status: res.ok ? 'ok' : 'error', output: d.text || [d.error, d.remedy].filter(Boolean).join(' '), latencyMs: Date.now() - t0, expanded: true });
    } catch (e) {
      const msg = /failed to fetch|networkerror|load failed/i.test(e.message) ? 'The AEON server is not reachable. Start it and try again — nothing was written.' : e.message;
      patch(chipId, { status: 'error', output: `[VAULT] ${msg}`, latencyMs: Date.now() - t0, expanded: true });
    }
  };

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [feed]);

  // ── Sigil detection (live intent indicator) ──
  const sigil = input.startsWith('>') ? 'shell' : input.startsWith('/') ? 'cmd' : 'chat';
  const sigilGlyph = { chat: '◇', cmd: '/', shell: '>' }[sigil];
  const sigilColor = { chat: '#00f2ff', cmd: '#39ff14', shell: '#f59e0b' }[sigil];

  useEffect(() => {
    if (input.startsWith('/')) { setShowPalette(true); setPaletteFilter(input.toLowerCase()); }
    else setShowPalette(false);
  }, [input]);
  // Availability is live on the server (an embedding model downloaded in
  // Cookbook, Supabase linked in Settings). Re-read it each time the palette
  // opens so the terminal never needs a reload to notice — one small GET.
  useEffect(() => { if (showPalette) loadCommands(); }, [showPalette, loadCommands]);

  const filteredCommands = useMemo(() =>
    commands.filter(c => c.cmd.startsWith(paletteFilter) || paletteFilter === '/'),
    [commands, paletteFilter]);

  // ── Picking a command leaves the cursor where the first value goes ──
  //
  // Choosing /ask-doc used to insert "/ask-doc " and stop, which says nothing
  // about the two things the operator then has to know: that a document is
  // named first, and that its name has to be quoted because it contains
  // spaces. Both are obvious once and easy to forget every time after.
  //
  // So a command whose first field is a document inserts the quotes too and
  // puts the caret between them. The shape of the line answers the question
  // before it is asked — the operator types or pastes, and the quoting is
  // already right.
  const firstParamName = (c) => {
    const p = Array.isArray(c?.params) && c.params.length ? c.params[0] : null;
    if (!p) return null;
    return typeof p === 'string' ? p : (p?.name || null);
  };
  // Fields that name a file. These are the ones that carry spaces, so these
  // are the ones that need quoting; a plain word field would only be made
  // harder to type by wrapping it.
  const NAMES_A_DOCUMENT = /^(path|file|filename|title|doc|document)$/i;

  const pickCommand = useCallback((c) => {
    const first = firstParamName(c);
    const quoted = first && NAMES_A_DOCUMENT.test(first);
    const text = quoted ? `${c.cmd} ""` : `${c.cmd} `;
    const caret = quoted ? text.length - 1 : text.length;
    setInput(text);
    // After the value lands, or the caret is placed in the old text and the
    // re-render moves it back to the end.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch { /* not all inputs allow it */ }
    });
  }, []);

  // What the command being typed still expects, shown under the field while it
  // is being typed. The registry already knows the field names; nothing was
  // showing them at the moment they are needed.
  const usageHint = useMemo(() => {
    if (!input.startsWith('/')) return null;
    const token = input.slice(0, input.indexOf(' ') === -1 ? input.length : input.indexOf(' '));
    const c = commands.find(x => x.cmd === token);
    if (!c || !Array.isArray(c.params) || !c.params.length) return null;
    const fields = c.params
      .map(p => (typeof p === 'string' ? p : p?.name))
      .filter(Boolean);
    if (!fields.length) return null;
    const shape = fields.map((f, i) => (i === 0 && NAMES_A_DOCUMENT.test(f) ? `"${f}"` : `<${f}>`)).join(' ');
    return `${c.cmd} ${shape}`;
  }, [input, commands]);

  // ── Image attach → vision two-hop ──
  // The chat model can't see images; the Settings "vision" role reads the
  // attachment first (kernel route, provider-agnostic) and its description
  // is folded into the prompt — the chat pipeline stays untouched.
  const onFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage({ dataUri: reader.result, name: file.name });
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const resolveImageContext = async (query) => {
    if (!pendingImage) return '';
    const img = pendingImage;
    setPendingImage(null);
    push({ type: 'msg', role: 'system', content: `👁 Reading ${img.name}…` });
    try {
      const res = await fetch('/api/ai/vision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: img.dataUri,
          prompt: query
            ? `The user is asking: "${query}". Describe this image with that question in mind — focus on whatever is relevant (error messages, UI elements, text, layout).`
            : 'Describe this image in detail — any text, UI elements, error messages, layout, and colors.',
        }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
      if (res.ok && data?.text) return `\n\n[Attached image "${img.name}" — vision analysis]: ${data.text}`;
      if (!res.ok) {
        // A server that answered said why — a 413 names the size limit. Only
        // no answer at all is "is the backend running?".
        push({ type: 'msg', role: 'error', content: data?.error
          ? `[VISION] ${data.error}${data.remedy ? ` — ${data.remedy}` : ''} (HTTP ${res.status})`
          : `[VISION] Server unreachable or errored (${res.status || 'no response'}). Is the AEON backend running?` });
      } else {
        push({ type: 'msg', role: 'error', content: `[VISION] ${data?.error || 'Could not read the image.'}` });
      }
    } catch (e) {
      push({ type: 'msg', role: 'error', content: `[VISION] ${e.message}` });
    }
    return '';
  };

  // ── Verb 1: chat (SSE stream) ──
  //
  // D2f. Every failure in here used to render as `[NEURAL LINK] <message>`,
  // a label that means the link is dead. So when the server answered
  // correctly and said "Native local runtime not ready" — a precise,
  // actionable sentence naming an install step — the operator read it as an
  // unreachable server and went looking for a network fault that did not
  // exist. AEON had the true answer and mislabelled it on the way to the
  // screen (§08). A server that explained itself gets its own words; only a
  // genuine transport failure gets a transport label, and the words are the
  // ones App.jsx already uses so both surfaces speak one vocabulary (§05).
  const runChat = async (text) => {
    const msgId = push({ type: 'msg', role: 'assistant', content: '', streaming: true });
    let streamed = '';
    let meta = {};

    // D1c — the operator's handle on their own machine's work. The backend
    // can cancel a generation; without this nothing ever asked it to.
    const controller = new AbortController();
    activeChatRef.current = { controller, streamId: null, msgId };

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json', [SELF_REPORTED_HEADER]: '1' },
        signal: controller.signal,
        body: JSON.stringify({ message: text, role: 'chat', history: feed.filter(e => e.type === 'msg' && (e.role === 'user' || e.role === 'assistant')).slice(-20).map(e => ({ role: e.role, content: e.content })) }),
      });
      if (!res.ok || !res.body) {
        // The chat backend lives in the Dashboard block; with it removed the
        // operator read "chat/stream 404" (measured 2026-09-23). Say what is true.
        const err = new Error(res.status === 404
          ? 'The terminal\'s chat is served by the Dashboard block, which is not installed. Restore it: node tools/aeon-cli.cjs block restore dashboard'
          : `chat/stream ${res.status}`);
        err.aeonKind = 'api';
        throw err;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        // Frames are read whole (takeSSEFrames); at the end the decoder is
        // flushed and the tail closed, so a last frame is never left unread.
        buffer += done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
        const { frames, rest } = takeSSEFrames(buffer);
        buffer = rest;
        for (const { event: eventType, data } of frames) {
          // Parse and handle are separate steps on purpose. They used to
          // share one try/catch that swallowed anything whose message
          // contained "JSON" — so a server error mentioning JSON vanished and
          // the turn ended blank, which is R-05's silent failure exactly.
          // Only a frame that is not JSON is skipped.
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }

          if (eventType === 'token') { streamed += payload.t; patch(msgId, { content: streamed }); }
          else if (eventType === 'meta') {
            if (payload.streamId) activeChatRef.current = { ...activeChatRef.current, streamId: payload.streamId };
            // Fallback narrative, inline and ABOVE the answer it explains.
            if (payload.notice) pushBefore(msgId, { type: 'msg', role: 'system', content: `↪ ${payload.notice}` });
            meta = { ...meta, ...payload };
          }
          else if (eventType === 'warning') push({ type: 'msg', role: 'warning', content: payload.message });
          else if (eventType === 'done') { streamed = payload.text || streamed; meta = { ...meta, ...payload }; }
          else if (eventType === 'error') {
            // The server spoke. Carry its words, not a link diagnosis.
            const err = new Error(payload.error);
            err.aeonKind = 'server';
            throw err;
          }
        }
        if (done) break;
      }

      // D1d — a truncated answer must not read as a finished one.
      if (meta.truncated) {
        push({ type: 'msg', role: 'warning', content: meta.truncationReason || 'The answer reached its token budget and stopped early.' });
      }
      patch(msgId, { content: streamed, streaming: false, meta });
      onUsageUpdate?.({ tokens: meta.tokens || 0, latencyMs: meta.latencyMs || 0 });
    } catch (e) {
      const failure = describeStreamFailure(e);
      if (!failure) {
        // A deliberate stop is not a failure. Keep what was generated.
        patch(msgId, { content: streamed, streaming: false, meta: { ...meta, cancelled: true } });
        push({ type: 'msg', role: 'system', content: 'Generation stopped.' });
      } else if (streamed) {
        // Keep what already arrived; say it broke underneath it.
        patch(msgId, { content: streamed, streaming: false, meta: { ...meta, truncated: true } });
        push({ type: 'msg', role: 'warning', content: failure.text });
      } else {
        patch(msgId, { role: 'error', content: failure.text, streaming: false });
      }
    } finally {
      activeChatRef.current = null;
    }
  };

  /**
   * D1c — stop the generation in flight.
   *
   * Tells the server first, by id, so it can abort the upstream llama-server
   * request and actually free the CPU; then aborts our own fetch. Closing the
   * socket alone would also register as a stop server-side, but naming the
   * stream is the honest instruction rather than a side effect.
   */
  const stopChat = useCallback(async () => {
    const active = activeChatRef.current;
    if (!active) return;
    try {
      await fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(active.streamId ? { streamId: active.streamId } : {}),
      });
    } catch { /* aborting locally below is the backstop */ }
    try { active.controller.abort(); } catch { /* already gone */ }
  }, []);

  // ── Verb 2: registry command ──
  const runCommand = async (text, confirmed = false, resumeChipId = null) => {
    const [cmdToken, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');

    // UI-only commands short-circuit
    if (cmdToken === '/clear') { setFeed([]); forgetSavedChat({ currentSessionId, savedFeedRef, saveChain }); return; }
    if (cmdToken === '/help') {
      push({ type: 'msg', role: 'system', content: commands.map(c =>
        c.available === false
          ? `${c.cmd} — ${c.desc || c.title || ''}\n    ⚠ unavailable: ${c.reason || 'not ready'}`
          : `${c.cmd} — ${c.desc || c.title || ''}`).join('\n') });
      return;
    }

    // UI-only commands — handled client-side, no server round-trip.
    // D2e #22 — /model rendered NOTHING: the user's line was logged and no
    // output appeared beneath it, which is indistinguishable from a command
    // that does not exist. It is client-side, so it never reaches the
    // registry and cannot answer for itself. It says what it did.
    if (cmdToken === '/model') {
      const opening = !showModelPicker;
      setShowModelPicker(opening);
      push({
        type: 'msg', role: 'system',
        content: opening ? 'Model picker opened.' : 'Model picker closed.',
      });
      return;
    }
    // /upload with no path opens the OS file picker; the placement card does the
    // rest. `/upload <path>` (a file on the server's machine) goes to the bus.
    if (cmdToken === '/upload' && !arg) {
      if (!docInputRef.current) { push({ type: 'msg', role: 'error', content: 'File picker unavailable in this view.' }); return; }
      push({ type: 'msg', role: 'system', content: 'Choose a document to put in the Second Brain (PDF, HTML, Markdown, text)…' });
      docInputRef.current.click();
      return;
    }
    if (cmdToken === '/open') {
      try {
        const d = await fetch('/api/console/blocks').then(r => r.json());
        const q = arg.toLowerCase().trim();
        if (!q) {
          push({ type: 'msg', role: 'system', content: (d.blocks || []).filter(b => !b.hidden).map(b => `${b.icon} ${b.label} — /open ${b.id}`).join('\n') });
          return;
        }
        const hit = (d.blocks || []).find(b => b.id.toLowerCase() === q)
          || (d.blocks || []).find(b => b.label.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
        if (!hit) { push({ type: 'msg', role: 'error', content: `No block matches "${arg}". Type /open to list all blocks.` }); return; }
        push({ type: 'msg', role: 'system', content: `Opening ${hit.icon} ${hit.label}…` });
        window.location.assign(hit.route);
      } catch (e) { push({ type: 'msg', role: 'error', content: `[OPEN] ${e.message}` }); }
      return;
    }

    // Everything else → command bus (manifest-discovered, block-owned).
    //
    // D2c — `resumeChipId` lets an approved challenge finish the SAME process
    // line it started on. Without it, approving opened a second chip and one
    // action produced two outcomes on screen.
    const t0 = Date.now();
    const chipId = resumeChipId ?? push({
      type: 'chip', pid: nextPid(), kind: 'CMD', label: text, status: 'running', expanded: false,
    });
    if (resumeChipId) patch(chipId, { status: 'running', label: text });
    try {
      // The chip reports the outcome; a 4xx here must not also raise the
      // global banner (a 5xx still does — interceptorPolicy).
      const res = await fetch('/api/commands/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json', [SELF_REPORTED_HEADER]: '1' },
        body: JSON.stringify({ cmd: cmdToken, arg, confirmed }),
      });
      const data = await res.json().catch(() => ({}));
      const outcome = describeDispatchOutcome({ status: res.status, data });

      // Central confirmation gate → the run PAUSES here. It is not finished,
      // so it is not given an exit code.
      if (outcome.kind === 'challenge') {
        patch(chipId, { status: outcome.chipStatus, label: text });
        push({ type: 'intercept', prompt: outcome.prompt, command: text, chipId });
        return;
      }

      // D2d — empty is a legitimate answer and reads as one. This used to be
      // an inline expression that rendered [] as an empty code block and
      // silence as the literal string "(empty)".
      const output = describeCommandOutput(data);
      patch(chipId, {
        status: outcome.chipStatus, output,
        latencyMs: Date.now() - t0, expanded: outcome.expand,
      });
      // ── BO-SHIP P7 — read the result back as a sentence ──
      //
      // The chip above still holds the raw payload and stays expandable, so
      // nothing is hidden and nothing is replaced: this is a rendering on top
      // of the truth, not instead of it (R-05).
      //
      // Deliberately fire-and-forget. A slow or rate-limited model must never
      // delay a result that already arrived, and a narration failure must
      // never fail a command that succeeded — the narrator falls back to a
      // deterministic sentence rather than inventing one, and a narration that
      // contradicts the outcome is discarded server-side.
      (async () => {
        try {
          const nres = await fetch('/api/commands/narrate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cmd: cmdToken, ok: outcome.kind === 'ok',
              text: data.text ?? null, data: data.data ?? null,
              error: data.error ?? null, title: data.meta?.block ?? null,
            }),
          });
          const n = await nres.json().catch(() => null);
          if (n?.narration) {
            push({
              type: 'msg', role: 'assistant', content: n.narration,
              meta: {
                model: n.source === 'model' ? undefined : n.source,
                provider: n.source === 'model' ? 'AI summary' : 'Block Command',
                latencyMs: Date.now() - t0,
              },
            });
            // This sentence lands after dispatch's own save has gone. Saved
            // now, not at the next turn — or at a close, where a chat over
            // the beacon limit sends nothing.
            setTurnsDone(k => k + 1);
          }
        } catch {
          // The chip already carries the full result; a missing sentence is a
          // rendering gap, not a lost outcome.
          if (outcome.kind === 'ok' && outcome.text) {
            push({ type: 'msg', role: 'assistant', content: outcome.text, meta: { model: data.meta?.block, provider: 'Block Command', latencyMs: Date.now() - t0 } });
            setTurnsDone(k => k + 1);
          }
        }
      })();
    } catch (e) {
      patch(chipId, { status: 'fail', output: e.message, expanded: true });
    }
  };

  // ── Verb 3: shell — removed ──
  //
  // '>' used to POST an arbitrary command to /api/os/shell, which ran it through
  // PowerShell. Mixing chat, app commands, key entry and raw OS execution in one
  // input box gave a user no way to know when they were changing their computer,
  // and the route was reachable from any loopback caller with no session. The
  // route is deleted; this explains rather than fails silently.
  const runShell = async (text) => {
    const cmd = text.slice(1).trim();
    const pid = nextPid();
    push({
      type: 'chip', pid, kind: 'SHELL', label: cmd, status: 'fail', expanded: true,
      output:
        'Shell execution was removed from AEON.\n\n' +
        'Use /commands for AEON operations, or your own terminal for OS commands.\n' +
        'Type /help to see what this console can do.',
      latencyMs: 0,
    });
  };

  // ── The router — the terminal's entire brain ──
  const dispatch = async (raw) => {
    const text = raw.trim();
    if (!text) return;
    // Never echo raw API keys into the transcript
    // /addkey is gone, but a hand that still types it must not see the key echoed.
    const echo = text.startsWith('/addkey')
      ? text.replace(/(\/addkey\s+\S+\s+)(\S{4})\S+/, '$1$2••••••••')
      : text;
    push({ type: 'msg', role: 'user', content: echo });
    setInput('');
    setShowPalette(false);
    setIsLoading(true);
    try {
      if (text.startsWith('>')) await runShell(text);
      else if (text.startsWith('/')) await runCommand(text);
      else {
        const imageContext = await resolveImageContext(text);
        await runChat(text + imageContext);
      }
    } finally {
      setIsLoading(false);
      setTurnsDone(n => n + 1);
    }
  };

  // D2c — approving resumes the run on its ORIGINAL process line. It used to
  // start a fresh one, so a single action left a green "awaiting approval"
  // chip above the red chip of the run that actually happened.
  const approveIntercept = (entry) => {
    setFeed(prev => prev.filter(e => e.id !== entry.id));
    setIsLoading(true);
    runCommand(entry.command, true, entry.chipId).finally(() => { setIsLoading(false); setTurnsDone(n => n + 1); });
  };

  // Denial is an outcome the operator chose, not an error the system hit —
  // and it must resolve the waiting chip, which previously sat on "awaiting
  // approval" for the rest of the session.
  const denyIntercept = (entry) => {
    setFeed(prev => prev.filter(e => e.id !== entry.id));
    const d = describeDenial(entry.command);
    if (entry.chipId != null) patch(entry.chipId, { status: d.chipStatus, output: d.output, expanded: d.expand });
  };

  // ── Render ──
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'JetBrains Mono', monospace", background: '#080b10', color: '#c8d6e8', outline: dragOver ? '2px dashed #00f2ff' : 'none', outlineOffset: -4 }}>
      <style>{`.spin { animation: t2spin 1s linear infinite; } @keyframes t2spin { to { transform: rotate(360deg); } }`}</style>
      {dragOver && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,242,255,0.06)', color: '#00f2ff', fontSize: 13, zIndex: 5, pointerEvents: 'none', letterSpacing: '0.1em' }}>
          DROP FILE — AEON WILL RECOMMEND A VAULT LOCATION
        </div>
      )}

      {/* ── Session action strip — top of terminal, not in the input row ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, borderBottom: '1px solid #111a28', flexShrink: 0 }}>
        <button onClick={() => saveSession().then(d => d && d.id && push({ type: 'msg', role: 'system', content: `💾 Saved: ${d.name}` }))}
          title="Keep this whole chat so you can reopen it later. To keep what it TAUGHT AEON, use Distil."
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', borderRight: '1px solid #111a28', color: sessionSaving ? '#39ff14' : '#3a5070', padding: '5px 12px', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}
          onMouseEnter={e => e.currentTarget.style.color = '#00f2ff'}
          onMouseLeave={e => e.currentTarget.style.color = sessionSaving ? '#39ff14' : '#3a5070'}>
          <Archive size={11} /> SAVE
        </button>
        <button onClick={distillToMemory} disabled={distilling}
          title="Pull the durable facts out of this chat into Memory Core, so AEON carries them into future conversations."
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', borderRight: '1px solid #111a28', color: distilling ? '#39ff14' : '#3a5070', padding: '5px 12px', cursor: distilling ? 'default' : 'pointer', fontSize: 10, fontFamily: 'inherit', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}
          onMouseEnter={e => { if (!distilling) e.currentTarget.style.color = '#00f2ff'; }}
          onMouseLeave={e => { e.currentTarget.style.color = distilling ? '#39ff14' : '#3a5070'; }}>
          <Sparkles size={11} /> {distilling ? 'DISTILLING…' : 'DISTIL → MEMORY'}
        </button>
        <button onClick={() => { setShowSessions(v => !v); if (!showSessions) fetchSessions(); }}
          title="Chat history"
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', borderRight: '1px solid #111a28', color: showSessions ? '#00f2ff' : '#3a5070', padding: '5px 12px', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}
          onMouseEnter={e => e.currentTarget.style.color = '#00f2ff'}
          onMouseLeave={e => e.currentTarget.style.color = showSessions ? '#00f2ff' : '#3a5070'}>
          <History size={11} /> HISTORY {sessions.length > 0 && <span style={{ color: '#2a4060', fontSize: 9 }}>({sessions.length})</span>}
        </button>
        <button onClick={newChat}
          title="Save & start new chat"
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', color: '#3a5070', padding: '5px 12px', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}
          onMouseEnter={e => e.currentTarget.style.color = '#00f2ff'}
          onMouseLeave={e => e.currentTarget.style.color = '#3a5070'}>
          <Plus size={11} /> NEW CHAT
        </button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px' }}>
        {feed.map(entry => {
          if (entry.type === 'chip') return <EventChip key={entry.id} ev={entry} onToggle={() => patch(entry.id, e => ({ expanded: !e.expanded }))} />;
          if (entry.type === 'intercept') return <InterceptCard key={entry.id} prompt={entry.prompt} onAllow={() => approveIntercept(entry)} onDeny={() => denyIntercept(entry)} />;
          if (entry.type === 'filedrop') return (
            <div key={entry.id} style={{ border: '1px solid #00f2ff', borderRadius: 3, margin: '6px 0', padding: '10px 14px', background: 'rgba(0,242,255,0.05)' }}>
              <div style={{ fontSize: 11, color: '#00f2ff', letterSpacing: '0.1em', marginBottom: 6 }}>📥 VAULT PLACEMENT — {entry.name}</div>
              <div style={{ fontSize: 12, color: '#c8d6e8', marginBottom: 8 }}>
                Recommended: <b style={{ color: '#39ff14' }}>{entry.recommendation?.folder}</b>
                {entry.recommendation?.reason ? ` — ${entry.recommendation.reason}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => saveDrop(entry, entry.recommendation?.folder)}
                  style={{ background: 'rgba(57,255,20,0.12)', border: '1px solid #39ff14', color: '#39ff14', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                  [Y] SAVE THERE
                </button>
                <select aria-label="Choose a different vault folder" defaultValue=""
                  onChange={(e) => e.target.value && saveDrop(entry, e.target.value)}
                  style={{ background: '#0b0f19', color: '#c8d6e8', border: '1px solid #1e2d45', borderRadius: 2, fontSize: 11, padding: '3px 6px', fontFamily: 'inherit' }}>
                  <option value="" disabled>…or pick a folder</option>
                  {entry.folders.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <input aria-label="New folder inside the vault" placeholder="…or a new folder, e.g. Reference/Phishing" value={entry.newFolder || ''}
                  onChange={(e) => patch(entry.id, { newFolder: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && entry.newFolder?.trim()) saveDrop(entry, entry.newFolder.trim()); }}
                  style={{ background: '#0b0f19', color: '#c8d6e8', border: '1px solid #1e2d45', borderRadius: 2, fontSize: 11, padding: '3px 6px', fontFamily: 'inherit', flex: '1 1 160px', minWidth: 0, maxWidth: '100%' }} />
                {entry.newFolder?.trim() && (
                  <button onClick={() => saveDrop(entry, entry.newFolder.trim())}
                    style={{ background: 'rgba(0,242,255,0.1)', border: '1px solid #00f2ff', color: '#00f2ff', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                    SAVE TO NEW FOLDER
                  </button>
                )}
                <button onClick={() => setFeed(prev => prev.filter(e2 => e2.id !== entry.id))}
                  style={{ background: 'rgba(255,68,85,0.1)', border: '1px solid #ff4455', color: '#ff4455', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                  [N] CANCEL
                </button>
              </div>
            </div>
          );
          const roleColor = { user: '#e8f0fa', assistant: '#c8d6e8', system: '#5a6a80', warning: '#f59e0b', error: '#ff4455' }[entry.role] || '#c8d6e8';
          const roleTag = { user: 'USER', assistant: 'CORE', system: 'SYS', warning: 'WARN', error: 'ERROR' }[entry.role];
          return (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '8px 0', fontSize: 12.5, minWidth: 0 }}>
              <span style={{ flexShrink: 0, fontSize: 9, letterSpacing: '0.12em', color: roleColor, border: `1px solid ${roleColor}44`, borderRadius: 2, padding: '1px 6px' }}>{roleTag}</span>
              <div style={{ flex: 1, minWidth: 0, color: roleColor, overflowWrap: 'anywhere' }}>
                {entry.role === 'assistant'
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{entry.content || (entry.streaming ? '▮' : '')}</ReactMarkdown>
                  : <span style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</span>}
                {entry.meta?.model && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 3, fontSize: 9.5, color: '#4a5568', minWidth: 0 }}>
                    <span><Cpu size={9} style={{ verticalAlign: -1 }} /> {entry.meta.model}</span>
                    {entry.meta.latencyMs != null && <span><Clock size={9} style={{ verticalAlign: -1 }} /> {entry.meta.latencyMs}ms</span>}
                    {entry.meta.tokens != null && <span><Zap size={9} style={{ verticalAlign: -1 }} /> {entry.meta.tokens} tok</span>}
                    {/* What this turn consulted. These counters were emitted on every
                        stream and read by nobody — the operator's answer to "did it
                        actually look?" existed only in the network tab (§08, R01, R03). */}
                    {entry.meta.memoryError && (
                      <span style={{ color: '#ffaa00' }} title={entry.meta.memoryError}>🧠 memory store unreadable</span>
                    )}
                    {!entry.meta.memoryError && entry.meta.memory != null && (
                      <span title={`${entry.meta.memory} of ${entry.meta.memoryConsidered ?? '?'} memories injected${entry.meta.memoryDropped ? `, ${entry.meta.memoryDropped} dropped for space` : ''}`}>
                        🧠 {entry.meta.memory}{entry.meta.memoryConsidered != null ? `/${entry.meta.memoryConsidered}` : ''}
                      </span>
                    )}
                    {entry.meta.recallError && (
                      <span style={{ color: '#ffaa00' }} title={`Recall did not run: ${entry.meta.recallError}`}>vault: {String(entry.meta.recallError).replace(/^recall_/, '').replace(/_/g, ' ')}</span>
                    )}
                    {!entry.meta.recallError && entry.meta.recallUnavailable && (
                      <span style={{ color: '#ffaa00' }} title="The index could not be searched">vault: {String(entry.meta.recallUnavailable).replace(/_/g, ' ')}</span>
                    )}
                    {!entry.meta.recallError && !entry.meta.recallUnavailable && entry.meta.recallRan && (
                      <span title={entry.meta.recallMatched > entry.meta.recall ? `showing ${entry.meta.recall} of ${entry.meta.recallMatched} matching documents` : 'documents consulted'}>
                        📚 {entry.meta.recall}{entry.meta.recallMatched > entry.meta.recall ? `/${entry.meta.recallMatched}` : ''}
                      </span>
                    )}
                    {Array.isArray(entry.meta.citations) && entry.meta.citations.length > 0 && (
                      <span style={{ color: '#3a5070' }} title={entry.meta.citations.map(ct => `[${ct.n}] ${ct.path || ct.title}`).join('\n')}>
                        {entry.meta.citations.slice(0, 3).map(ct => `[${ct.n}] ${ct.title}`).join('  ')}{entry.meta.citations.length > 3 ? ` +${entry.meta.citations.length - 3}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showPalette && filteredCommands.length > 0 && (
        <div style={{ maxHeight: 180, overflowY: 'auto', borderTop: '1px solid #1e2d45', background: 'rgba(10,15,25,0.97)', padding: '6px 0' }}>
          {filteredCommands.map(c => {
            const off = c.available === false;
            return (
              <div key={c.id || c.cmd} onClick={() => pickCommand(c)} title={off ? c.reason || 'unavailable' : undefined}
                data-unavailable={off ? 'true' : undefined}
                style={{ padding: '3px 16px', fontSize: 11.5, cursor: 'pointer', display: 'flex', gap: 10, opacity: off ? 0.55 : 1 }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,242,255,0.07)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span style={{ color: off ? '#8a9ab0' : '#39ff14', minWidth: 90 }}>{c.cmd}</span>
                <span style={{ color: '#5a6a80', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {c.desc || c.title}
                  {off && <span style={{ color: '#ffaa00', marginLeft: 8, fontSize: 10 }}>⚠ {shortReason(c.reason)}</span>}
                </span>
                {c.dangerous && <ShieldAlert size={11} color="#f59e0b" />}
                {c.blockLabel && <span style={{ color: '#4a5568', fontSize: 9.5 }}>{c.blockLabel}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Chat history recovery panel ── */}
      {showSessions && (
        <div style={{ borderTop: '1px solid #1e2d45', background: '#080c14', maxHeight: 240, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 4px', borderBottom: '1px solid #1a2535' }}>
            <span style={{ fontSize: 10, letterSpacing: '0.1em', color: '#4a6080', fontWeight: 600 }}>CHAT HISTORY</span>
            <button onClick={newChat}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(0,242,255,0.07)', border: '1px solid #00f2ff44', color: '#00f2ff', padding: '2px 10px', borderRadius: 2, cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', letterSpacing: '0.06em' }}>
              <Plus size={10} /> NEW CHAT
            </button>
          </div>
          {sessionsError && (
            <div style={{ padding: '12px 14px', fontSize: 11, color: '#ff4455' }}>Chat history could not be read — {sessionsError}</div>
          )}
          {!sessionsError && sessions.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 11, color: '#3a4f66' }}>No saved sessions yet — chats save after every turn.</div>
          )}
          {/* An unreadable file is listed, not hidden: it cannot be opened,
              renamed or remembered (each would 404), only seen and deleted. */}
          {sessions.map(s => (
            <div key={s.id} onClick={() => { if (!s.unreadable) loadSession(s.id); }}
              title={s.unreadable ? `This saved chat cannot be read: ${s.error}` : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', cursor: s.unreadable ? 'default' : 'pointer', borderBottom: '1px solid #111a28' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,242,255,0.04)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {s.unreadable ? (
                  <>
                    <div style={{ fontSize: 11.5, color: '#ffaa00', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⚠ {s.id}</div>
                    <div style={{ fontSize: 9.5, color: '#3a5070', marginTop: 1, overflowWrap: 'anywhere' }}>{s.mismatch ? 'ID DOES NOT MATCH FILE NAME' : 'UNREADABLE'} · {s.error}{s.deletable === false ? ' · delete it by hand from the Vault\'s Agents/Aeon/chat_sessions folder' : ''}</div>
                  </>
                ) : renaming?.id === s.id ? (
                  <input
                    autoFocus
                    value={renaming.value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id: s.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') renameSession(s.id, renaming.value);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={() => renameSession(s.id, renaming.value)}
                    aria-label="Rename chat"
                    style={{ width: '100%', background: '#0d1420', border: '1px solid #00f2ff44', color: '#c8d6e8', fontSize: 11.5, fontFamily: 'inherit', padding: '2px 6px', borderRadius: 2 }}
                  />
                ) : (
                  <div style={{ fontSize: 11.5, color: '#c8d6e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                )}
                {!s.unreadable && (
                  <div style={{ fontSize: 9.5, color: '#3a5070', marginTop: 1 }}>
                    {s.autoSaved ? 'AUTO · ' : 'SAVED · '}{s.messageCount} msgs · {new Date(s.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {s.inRecord && <span style={{ color: '#00f2ff' }}> · IN RECORD</span>}
                  </div>
                )}
              </div>
              {!s.unreadable && (<>
              <button onClick={(e) => { e.stopPropagation(); setRenaming({ id: s.id, value: s.name }); }}
                aria-label="Rename chat"
                title="Rename — your title is never overwritten"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#3a5070', padding: 2, lineHeight: 1 }}
                onMouseEnter={e => e.currentTarget.style.color = '#00f2ff'}
                onMouseLeave={e => e.currentTarget.style.color = '#3a5070'}>
                <Pencil size={12} />
              </button>
              <button onClick={(e) => rememberSession(s.id, e)}
                aria-label={s.inRecord ? 'Already in the Second Brain' : 'Add this chat to the Second Brain'}
                title={s.inRecord ? 'Already in the Second Brain — adding again refreshes it' : 'Add to the Second Brain (your turns only)'}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: s.inRecord ? '#00f2ff' : '#3a5070', padding: 2, lineHeight: 1 }}
                onMouseEnter={e => e.currentTarget.style.color = '#00f2ff'}
                onMouseLeave={e => e.currentTarget.style.color = s.inRecord ? '#00f2ff' : '#3a5070'}>
                {s.inRecord ? <Check size={12} /> : <BookmarkPlus size={12} />}
              </button>
              </>)}
              {s.deletable !== false && <button onClick={(e) => deleteSession(s.id, e, s)}
                aria-label="Delete session"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#3a5070', padding: 2, lineHeight: 1 }}
                onMouseEnter={e => e.currentTarget.style.color = '#ff4455'}
                onMouseLeave={e => e.currentTarget.style.color = '#3a5070'}>
                <Trash2 size={12} />
              </button>}
            </div>
          ))}
        </div>
      )}

      {pendingImage && (
        // The filename is the only thing on this row that can be any length, so
        // it is the only thing allowed to shrink. Left as a bare text node it
        // was an anonymous flex item whose minimum size is its min-content
        // width, and an ordinary 'Screenshot 2026-09-17 at 12.34.56 PM.png'
        // pushed the remove control past the panel edge — which clips it, so
        // the operator lost the one control that cancels the attachment.
        // Ellipsis rather than wrap keeps the strip one line high; the whole
        // name rides on `title`.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', borderTop: '1px solid #1e2d45', fontSize: 11, color: '#00f2ff', minWidth: 0 }}>
          <Paperclip size={11} style={{ flexShrink: 0 }} />
          <span title={pendingImage.name}
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pendingImage.name}
          </span>
          <XIcon size={12} aria-label="Remove the attached file"
            style={{ cursor: 'pointer', color: '#ff4455', flexShrink: 0 }}
            onClick={() => setPendingImage(null)} />
        </div>
      )}
      {showModelPicker && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 14px', borderTop: '1px solid #1e2d45', fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu size={12} color="#00f2ff" />
            <span style={{ color: '#5a6a80' }}>HOTSWAP CHAT MODEL</span>
            <select aria-label="Hotswap chat model" defaultValue=""
              onChange={(e) => {
                const [provider, ...m] = e.target.value.split('::');
                hotswapModel(provider, m.join('::'));
              }}
              style={{ flex: 1, minWidth: 0, maxWidth: 420, background: '#0b0f19', color: '#c8d6e8', border: '1px solid #1e2d45', borderRadius: 2, fontSize: 11, padding: '4px 6px', fontFamily: 'inherit' }}>
              <option value="" disabled>Pick a model (free first, then by capability)…</option>
              {modelGroups.map(g => (
                <optgroup key={g.provider} label={`${g.label || g.provider} ${g.hasKey ? '· ✓ key ready' : '· ✗ no key — add one in Settings'}`}>
                  {(g.models.length ? g.models : [{ id: '(no models listed)', free: false }]).map(m => (
                    <option key={g.provider + m.id} value={`${g.provider}::${m.id}`} disabled={!g.hasKey || m.id === '(no models listed)'}>
                      {m.id}{m.free ? ' · free' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <XIcon size={12} style={{ cursor: 'pointer', color: '#ff4455' }} onClick={() => setShowModelPicker(false)} aria-label="Close model picker" />
          </div>
          {modelSortNote && (
            <span style={{ color: '#3a5070', fontSize: 10, paddingLeft: 20 }}>{modelSortNote}</span>
          )}
        </div>
      )}
      {usageHint && (
        // Sits above the field, not in the placeholder: a placeholder vanishes
        // the moment there is any text, which is exactly when the shape of the
        // rest of the line starts mattering.
        <div style={{ padding: '4px 14px 0 38px', fontSize: 10.5, color: '#4a6a90', fontFamily: 'inherit' }}>
          {usageHint}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '10px 14px', borderTop: '1px solid #1e2d45' }}>
        <span style={{ color: sigilColor, fontSize: 14, width: 14, textAlign: 'center', textShadow: `0 0 8px ${sigilColor}`, lineHeight: '20px' }}>{sigilGlyph}</span>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFileSelected} />
        <input ref={docInputRef} type="file" accept=".pdf,.html,.htm,.md,.markdown,.txt,.csv,.json" style={{ display: 'none' }} onChange={onDocSelected} />
        <Paperclip size={14} style={{ cursor: 'pointer', color: pendingImage ? '#00f2ff' : '#4a5568', flexShrink: 0, marginBottom: 3 }} onClick={() => fileInputRef.current?.click()} />
        <Cpu size={14} aria-label="Hotswap model" style={{ cursor: 'pointer', color: showModelPicker ? '#00f2ff' : '#4a5568', flexShrink: 0, marginBottom: 3 }} onClick={() => setShowModelPicker(v => !v)} />
        {/* Was a single-line <input> — grows with the message instead of
            scrolling its own text sideways inside a fixed-height box.
            Enter sends (unchanged); Shift+Enter inserts a real newline,
            the convention every chat surface this size already uses.
            Height resets itself via the effect below keyed on `input`,
            so it also shrinks back to one line the moment dispatch()
            clears the value on send — no separate reset call needed here. */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !isLoading) { e.preventDefault(); dispatch(input); }
          }}
          placeholder="Ask, or /command… (Shift+Enter for a new line)"
          style={{
            flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            color: '#e8f0fa', fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
            resize: 'none', overflowY: 'auto', maxHeight: 160, padding: '2px 0',
          }}
        />
        {/* D1c — while a generation runs this is a STOP control, not a dead
            spinner. The backend can cancel; the operator had no way to ask.
            At D1a's budget an unwanted answer is minutes of CPU on the
            operator's own machine, which is theirs to reclaim (§03). */}
        <button
          onClick={() => (isLoading ? stopChat() : dispatch(input))}
          title={isLoading ? 'Stop generating' : 'Send'}
          aria-label={isLoading ? 'Stop generating' : 'Send'}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: isLoading ? '#ff4455' : sigilColor, marginBottom: 2 }}>
          {isLoading ? <Square size={13} fill="#ff4455" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
};

export default Terminal2;
