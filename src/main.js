const { app, BrowserWindow, ipcMain, globalShortcut, safeStorage, systemPreferences, screen } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { createT3 } = require('./t3');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

const SETTINGS_VERSION = 7;

// GPT-Live is blocked for now (it isn't working); the app stays on GPT-Realtime or TTS.
const LIVE_DISABLED = true;
const LIVE_ONLY_VOICES = ['bossa', 'tempo', 'gleam', 'meridian', 'vesper', 'willow', 'stone', 'ripple', 'quartz', 'delta', 'cinder', 'beacon'];

const DEFAULTS = {
  openaiKey: '',
  // 'live'     = GPT-Live full-duplex conversation; Claude is its delegated backend
  // 'realtime' = Realtime transcription + gpt-realtime voice reading Claude's text
  // 'tts'      = Realtime transcription + /v1/audio/speech
  // 'local'    = Realtime transcription + Chatterbox on this Mac (local-tts/server.py), free
  ttsEngine: 'realtime',
  liveModel: 'gpt-live-1',
  realtimeModel: 'gpt-realtime-2',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'marin',
  localVoice: 'default',        // 'default' (built in) or a cloned voice in ~/.claude-voice/voices
  sttModel: 'gpt-4o-transcribe',
  language: 'pt',               // Brazilian Portuguese by default
  silenceMs: 1000,              // how long the user must be quiet before their turn ends
  bargeIn: true,                 // keep listening while speaking so the user can interrupt
  pushToTalk: true,              // Space starts recording, Space again sends (no silence detection)
  hotkey: 'Alt+Space',
  lastCwd: '',                  // where the last thread ran; a thread the app starts on its own opens here
};

const TTS_STYLE = 'Warm, relaxed and natural, like a friendly colleague talking. Brisk pace.';

// Pin the accent to Brazilian Portuguese when the language is Portuguese.
const ttsStyle = () => (settings.language || '').toLowerCase().startsWith('pt')
  ? `${TTS_STYLE} Speak with a native Brazilian Portuguese (pt-BR) accent.`
  : TTS_STYLE;

let win;
let settings;

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in raw) s[k] = raw[k];
  if ((raw.settingsVersion || 0) < 4) {
    // v4: GPT-Realtime-2 reading Claude verbatim, a natural voice, interrupt by talking.
    s.ttsEngine = 'realtime';
    s.realtimeModel = 'gpt-realtime-2';
    if (!['marin', 'cedar'].includes(s.voice)) s.voice = 'marin';
    s.bargeIn = true;
  }
  if ((raw.settingsVersion || 0) < 5) s.silenceMs = 1000; // v5: wait 1 s of silence before replying
  if ((raw.settingsVersion || 0) < 6 && !s.language) s.language = 'pt'; // v6: Brazilian Portuguese by default
  if ((raw.settingsVersion || 0) < 7) s.pushToTalk = true; // v7: push-to-talk, pauses no longer end the turn
  if (LIVE_DISABLED && s.ttsEngine === 'live') s.ttsEngine = 'realtime';
  if (LIVE_DISABLED && LIVE_ONLY_VOICES.includes(s.voice)) s.voice = 'marin';
  try { s.openaiKey = fs.readFileSync(keyFile(), 'utf8').trim(); } catch {}
  // One-time migration from the Keychain (safeStorage). Every rebuild of this ad-hoc-signed app
  // looks like a new app to the Keychain, which then asks for the login password again.
  if (!s.openaiKey && raw.openaiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      s.openaiKey = safeStorage.decryptString(Buffer.from(raw.openaiKeyEnc, 'base64'));
      writeKey(s.openaiKey);
    } catch {}
  }
  if (!s.openaiKey && process.env.OPENAI_API_KEY) s.openaiKey = process.env.OPENAI_API_KEY;
  return s;
}

// The API key lives in its own file readable only by this user (like ~/.config CLI tokens).
const keyFile = () => path.join(app.getPath('userData'), 'openai-key');

function writeKey(key) {
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  if (key) fs.writeFileSync(keyFile(), key, { mode: 0o600 });
  else fs.rmSync(keyFile(), { force: true });
}

function saveSettings(s) {
  const { openaiKey, ...rest } = s;
  const out = { ...rest, settingsVersion: SETTINGS_VERSION };
  if (openaiKey !== process.env.OPENAI_API_KEY) writeKey(openaiKey);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- sub-agents panel (a small window docked to the right of the main one) ----------

let agentsWin = null;
let agentsList = new Map(); // id -> agent info + log, mirrored from the channel
let agentsWanted = false;   // the user opened the panel (or an agent started)

const AGENTS_WIDTH = 340;
const DOCK_GAP = 8;

function sendAgents(channel, payload) {
  if (agentsWin && !agentsWin.isDestroyed()) agentsWin.webContents.send(channel, payload);
}

function agentsSummary() {
  const all = [...agentsList.values()];
  return { total: all.length, running: all.filter((a) => a.status === 'running').length, open: !!agentsWin?.isVisible() };
}

// Dock a panel on its preferred side of the main window; the other side when there's no room.
function dockPanel(panel, width, side) {
  if (!panel || panel.isDestroyed() || !win || win.isDestroyed()) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width + DOCK_GAP;
  const left = b.x - DOCK_GAP - width;
  const fitsRight = right + width <= area.x + area.width;
  const fitsLeft = left >= area.x;
  const x = side === 'right' ? (fitsRight || !fitsLeft ? right : left) : (fitsLeft || !fitsRight ? left : right);
  panel.setBounds({ x, y: b.y, width, height: b.height });
}

function dockPanels() {
  dockPanel(agentsWin, AGENTS_WIDTH, 'right');
  dockPanel(historyWin, HISTORY_WIDTH, 'left');
}

function createAgentsWindow() {
  agentsWin = new BrowserWindow({
    width: AGENTS_WIDTH,
    height: 620,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d0b0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  agentsWin.loadFile(path.join(__dirname, 'agents.html'));
  agentsWin.webContents.once('did-finish-load', () => sendAgents('agents:all', [...agentsList.values()]));
  agentsWin.on('closed', () => { agentsWin = null; send('agents:summary', agentsSummary()); pushUi(); });
}

function showAgents(show) {
  agentsWanted = show;
  if (show) {
    if (!agentsWin) createAgentsWindow();
    dockPanels();
    agentsWin.showInactive();
  } else agentsWin?.hide();
  send('agents:summary', agentsSummary());
  pushUi();
}

function onAgentMessage(msg) {
  if (msg.type === 'agents') {
    agentsList = new Map(msg.agents.map((a) => [a.id, a]));
    sendAgents('agents:all', msg.agents);
  } else if (msg.type === 'agent') {
    const prev = agentsList.get(msg.agent.id);
    agentsList.set(msg.agent.id, { ...prev, ...msg.agent, log: prev?.log || [] });
    sendAgents('agents:update', msg.agent);
    // A new sub-agent pops the panel open so the user can watch it.
    if (!prev && msg.agent.status === 'running') showAgents(true);
  } else if (msg.type === 'agent_log') {
    const a = agentsList.get(msg.id);
    if (a) { a.log.push(msg.line); if (a.log.length > 400) a.log.shift(); }
    sendAgents('agents:log', { id: msg.id, line: msg.line });
  }
  send('agents:summary', agentsSummary());
  pushUi();
}

// ---------- message history panel (docked to the left of the main window) ----------

let historyWin = null;
let historyWanted = false;
let history = []; // { dir: 'sent' | 'received', kind: 'message' | 'permission', text, at, thread }
let currentThread = null; // id of the attached Claude Code thread; the panel only shows its messages

const HISTORY_WIDTH = 320;
const HISTORY_MAX = 500;
const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function loadHistory() {
  try { history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')).slice(-HISTORY_MAX); } catch { history = []; }
  for (const e of history) delete e.pending; // nothing is in flight after a restart
  currentThread = history.findLast((e) => e.thread)?.thread || null; // show the last thread until one connects
}

let historySaveTimer = null;

function saveHistory(now = false) {
  clearTimeout(historySaveTimer);
  const write = () => { try { fs.writeFileSync(historyFile(), JSON.stringify(history)); } catch {} };
  if (now) write();
  else historySaveTimer = setTimeout(write, 500);
}

function sendHistory(channel, payload) {
  if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send(channel, payload);
}

// A thread is the project the Claude session runs in (its cwd from `hello`). The channel URL can't be
// used: every session gets a random port and token, so each /voice would start an empty thread.
// Entries saved before threads existed have no `thread` and show in every thread.
const threadId = (cwd) => (cwd ? crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12) : null);
const inThread = (e) => !e.thread || e.thread === currentThread;
const threadHistory = () => history.filter(inThread);

function historySummary() {
  return { count: threadHistory().length, open: !!historyWin?.isVisible() };
}

function setThread(cwd) {
  if (cwd && !cwd.startsWith('t3:') && cwd !== settings.lastCwd) { settings.lastCwd = cwd; saveSettings(settings); }
  const id = threadId(cwd);
  if (!id || id === currentThread) return;
  currentThread = id;
  sendHistory('history:all', threadHistory());
  send('history:summary', historySummary());
}

// What the Claude thread is doing (channel/server.js `activity`): shown under the orb and in the history.
const IDLE = { state: 'idle', detail: '', background: [] };
let activity = IDLE;

function setActivity(a) {
  activity = a || IDLE;
  send('activity', activity);
  sendHistory('history:activity', activity);
  if (activity.state === 'idle') settlePending();
}

// Sent messages stay `pending` (shown as processing) until the thread goes idle or drops.
function settlePending() {
  let changed = false;
  for (const e of history) if (e.pending) { delete e.pending; changed = true; }
  if (changed) { saveHistory(); sendHistory('history:settled'); }
}

function addHistory(dir, text, kind = 'message') {
  text = String(text || '').trim();
  if (!text) return;
  const entry = { dir, kind, text, at: Date.now(), thread: currentThread };
  if (dir === 'sent' && kind === 'message') entry.pending = true;
  history.push(entry);
  if (history.length > HISTORY_MAX) history.shift();
  saveHistory();
  sendHistory('history:add', entry);
  send('history:summary', historySummary());
  pushUi();
}

function clearHistory() {
  history = history.filter((e) => !inThread(e));
  saveHistory(true);
  sendHistory('history:all', threadHistory());
  send('history:summary', historySummary());
}

function createHistoryWindow() {
  historyWin = new BrowserWindow({
    width: HISTORY_WIDTH,
    height: 620,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d0b0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  historyWin.loadFile(path.join(__dirname, 'history.html'));
  historyWin.webContents.once('did-finish-load', () => {
    sendHistory('history:all', threadHistory());
    sendHistory('history:activity', activity);
  });
  historyWin.on('closed', () => { historyWin = null; send('history:summary', historySummary()); pushUi(); });
}

function showHistory(show) {
  historyWanted = show;
  if (show) {
    if (!historyWin) createHistoryWindow();
    dockPanels();
    historyWin.showInactive();
  } else historyWin?.hide();
  send('history:summary', historySummary());
  pushUi();
}

function openaiWs(query) {
  return new WebSocket(`wss://api.openai.com/v1/realtime?${query}`, {
    headers: { Authorization: `Bearer ${settings.openaiKey}` },
  });
}

// Surface OpenAI's JSON error body when a socket upgrade is refused (bad key, no access, bad model).
function explainRejection(ws, prefix) {
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      let msg = `HTTP ${res.statusCode}`;
      try { msg = JSON.parse(body).error?.message || msg; } catch {}
      send('error', `${prefix}: ${msg}`);
      ws.terminate();
    });
  });
}

function wsError(prefix, ev) {
  const e = ev.error || {};
  return `${prefix}: ${e.message || e.code || JSON.stringify(ev).slice(0, 200)}`;
}

// ---------- channel (the live Claude Code session) ----------

let channel = null;
let channelUrl = null;
let channelHello = null; // the attached Claude thread, to go back to when a T3 thread is left

function connectChannel(url) {
  if (channel) { channel.removeAllListeners(); channel.close(); channel = null; }
  channelUrl = url;
  if (!url) return;
  let ws;
  try { ws = new WebSocket(url); } catch (err) {
    send('channel', { state: 'error', error: err.message });
    return;
  }
  channel = ws;
  send('channel', { state: 'connecting' });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'hello') {
      if (t3.isAttached()) t3.detach();
      setThread(msg.cwd);
      channelHello = { state: 'connected', cwd: msg.cwd, project: msg.project };
      send('channel', channelHello);
      pushUi(true);
    }
    else if (msg.type === 'ui_action') uiAction(String(msg.action || ''));
    else if (msg.type === 'speak') {
      addHistory('received', msg.text);
      if (settings.ttsEngine === 'live') live.relay(msg.text);
      else tts.say(msg.text);
    }
    else if (msg.type === 'permission_request') {
      addHistory('received', `Permission to use ${msg.tool_name}: ${msg.description}`, 'permission');
      send('permission', msg);
    }
    else if (msg.type === 'agents' || msg.type === 'agent' || msg.type === 'agent_log') onAgentMessage(msg);
    else if (msg.type === 'activity') setActivity(msg.activity);
  });
  ws.on('close', () => { if (channel === ws) { channel = null; setActivity(IDLE); send('channel', { state: 'disconnected' }); } });
  ws.on('error', () => {});
}

// ---------- app state for Claude (channel/server.js app_state / app_control) ----------

let rendererUi = {}; // what the main window reports: mic, speaking, mode, open dialogs
let uiSent = '';

function uiState() {
  const agents = agentsSummary();
  return {
    window: !win || win.isDestroyed() ? 'closed' : win.isMinimized() ? 'minimized' : win.isFocused() ? 'focused' : 'open',
    history_panel: historyWin?.isVisible() ? 'open' : 'closed',
    history_messages: threadHistory().length,
    agents_panel: agents.open ? 'open' : 'closed',
    agents_running: agents.running,
    agents_total: agents.total,
    mic: rendererUi.mic ? 'on' : 'off',
    speaking: !!rendererUi.speaking,
    mode: rendererUi.mode || settings.ttsEngine,
    settings_dialog: rendererUi.settingsOpen ? 'open' : 'closed',
    pairing_dialog: rendererUi.pairingOpen ? 'open' : 'closed',
    typed_context_box: rendererUi.typedContextOpen ? 'open' : 'closed',
  };
}

// Tell the channel whenever the UI changes, so Claude knows what the user is looking at.
function pushUi(force = false) {
  if (!channel || channel.readyState !== WebSocket.OPEN) return;
  const json = JSON.stringify(uiState());
  if (!force && json === uiSent) return;
  uiSent = json;
  channel.send(JSON.stringify({ type: 'ui_state', state: JSON.parse(json) }));
}

function uiAction(action) {
  if (action === 'open_history') showHistory(true);
  else if (action === 'close_history') showHistory(false);
  else if (action === 'open_agents') showAgents(true);
  else if (action === 'close_agents') showAgents(false);
  else if (action === 'show_window') { if (win?.isMinimized()) win.restore(); win?.show(); }
  else if (action === 'minimize_window') win?.minimize();
  else send('ui:action', action);
  pushUi();
}

// Typed context from the app's text box; rides along with the next spoken message.
let pendingContext = '';

function toChannel(msg) {
  if (msg.type === 'user' && t3.isAttached()) return toT3(msg.text);
  if (!channel || channel.readyState !== WebSocket.OPEN) return false;
  if (msg.type === 'user' && pendingContext) {
    msg = { ...msg, text: `${msg.text}\n\n(Typed context from the user: ${pendingContext})` };
    pendingContext = '';
    send('context:sent');
  }
  channel.send(JSON.stringify(msg));
  if (msg.type === 'user') addHistory('sent', msg.text);
  else if (msg.type === 'permission') addHistory('sent', msg.behavior === 'allow' ? 'Allowed' : 'Denied', 'permission');
  return true;
}

// ---------- T3 Code (src/t3.js): /voice in a T3 thread attaches the app to it ----------

let t3Sent = ''; // our own last message, so its echo from T3 isn't added to the history twice

const t3 = createT3({
  onAttach(thread) {
    if (!thread) {
      const back = channel?.readyState === WebSocket.OPEN && channelHello;
      if (back) setThread(back.cwd);
      send('channel', back || { state: 'disconnected' });
      return;
    }
    setThread(`t3:${thread.threadId}`);
    send('channel', { state: 'connected', cwd: thread.cwd, project: thread.project, t3: thread.title });
    send('t3', t3.status());
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  },
  onSpeak(text, raw) {
    addHistory('received', raw);
    if (settings.ttsEngine === 'live') live.relay(text);
    else tts.say(text);
  },
  onActivity(on) {
    setActivity(on ? { state: 'thinking', detail: '', background: [] } : IDLE);
  },
  onUserText(text) {
    if (text.trim() === t3Sent) { t3Sent = ''; return; }
    if (!/^[/$]voice\b/i.test(text.trim())) addHistory('sent', text);
  },
  onState() { send('t3', t3.status()); },
  log: (m) => console.warn(m),
});

function toT3(text) {
  if (pendingContext) {
    text = `${text}\n\n(Typed context from the user: ${pendingContext})`;
    pendingContext = '';
    send('context:sent');
  }
  t3Sent = text.trim();
  addHistory('sent', text);
  t3.sendText(text).then((ok) => { if (!ok) send('error', "Couldn't send that to T3 Code."); });
  return true;
}

// ---------- speech-to-text (Realtime transcription session) ----------

const stt = {
  ws: null,
  pending: [], // messages sent while the socket is still connecting
  open() {
    if (this.ws) return;
    if (!settings.openaiKey) { send('error', 'Add your OpenAI API key in Settings.'); send('stt', { type: 'closed' }); return; }
    const ws = openaiWs('intent=transcription');
    explainRejection(ws, 'Transcription');
    this.ws = ws;
    ws.on('open', () => {
      const transcription = { model: settings.sttModel };
      if (settings.language) transcription.language = settings.language;
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              noise_reduction: { type: 'near_field' },
              transcription,
              // Push-to-talk: the renderer commits the buffer when the user presses Space again.
              turn_detection: settings.pushToTalk ? null : {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: Number(settings.silenceMs) || 1000,
              },
            },
          },
        },
      }));
      for (const m of this.pending) ws.send(m);
      this.pending = [];
      send('stt', { type: 'open' });
    });
    ws.on('message', (raw) => {
      let ev;
      try { ev = JSON.parse(raw); } catch { return; }
      switch (ev.type) {
        case 'input_audio_buffer.committed': send('stt', { type: 'committed', id: ev.item_id }); break;
        case 'input_audio_buffer.speech_started': send('stt', { type: 'speech_started', id: ev.item_id }); break;
        case 'input_audio_buffer.speech_stopped': send('stt', { type: 'speech_stopped', id: ev.item_id }); break;
        case 'conversation.item.input_audio_transcription.delta': send('stt', { type: 'delta', id: ev.item_id, text: ev.delta }); break;
        case 'conversation.item.input_audio_transcription.completed': send('stt', { type: 'final', id: ev.item_id, text: (ev.transcript || '').trim() }); break;
        case 'conversation.item.input_audio_transcription.failed': send('stt', { type: 'final', id: ev.item_id, text: '' }); break;
        case 'error': send('error', wsError('Transcription', ev)); break;
      }
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      send('stt', { type: 'closed', reason: code !== 1000 ? `${code} ${reason}` : '' });
    });
    ws.on('error', (err) => send('error', `Transcription connection: ${err.message}`));
  },
  close() {
    const ws = this.ws;
    this.ws = null;
    this.pending = [];
    if (!ws) return;
    ws.removeAllListeners();
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(1000);
  },
  post(msg) {
    const m = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(m);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.pending.push(m);
  },
  append(pcm) { this.post({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }); },
  clear() { this.post({ type: 'input_audio_buffer.clear' }); },
  commit() { this.post({ type: 'input_audio_buffer.commit' }); },
};

// ---------- text-to-speech ----------

// Both engines emit: tts {type:'start', id, text} / {type:'text', id, delta} / {type:'end', id}
// and raw 24 kHz PCM16 chunks on 'audio'.
let utterance = 0;

const tts = {
  queue: [],
  busy: false,
  gen: 0,

  say(text) {
    text = (text || '').trim();
    if (!text) return;
    this.queue.push(text);
    this.pump();
  },

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const text = this.queue.shift();
    const id = ++utterance;
    const gen = this.gen;
    send('tts', { type: 'start', id, text });
    try {
      if (settings.ttsEngine === 'tts') await speakHttp(text, id, gen);
      else if (settings.ttsEngine === 'local') await speakLocal(text, id, gen);
      else await realtimeTts.speak(text, id, gen);
    } catch (err) {
      if (gen === this.gen) send('error', err.message);
    }
    send('tts', { type: 'end', id });
    this.busy = false;
    if (gen === this.gen) this.pump();
  },

  stop() {
    this.gen++;
    this.queue = [];
    realtimeTts.cancel();
    httpAbort?.abort();
    this.busy = false;
  },
};

// Engine 3: Chatterbox on this Mac (local-tts/server.py; its Python lives in ~/.claude-voice/local-tts).
// Free. The server streams a sentence at a time, a bit slower than real time on an M1.
const LOCAL_TTS_DIR = path.join(os.homedir(), '.claude-voice', 'local-tts');
const VOICES_DIR = path.join(os.homedir(), '.claude-voice', 'voices');
const localTts = {
  proc: null,
  ready: null, // Promise<port>

  start() {
    if (this.ready) return this.ready;
    const python = path.join(LOCAL_TTS_DIR, '.venv', 'bin', 'python');
    const script = path.join(__dirname, '..', 'local-tts', 'server.py').replace('app.asar', 'app.asar.unpacked');
    if (!fs.existsSync(python)) return Promise.reject(new Error(`Local voice isn't installed (${python} is missing).`));
    this.ready = new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(python, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/READY (\d+)/);
        if (m) resolve(Number(m[1]));
      });
      proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      proc.on('exit', (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        reject(new Error(`Local voice stopped (exit ${code}): ${err.trim().split('\n').pop() || 'no output'}`));
      });
    });
    return this.ready;
  },

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    proc?.kill();
  },
};

async function speakLocal(text, id, gen) {
  const port = await localTts.start();
  httpAbort = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/speak`, {
      method: 'POST',
      signal: httpAbort.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: settings.localVoice || 'default', language: settings.language || 'pt' }),
    });
    if (!res.ok) throw new Error(`Local voice: HTTP ${res.status}`);
    send('tts', { type: 'text', id, delta: text });
    let carry = null; // PCM16 samples are 2 bytes; chunks may split one
    for await (const chunk of res.body) {
      if (gen !== tts.gen) return;
      let buf = Buffer.from(chunk);
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      if (buf.length % 2) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
      if (buf.length) send('audio', buf);
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

// Cloned voices: a short recording of someone talking, saved as ~/.claude-voice/voices/<name>.wav.
function listVoices() {
  try { return fs.readdirSync(VOICES_DIR).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)).sort(); } catch { return []; }
}

// Chatterbox only looks at the first ~10 s of a voice sample, so make every one of them speech:
// cut silence at the edges, shorten long pauses, and bring the level up to a consistent peak.
function cleanVoiceSample(samples) {
  const FRAME = 480; // 20 ms at 24 kHz
  const frames = [];
  let loudest = 0;
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    let sum = 0;
    for (let j = i; j < i + FRAME; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / FRAME);
    frames.push(rms);
    if (rms > loudest) loudest = rms;
  }
  const voiced = frames.map((rms) => rms > loudest * 0.06); // ~-25 dB below the loudest frame
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) return new Int16Array(0);
  const kept = [];
  let quiet = 0;
  for (let f = Math.max(0, first - 5); f <= Math.min(frames.length - 1, last + 10); f++) {
    quiet = voiced[f] ? 0 : quiet + 1;
    if (quiet <= 12) kept.push(f); // keep at most ~250 ms of each pause
  }
  const out = new Int16Array(kept.length * FRAME);
  let peak = 1;
  kept.forEach((f, k) => {
    out.set(samples.subarray(f * FRAME, f * FRAME + FRAME), k * FRAME);
  });
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = Math.min((0.89 * 32767) / peak, 8);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(out[i] * gain);
  return out;
}

function saveVoice(name, pcm) {
  name = String(name || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40);
  if (!name || name === 'default') throw new Error('Give the voice a name.');
  const clean = cleanVoiceSample(new Int16Array(pcm));
  if (clean.length < 24000 * 5) throw new Error('Not enough speech: record at least 5 seconds of talking.');
  const data = Buffer.from(clean.buffer, clean.byteOffset, clean.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  fs.writeFileSync(path.join(VOICES_DIR, `${name}.wav`), Buffer.concat([header, data]));
  return name;
}

// Engine 1: a Realtime model used as a voice. Persistent socket, streams audio deltas.
const realtimeTts = {
  ws: null,
  ready: null,
  current: null, // { id, gen, resolve, reject }

  connect() {
    if (this.ready) return this.ready;
    if (!settings.openaiKey) return Promise.reject(new Error('Add your OpenAI API key in Settings.'));
    this.ready = new Promise((resolve, reject) => {
      const ws = openaiWs(`model=${encodeURIComponent(settings.realtimeModel)}`);
      explainRejection(ws, 'Voice');
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            instructions: [
              'You are a text-to-speech voice. Every user message is a script to read aloud.',
              'Read it exactly as written, word for word: never answer it, never add, remove or comment on anything.',
              `Voice style: ${ttsStyle()}`,
            ].join(' '),
            audio: {
              input: { turn_detection: null },
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: settings.voice },
            },
          },
        }));
        resolve();
      });
      ws.on('message', (raw) => {
        let ev;
        try { ev = JSON.parse(raw); } catch { return; }
        const cur = this.current;
        switch (ev.type) {
          case 'response.output_audio.delta':
            if (cur && cur.gen === tts.gen) send('audio', Buffer.from(ev.delta, 'base64'));
            break;
          case 'response.output_audio_transcript.delta':
            if (cur && cur.gen === tts.gen) send('tts', { type: 'text', id: cur.id, delta: ev.delta });
            break;
          case 'response.done':
            if (cur) { this.current = null; cur.resolve(); }
            break;
          case 'error':
            if (ev.error?.code === 'response_cancel_not_active') break;
            if (cur) { this.current = null; cur.reject(new Error(wsError('Voice', ev))); }
            else send('error', wsError('Voice', ev));
            break;
        }
      });
      const drop = (err) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.ready = null;
        reject(err || new Error('Voice connection closed'));
        if (this.current) { const c = this.current; this.current = null; c.reject(err || new Error('Voice connection closed')); }
      };
      ws.on('close', () => drop());
      ws.on('error', (err) => drop(new Error(`Voice connection: ${err.message}`)));
    });
    return this.ready;
  },

  async speak(text, id, gen) {
    await this.connect();
    await new Promise((resolve, reject) => {
      this.current = { id, gen, resolve, reject };
      this.ws.send(JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
        },
      }));
    });
  },

  cancel() {
    if (this.current && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'response.cancel' }));
      const c = this.current;
      this.current = null;
      c.resolve();
    }
  },

  reset() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.ready = null;
  },
};

// Engine 2: /v1/audio/speech streaming PCM, one request per sentence (all fetched in parallel, played in order).
let httpAbort = null;

function splitSentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  for (const p of parts) {
    if (out.length && (out[out.length - 1].length < 40)) out[out.length - 1] += p;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function speakHttp(text, id, gen) {
  if (!settings.openaiKey) throw new Error('Add your OpenAI API key in Settings.');
  httpAbort = new AbortController();
  const { signal } = httpAbort;
  const sentences = splitSentences(text);
  const requests = sentences.map((input) => fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${settings.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ttsModel, voice: settings.voice, input,
      response_format: 'pcm', stream_format: 'audio', instructions: ttsStyle(),
    }),
  }));
  try {
    for (let i = 0; i < requests.length; i++) {
      const res = await requests[i];
      if (!res.ok) {
        let msg = `${res.status}`;
        try { msg = (await res.json()).error?.message || msg; } catch {}
        throw new Error(`Voice: ${msg}`);
      }
      send('tts', { type: 'text', id, delta: (i ? ' ' : '') + sentences[i] });
      let carry = null; // PCM16 samples are 2 bytes; network chunks may split one
      for await (const chunk of res.body) {
        if (gen !== tts.gen) return;
        let buf = Buffer.from(chunk);
        if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
        if (buf.length % 2) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
        if (buf.length) send('audio', buf);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

// ---------- GPT-Live (full duplex; Claude is the client-delegation backend) ----------

const LIVE_INSTRUCTIONS = `
You are the voice of Claude Code, an AI coding agent working in the user's software project on their computer.
You cannot see the project, run commands, or know anything about it yourself: the backend (Claude) does all real work.
- Delegate every request, question or instruction to the backend, except pure small talk like greetings or "thanks".
- While waiting, you may say one very short natural filler ("Let me check."), then stay quiet until the result arrives.
- When a result arrives, say it naturally and faithfully: keep every fact, name, number and decision; don't add your own claims.
- If the user adds or corrects details while the backend is working, delegate again with the new information.
- Always speak in the language the user is speaking. Keep it brief and conversational.
`.trim();

// Transport: WebRTC, like the ChatGPT app. The renderer owns the RTCPeerConnection (Opus media
// tracks with adaptive jitter buffering and proper echo cancellation) and relays data-channel
// events here; this process holds the API key and does the SDP exchange.
const live = {
  active: false,
  started: false,
  inputText: '',        // user speech since the last delegation
  delegationId: null,   // latest client delegation (Claude's replies go here)
  inId: 0, outId: 0,
  speakingSide: null,   // 'user' | 'assistant' — for bubble grouping
  outIdleTimer: null,

  open() {
    if (this.active) return;
    if (!settings.openaiKey) { send('error', 'Add your OpenAI API key in Settings.'); send('stt', { type: 'closed' }); return; }
    this.active = true;
    this.started = false;
    send('live:connect');
  },

  // Exchange the renderer's SDP offer for OpenAI's answer. This HTTP request starts the session.
  async createSession(offerSdp) {
    const res = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: settings.liveModel,
          instructions: (settings.language || '').toLowerCase().startsWith('pt')
            ? `${LIVE_INSTRUCTIONS}\n- Default to Brazilian Portuguese (pt-BR) with a native Brazilian accent.`
            : LIVE_INSTRUCTIONS,
          audio: { output: { voice: settings.voice } },
          delegation: { type: 'client' },
        },
        transport: { type: 'webrtc', sdp: offerSdp },
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(body).error?.message || msg; } catch {}
      throw new Error(`GPT-Live: ${msg}`);
    }
    return JSON.parse(body).transport.sdp;
  },

  sendEvent(ev) {
    if (this.active) send('live:send', ev);
  },

  handle(ev) {
    switch (ev.type) {
      case 'session.started':
        this.started = true;
        send('stt', { type: 'open' });
        break;
      case 'session.input_transcript.delta':
        if (this.speakingSide !== 'user') {
          this.endOutput();
          this.speakingSide = 'user';
          this.inId++;
        }
        this.inputText += ev.delta;
        send('stt', { type: 'delta', id: `live-in-${this.inId}`, text: ev.delta });
        break;
      case 'session.output_transcript.delta':
        if (this.speakingSide !== 'assistant') {
          this.finishInput();
          this.speakingSide = 'assistant';
          this.outId++;
          send('tts', { type: 'start', id: `live-out-${this.outId}`, text: '' });
        }
        send('tts', { type: 'text', id: `live-out-${this.outId}`, delta: ev.delta });
        clearTimeout(this.outIdleTimer);
        this.outIdleTimer = setTimeout(() => this.endOutput(), 1500);
        break;
      case 'session.delegation.created':
        this.delegationId = ev.delegation?.id || null;
        // The event carries no text; the transcript may lag the delegation slightly.
        setTimeout(() => this.forwardToClaude(), 600);
        break;
      case 'error':
        send('error', wsError('GPT-Live', ev));
        break;
      case 'transport.closed': // synthesized by the renderer
        if (!this.active) break;
        this.active = false;
        this.started = false;
        this.endOutput();
        send('stt', { type: 'closed', reason: ev.reason || '' });
        break;
    }
  },

  finishInput() {
    if (this.speakingSide === 'user') send('stt', { type: 'final', id: `live-in-${this.inId}`, text: null, forward: false });
  },

  endOutput() {
    clearTimeout(this.outIdleTimer);
    if (this.speakingSide === 'assistant') send('tts', { type: 'end', id: `live-out-${this.outId}` });
    if (this.speakingSide === 'assistant') this.speakingSide = null;
  },

  forwardToClaude() {
    const text = this.inputText.trim();
    this.inputText = '';
    if (!text) return;
    this.finishInput();
    this.speakingSide = null;
    if (toChannel({ type: 'user', text })) send('delegated', { text });
    else send('error', 'Not connected to a Claude Code thread. Run /voice in your session.');
  },

  // Claude's reply (speak tool) -> GPT-Live says it. Appends are limited to ~500 tokens.
  relay(text) {
    if (!this.started) { send('error', 'GPT-Live is not running; turn the mic on.'); return; }
    const chunks = text.match(/[\s\S]{1,1500}(?=\s|$)|[\s\S]{1,1500}/g) || [];
    for (const content of chunks) this.sendEvent({ type: 'session.commentary.append', delegation_id: this.delegationId, content });
  },

  say(text) {
    if (!this.started) return;
    this.sendEvent({ type: 'session.instructions.append', delegation_id: null, content: `Say this to the user now, then listen: ${text}` });
  },

  append() {}, // audio travels on the WebRTC media track

  close() {
    if (!this.active) return;
    this.active = false;
    this.started = false;
    this.inputText = '';
    this.endOutput();
    send('live:disconnect');
  },
};

// Route mic/session control to whichever engine is active.
const input = () => (settings.ttsEngine === 'live' ? live : stt);

// ---------- iPhone pairing (same token file as `claude-voice pair`) ----------

const REMOTE_FILE = path.join(os.homedir(), '.claude-voice', 'remote.json');

function pairInfo() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')); } catch {}
  const created = !cfg.token;
  if (created) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(REMOTE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(REMOTE_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  const scutil = (k) => { try { return execFileSync('scutil', ['--get', k], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const host = `${scutil('LocalHostName') || os.hostname().replace(/\.local$/, '')}.local`;
  const name = scutil('ComputerName') || host;
  const url = `claudevoice://pair?token=${cfg.token}&host=${encodeURIComponent(host)}&name=${encodeURIComponent(name)}`;
  return { url, host, token: cfg.token, created, svg: qrSvg(url) };
}

// QR code as a crisp SVG: one path of unit squares, with a 4-module quiet zone.
function qrSvg(text) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  const size = n + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ---------- app ----------

// Chromium reorders a second instance's argv (switches first, values after), so
// `--connect <url>` can arrive as `--connect --cwd <url> ...`. Prefer `--connect=<url>`
// and only accept a value that is actually a ws:// URL.
function parseArgs(argv) {
  const isWs = (v) => typeof v === 'string' && /^wss?:\/\//.test(v);
  const t3 = argv.includes('--t3'); // opened by /voice in a T3 Code thread: no Claude thread to start
  const eq = argv.find((a) => a.startsWith('--connect='));
  if (eq && isWs(eq.slice('--connect='.length))) return { connect: eq.slice('--connect='.length), t3 };
  if (!argv.includes('--connect')) return { connect: null, t3 };
  return { connect: argv.find(isWs) || null, t3 };
}

function handleArgs(argv) {
  const { connect } = parseArgs(argv);
  if (connect) connectChannel(connect);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// Opened on its own (Dock, Ctrl+Option+Cmd+Space) with no thread: start one in Terminal, in the folder of
// the last thread. Its /voice opens the app again with --connect, which lands in handleArgs.
// Opening a .command file with Terminal goes through Launch Services, so unlike AppleScript it needs no
// Automation permission (no prompt, and nothing to re-grant after each ad-hoc-signed rebuild).
function startThread() {
  const dir = settings.lastCwd && fs.existsSync(settings.lastCwd) ? settings.lastCwd : os.homedir();
  const sh = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
  const file = path.join(os.tmpdir(), 'claude-voice', `thread-${Date.now()}.command`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A login shell, so claude is on PATH. The prompt goes first: the channels flag is variadic and would swallow it.
    fs.writeFileSync(file, `#!/bin/zsh -l\nrm -f -- "$0"\ncd ${sh(dir)} && claude /voice --dangerously-load-development-channels server:voice\n`,
      { mode: 0o700 });
  } catch (err) {
    send('error', `Couldn't start a Claude Code thread: ${err.message}`);
    return;
  }
  send('channel', { state: 'starting', cwd: dir });
  execFile('open', ['-a', 'Terminal', file], (err, _out, stderr) => {
    if (err) send('error', `Couldn't start a Claude Code thread in Terminal: ${String(stderr || err.message).trim()}`);
  });
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return;
  try {
    globalShortcut.register(settings.hotkey, () => {
      if (!win.isVisible()) win.show();
      send('hotkey');
    });
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 360,
    minHeight: 420,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0b0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('move', dockPanels);
  win.on('resize', dockPanels);
  win.on('minimize', () => { agentsWin?.hide(); historyWin?.hide(); pushUi(); });
  win.on('restore', () => {
    if (agentsWanted) showAgents(true);
    if (historyWanted) showHistory(true);
    pushUi();
  });
  win.on('focus', () => pushUi());
  win.on('blur', () => pushUi());
  win.on('closed', () => { agentsWin?.destroy(); historyWin?.destroy(); });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', (_e, argv) => handleArgs(argv));

app.whenReady().then(async () => {
  if (!gotLock) return;
  // The packaged app gets its icon from the bundle; in dev (npm start) set the Dock icon directly.
  const devIcon = path.join(__dirname, '../build/icon.png');
  if (!app.isPackaged && process.platform === 'darwin' && fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  settings = loadSettings();
  loadHistory();
  // Don't block startup on the macOS mic prompt (it reappears after every rebuild of an
  // ad-hoc-signed app); the window opens now and getUserMedia waits for the answer.
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('pair:info', () => pairInfo());
  ipcMain.handle('settings:set', (_e, next) => {
    if (LIVE_DISABLED && next.ttsEngine === 'live') delete next.ttsEngine;
    if (LIVE_DISABLED && LIVE_ONLY_VOICES.includes(next.voice)) delete next.voice;
    const voiceChanged = ['voice', 'realtimeModel', 'openaiKey', 'language'].some((k) => next[k] !== undefined && next[k] !== settings[k]);
    const sttChanged = ['sttModel', 'language', 'silenceMs', 'pushToTalk', 'openaiKey', 'ttsEngine', 'liveModel', 'voice'].some((k) => next[k] !== undefined && next[k] !== settings[k]);
    const wasOpen = !!(stt.ws || live.active);
    if (sttChanged) { stt.close(); live.close(); }
    settings = { ...settings, ...next };
    saveSettings(settings);
    registerHotkey();
    if (voiceChanged) realtimeTts.reset();
    if (settings.ttsEngine === 'local') localTts.start().catch((err) => send('error', err.message));
    else localTts.stop();
    if (sttChanged && wasOpen) input().open();
    return settings;
  });
  ipcMain.handle('voices:list', () => listVoices());
  ipcMain.handle('voices:save', (_e, name, pcm) => saveVoice(name, pcm));
  ipcMain.handle('voices:delete', (_e, name) => {
    if (listVoices().includes(name)) fs.rmSync(path.join(VOICES_DIR, `${name}.wav`));
    return listVoices();
  });
  ipcMain.handle('t3:status', () => t3.status());
  ipcMain.handle('t3:pair', (_e, link) => t3.pair(link));
  ipcMain.on('t3:unpair', () => t3.unpair());
  ipcMain.handle('channel:state', () => ({ url: channelUrl, connected: channel?.readyState === WebSocket.OPEN, activity }));
  ipcMain.on('stt:open', () => input().open());
  ipcMain.on('stt:close', () => input().close());
  ipcMain.on('stt:audio', (_e, pcm) => input().append(pcm));
  ipcMain.on('stt:clear', () => { if (settings.ttsEngine !== 'live') stt.clear(); });
  ipcMain.on('stt:commit', () => { if (settings.ttsEngine !== 'live') stt.commit(); });
  ipcMain.on('tts:stop', () => tts.stop());
  ipcMain.on('tts:test', () => {
    if (settings.ttsEngine === 'live') {
      if (live.started) live.say("Hi! This is how I'll sound when we talk.");
      else send('error', 'With GPT-Live, turn the mic on to hear the voice.');
    } else tts.say("Hi! This is how I'll sound when I talk to you.");
  });
  ipcMain.on('tts:say', (_e, text) => (settings.ttsEngine === 'live' ? live.say(text) : tts.say(text)));
  ipcMain.handle('send', (_e, msg) => toChannel(msg));
  ipcMain.on('context:set', (_e, text) => { pendingContext = String(text || '').trim(); });
  ipcMain.handle('live:create', (_e, sdp) => live.createSession(sdp));
  ipcMain.on('live:event', (_e, ev) => live.handle(ev));
  ipcMain.on('agents:toggle', () => showAgents(!agentsWin?.isVisible()));
  ipcMain.on('agents:close', () => showAgents(false));
  ipcMain.on('agents:stop', (_e, id) => toChannel({ type: 'agent_stop', id }));
  ipcMain.handle('agents:summary', () => agentsSummary());
  ipcMain.on('history:toggle', () => showHistory(!historyWin?.isVisible()));
  ipcMain.on('history:close', () => showHistory(false));
  ipcMain.on('history:clear', clearHistory);
  ipcMain.handle('history:summary', () => historySummary());
  ipcMain.on('ui:report', (_e, state) => { rendererUi = state || {}; pushUi(); });

  createWindow();
  registerHotkey();
  t3.start();
  win.webContents.once('did-finish-load', () => {
    handleArgs(process.argv);
    const args = parseArgs(process.argv);
    if (!args.connect && !args.t3) startThread();
    // Warm up the voice socket so the first reply starts instantly.
    if (settings.openaiKey && settings.ttsEngine === 'realtime') realtimeTts.connect().catch(() => {});
    if (settings.ttsEngine === 'local') localTts.start().catch((err) => send('error', err.message));
    send('engine', settings.ttsEngine);
  });
  // Fires when the app is opened again while running (Dock, `open`, the Ctrl+Option+Cmd+Space helper).
  app.on('activate', () => {
    if (!win || win.isDestroyed()) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  saveHistory(true);
  stt.close();
  live.close();
  realtimeTts.reset();
  localTts.stop();
  t3.stop();
});
app.on('window-all-closed', () => app.quit());
