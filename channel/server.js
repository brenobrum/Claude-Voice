#!/usr/bin/env node
// Claude Code channel that bridges a live terminal session to the Claude Voice app.
// Claude Code spawns this over stdio; the app connects to it over a local WebSocket.
//
//   app --(user speech)--> ws --> notifications/claude/channel --> Claude
//   Claude --(speak tool)--> ws --> app (streams TTS)
//   Claude Code --(permission_request)--> ws --> app; app --(verdict)--> Claude Code
//   Claude --(spawn_agent)--> headless `claude -p` sub-agent --(stream-json)--> ws --> app's agents panel
//   app --(ui_state)--> ws --> app_state tool / voice messages; Claude --(app_control)--> ws --> app (opens panels, mic…)
//   Claude Code hooks --(hook.sh, POST /hook)--> activity (thinking / tool / background) --> ws --> app
//
// Phones: once paired (`claude-voice pair` writes ~/.claude-voice/remote.json), the socket also listens on the
// local network and is announced over Bonjour as _claudevoice._tcp, so the iOS app can find every live session.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { WebSocketServer } = require('ws');
const { execFile, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

// Sub-agents are headless Claude Code sessions; they load MCP servers from the user's config too.
// Don't run a second voice bridge inside them.
if (process.env.CLAUDE_VOICE_SUBAGENT) process.exit(0);

const token = crypto.randomBytes(16).toString('hex');
const cwd = process.cwd();
let clients = new Set();   // voice apps
let monitors = new Set();  // Claude Code Monitor sockets (desktop-app sessions, where channels aren't delivered)
let port = null;
let monitorCloseTimer = null;
const pendingSpeech = []; // speech frames waiting for a Monitor
let appUi = null;          // latest UI state reported by the desktop app (panels, mic, mode)
let uiClient = null;       // the socket that reported it
const liveMonitors = () => [...monitors].filter((m) => m.readyState === 1).length;

// Channel messages only reach terminal sessions started with channels enabled (claude-voice); sessions run by
// other apps (Claude desktop app, T3 Code, anything on the Agent SDK) need a Monitor instead. Tell them apart by
// the parent's command line.
let channelsDelivered = true;
try {
  const parent = require('child_process').execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' });
  channelsDelivered = /development-channels|--channels/.test(parent);
} catch {}

// Sessions run by T3 Code: there the Claude Voice app talks to T3 itself (src/t3.js), so /voice only acknowledges.
function underT3() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const [ppid, ...cmd] = require('child_process').execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      if (/T3 Code|t3code|\/\.t3\//i.test(cmd.join(' '))) return true;
      pid = Number(ppid);
    } catch { return false; }
  }
  return false;
}
const inT3 = !channelsDelivered && underT3();

// Phone pairing: a stable token shared by every session on this Mac. Absent = local only.
const REMOTE_FILE = path.join(os.homedir(), '.claude-voice', 'remote.json');
let remoteToken = null;
try { remoteToken = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')).token || null; } catch {}

// Install prompt: shipped inside the app bundle; fall back to the GitHub raw URL if the bundled copy is missing.
const INSTALL_PROMPT_URL = 'https://raw.githubusercontent.com/brenobrum/Claude-Voice/main/INSTALL-PROMPT.md';
const INSTALL_PROMPT_BUNDLED = path.join(__dirname, '..', 'INSTALL-PROMPT.md');
async function loadInstallPrompt() {
  try { return fs.readFileSync(INSTALL_PROMPT_BUNDLED, 'utf8'); } catch {}
  try {
    return await new Promise((resolve, reject) => {
      require('https').get(INSTALL_PROMPT_URL, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        let body = ''; res.setEncoding('utf8');
        res.on('data', (c) => body += c);
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  } catch { return null; }
}

const INSTRUCTIONS = `
The user can talk to you by voice through the Claude Voice app.
Voice messages arrive as <channel source="voice"> tags containing transcribed speech; transcription can have errors, so infer intent.
The user is listening, not reading: ALWAYS answer a voice message by calling the voice "speak" tool. Whatever you pass to it is read aloud immediately.
- Reply in the language the user is speaking.
- Keep spoken text short, natural and conversational. No markdown, code, lists, file paths or URLs in spoken text; describe them in words.
- If a task will take more than a few seconds, first call speak with a one-sentence acknowledgement, then do the work, then speak a brief summary.
- You can still write longer details (code, tables) as normal text in the terminal and say "details are on screen".
If the user asks you to connect, start or attach voice, call the voice "attach" tool.
Threads: a thread is an interactive Claude Code session on this Mac that the user can talk to (this one is one). When the user asks to open
a new thread or session (optionally in another project, optionally with a first task), call "new_thread"; it opens in a new Terminal window
and shows up in the voice apps. "list_threads" lists the running threads and "end_thread" ends one.
Sub-agents: when the user asks to run something in parallel or hand work off to an agent, call the voice "spawn_agent" tool.
Each sub-agent is a separate headless Claude Code session in this project; the user watches it live in the voice app's agents panel.
When one finishes you get a message "[agent <id>] finished"; tell the user briefly by voice what it did. Use "agent_output" for its full result,
"message_agent" to send it a follow-up, "stop_agent" to stop it and "list_agents" to see them all.
The app: voice messages say what the desktop app looks like right now (which panels are open, whether the mic is on).
"app_state" returns the full current state. When the user asks you to do something in the app (open or close the history
or agents panel, turn the mic off, stop talking, open settings, switch mode…), call "app_control"; don't tell them to click.
If you turn the mic off, say so first: they can't answer by voice until they turn it back on (Space or the mic button).
Installing: if the user asks how to install Claude Voice, how to set it up on another Mac, or how to share it, call "copy_install_prompt" — it puts the install prompt on their clipboard. Then speak one short line: that it's on their clipboard, paste into a Claude Code session on the target Mac.
`.trim();

const mcp = new Server(
  { name: 'voice', version: '0.2.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

const APP_ACTIONS = [
  'open_history', 'close_history', 'open_agents', 'close_agents', 'mic_on', 'mic_off', 'stop_speaking',
  'open_settings', 'close_settings', 'open_pairing', 'close_pairing', 'open_typed_context', 'close_typed_context',
  'mode_live', 'mode_realtime', 'show_window', 'minimize_window',
];

// One line for voice messages: "history open · agents closed (1 running) · mic on · realtime".
function uiSummary() {
  if (!appUi) return '';
  const s = appUi;
  const parts = [`history ${s.history_panel}`, `agents ${s.agents_panel}${s.agents_running ? ` (${s.agents_running} running)` : ''}`,
    `mic ${s.mic}`, `mode ${s.mode}`];
  if (s.window !== 'open' && s.window !== 'focused') parts.push(`window ${s.window}`);
  for (const k of ['settings_dialog', 'pairing_dialog', 'typed_context_box']) if (s[k] === 'open') parts.push(`${k.replace(/_/g, ' ')} open`);
  return parts.join(' · ');
}

function monitorUrl() {
  return `ws://127.0.0.1:${port}/monitor?token=${token}`;
}

function openApp() {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/?token=${token}`;
    // We run as Electron-in-Node mode; don't let the GUI app inherit that.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile('open', ['-n', '-a', 'Claude Voice', '--args', `--connect=${url}`, `--cwd=${cwd}`], { env }, (err) => {
      resolve(err ? `Could not open Claude Voice: ${err.message}. Is it installed in /Applications?` : null);
    });
  });
}

// ---------- sub-agents (headless Claude Code sessions) ----------

const agents = new Map(); // id -> agent
let agentSeq = 0;
const LOG_MAX = 400;      // log lines kept per agent

function claudeBin() {
  for (const p of [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

function agentInfo(a) {
  return {
    id: a.id, name: a.name, task: a.task, status: a.status, activity: a.activity,
    startedAt: a.startedAt, endedAt: a.endedAt, costUsd: a.costUsd, sessionId: a.sessionId,
  };
}

function agentSnapshot() {
  return [...agents.values()].map((a) => ({ ...agentInfo(a), log: a.log }));
}

function agentLog(a, kind, text) {
  const line = { kind, text: String(text).slice(0, 2000), t: Date.now() };
  a.log.push(line);
  if (a.log.length > LOG_MAX) a.log.splice(0, a.log.length - LOG_MAX);
  broadcast({ type: 'agent_log', id: a.id, line });
}

function agentUpdate(a) {
  broadcast({ type: 'agent', agent: agentInfo(a) });
  broadcastActivity();
}

// One-line summary of a tool call, e.g. "Bash  npm test" / "Read  src/main.js".
function describeTool(name, input = {}) {
  const arg = input.command || input.file_path || input.path || input.pattern || input.url || input.query
    || input.description || input.prompt || '';
  const short = String(arg).split(`${cwd}/`).join('').replace(/\s+/g, ' ').trim();
  return short ? `${name}  ${short.length > 140 ? `${short.slice(0, 140)}…` : short}` : name;
}

function handleAgentEvent(a, ev) {
  if (ev.session_id && !a.sessionId) a.sessionId = ev.session_id;
  if (ev.type === 'system' && ev.subtype === 'task_summary' && ev.detail) {
    a.activity = ev.detail;
    agentUpdate(a);
  } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    // The stream can repeat a message; log each content block once.
    (ev.message?.content || []).forEach((block, i) => {
      const key = `${ev.message.id}:${i}`;
      if (a.seen.has(key)) return;
      a.seen.add(key);
      if (block.type === 'text' && block.text.trim()) {
        if (block.text.trim() === a.lastText) return;
        a.lastText = block.text.trim();
        agentLog(a, 'text', a.lastText);
      } else if (block.type === 'tool_use') {
        const line = describeTool(block.name, block.input);
        agentLog(a, 'tool', line);
        a.activity = line;
        agentUpdate(a);
      }
    });
  } else if (ev.type === 'user' && !ev.parent_tool_use_id) {
    for (const block of ev.message?.content || []) {
      if (block.type === 'tool_result' && block.is_error) {
        const c = Array.isArray(block.content) ? block.content.map((x) => x.text || '').join(' ') : block.content;
        const msg = String(c || 'tool error').replace(/<\/?[a-z_]+>/g, '').replace(/\s+/g, ' ').trim();
        agentLog(a, 'error', msg.length > 200 ? `${msg.slice(0, 200)}…` : msg);
      }
    }
  } else if (ev.type === 'result' || 'total_cost_usd' in ev) {
    a.result = ev.result || a.lastText || '';
    a.resultError = !!ev.is_error;
    a.costUsd = (a.costUsd || 0) + (ev.total_cost_usd || 0);
  }
}

// Start (or continue, with resume) a headless run for agent `a`.
function runAgent(a, prompt) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', a.permissionMode];
  if (a.model) args.push('--model', a.model);
  if (a.sessionId) args.push('--resume', a.sessionId);
  const env = { ...process.env, CLAUDE_VOICE_SUBAGENT: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(claudeBin(), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  a.child = child;
  a.status = 'running';
  a.endedAt = null;
  a.result = null;
  a.activity = 'Starting…';
  agentLog(a, 'prompt', prompt);
  agentUpdate(a);

  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handleAgentEvent(a, JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.on('error', (err) => { stderr += err.message; });
  child.on('close', (code, signal) => {
    if (a.child !== child) return;
    a.child = null;
    a.endedAt = Date.now();
    if (a.stopping) { a.status = 'stopped'; a.stopping = false; }
    else if (code === 0 && !a.resultError) a.status = 'done';
    else {
      a.status = 'failed';
      if (!a.result) a.result = stderr.trim() || `exited with ${signal || `code ${code}`}`;
    }
    a.activity = a.status === 'done' ? 'Finished' : a.status === 'stopped' ? 'Stopped' : 'Failed';
    // The final answer is usually the last text already in the log; don't repeat it.
    if (a.result && a.result !== a.lastText) agentLog(a, a.status === 'done' ? 'result' : 'error', a.result);
    agentUpdate(a);
    notifyClaude(`[agent ${a.id}] ${a.status === 'done' ? 'finished' : a.status} ("${a.name}"). Result:\n${(a.result || '(no output)').slice(0, 4000)}`);
  });
}

// ---------- threads (interactive Claude Code sessions on this Mac with a voice channel) ----------
//
// Every voice channel registers in RUN_DIR (see registerForHooks), so any thread can list the others,
// open new ones (a Terminal window running claude with the voice channel) and end them.

const startedAt = Date.now();

function listThreads() {
  let files = [];
  try { files = fs.readdirSync(RUN_DIR); } catch {}
  const out = [];
  for (const f of files) {
    const pid = Number(f);
    if (!pid) continue;
    try { process.kill(pid, 0); } catch { continue; }
    let lines = [];
    try { lines = fs.readFileSync(path.join(RUN_DIR, f), 'utf8').split('\n'); } catch { continue; }
    const p = Number(lines[0]?.split(' ')[0]);
    const dir = lines[1] || '';
    out.push({
      pid, port: p, cwd: dir, project: dir ? path.basename(dir) : `pid ${pid}`,
      started: Number(lines[2]) || null, self: pid === process.ppid,
    });
  }
  return out.sort((a, b) => (b.started || 0) - (a.started || 0));
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// Open a new interactive thread in a Terminal window. dir may start with ~.
// A .command file opened with Terminal needs no Automation permission (AppleScript would).
function newThread({ cwd: dir, prompt } = {}) {
  return new Promise((resolve) => {
    const target = path.resolve(String(dir || cwd).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return resolve({ ok: false, text: `No folder ${target}.` });
    // The prompt goes before the channels flag, which is variadic and would swallow it.
    const cmd = `cd ${shq(target)} && ${shq(claudeBin())}${prompt?.trim() ? ` ${shq(prompt.trim())}` : ''}`
      + ' --dangerously-load-development-channels server:voice';
    const file = path.join(os.tmpdir(), 'claude-voice', `thread-${Date.now()}.command`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/zsh -l\nrm -f -- "$0"\n${cmd}\n`, { mode: 0o700 });
    } catch (err) { return resolve({ ok: false, text: `Could not start a thread: ${err.message}` }); }
    execFile('open', ['-a', 'Terminal', file], (err, _out, stderr) => {
      resolve(err
        ? { ok: false, text: `Could not open a Terminal window: ${String(stderr || err.message).trim()}` }
        : { ok: true, text: `Opening a new thread in ${target.replace(os.homedir(), '~')}.` });
    });
  });
}

function endThread(pid) {
  const t = listThreads().find((x) => x.pid === Number(pid));
  if (!t) return { ok: false, text: `No running thread ${pid}.` };
  // A moment later, so a thread ending itself can still answer the app.
  setTimeout(() => { try { process.kill(t.pid, 'SIGTERM'); } catch {} }, 300);
  return { ok: true, text: `Ending the thread in ${t.project}.` };
}

function threadsText() {
  const all = listThreads();
  if (!all.length) return 'No threads.';
  return all.map((t) => `${t.pid}${t.self ? ' (this thread)' : ''}  ${t.project}  ${t.cwd.replace(os.homedir(), '~')}`
    + (t.started ? `  started ${new Date(t.started).toLocaleTimeString()}` : '')).join('\n');
}

// Claude Code cuts Monitor events at ~500 characters. Keep long speech whole in a file and
// point the thread at it.
const MONITOR_MAX = 380;
function monitorText(text) {
  if (text.length <= MONITOR_MAX) return text;
  const dir = path.join(os.tmpdir(), 'claude-voice');
  const file = path.join(dir, `speech-${Date.now()}.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
  } catch { return text; }
  return `${text.slice(0, 200)}… [long message, read the full text in ${file} before answering]`;
}

// Tell the main thread something happened (channel in terminal sessions, Monitor in desktop-app sessions).
async function notifyClaude(text) {
  for (const m of monitors) if (m.readyState === 1) m.send(text.replace(/\s*\n\s*/g, ' ').slice(0, 1500));
  try { await mcp.notification({ method: 'notifications/claude/channel', params: { content: text, meta: { kind: 'agent' } } }); } catch {}
}

function spawnAgent({ task, name, model, permission_mode: permissionMode }) {
  const id = `a${++agentSeq}`;
  const a = {
    id, task, name: (name || task).replace(/\s+/g, ' ').trim().slice(0, 60), model: model || null,
    permissionMode: permissionMode || 'auto', status: 'running', activity: '', log: [], seen: new Set(),
    startedAt: Date.now(), endedAt: null, costUsd: 0, sessionId: null, child: null, result: null,
  };
  agents.set(id, a);
  runAgent(a, task);
  return a;
}

function stopAgent(a) {
  if (!a?.child) return false;
  a.stopping = true;
  a.child.kill('SIGINT');
  const child = a.child;
  setTimeout(() => { if (a.child === child) child.kill('SIGKILL'); }, 3000);
  return true;
}

// ---------- activity (what the main thread is doing, from Claude Code hooks) ----------
//
// state: idle | thinking | tool (detail = the tool line). background: in-session subagents (Agent tool)
// and running voice sub-agents. Without the hooks installed we never hear "Stop", so then a spoken
// reply ends the busy state instead.

const RUN_DIR = path.join(os.homedir(), '.claude-voice', 'run');
const HOOK_FILE = path.join(os.homedir(), '.claude-voice', 'hook.sh');
const STALE_MS = 10 * 60 * 1000; // no hook event for this long while busy: assume we missed the Stop
const activity = { state: 'idle', detail: '', since: Date.now() };
const subagents = new Map(); // agent_id -> { label, activity }
let hooksSeen = false;
let staleTimer = null;

function activityInfo() {
  const background = [
    ...subagents.values(),
    ...[...agents.values()].filter((a) => a.status === 'running').map((a) => ({ label: a.name, activity: a.activity })),
  ];
  return { ...activity, background };
}

function broadcastActivity() {
  broadcast({ type: 'activity', activity: activityInfo() });
}

function setActivity(state, detail = '') {
  clearTimeout(staleTimer);
  if (state !== 'idle') staleTimer = setTimeout(() => setActivity('idle'), STALE_MS);
  if (activity.state === state && activity.detail === detail) return;
  if (activity.state !== state) activity.since = Date.now();
  activity.state = state;
  activity.detail = detail;
  broadcastActivity();
}

const toolName = (name) => String(name || 'tool').replace(/^mcp__(.+?)__/, '$1 · ');

// Cancel from the voice app: the next hook of the main thread answers `continue: false`, which stops the turn
// (and a PreToolUse also denies the tool, so it doesn't run). Text being generated stops at the next hook.
let cancelRequested = false;
function cancelTurn() {
  if (activity.state === 'idle') return false;
  cancelRequested = true;
  setActivity('idle');
  return true;
}

// The hook's reply to Claude Code (null = no opinion).
function hookReply(ev) {
  if (!cancelRequested || ev.agent_id) return null;
  if (['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(ev.hook_event_name)) {
    cancelRequested = false;
    return null;
  }
  if (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(ev.hook_event_name)) return null;
  cancelRequested = false;
  const reason = 'The user cancelled this from the voice app.';
  return {
    continue: false, stopReason: reason,
    ...(ev.hook_event_name === 'PreToolUse'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
      : {}),
  };
}

function onHook(ev) {
  hooksSeen = true;
  if (cancelRequested && !ev.agent_id) return; // stay idle until the cancel lands
  const sub = ev.agent_id && subagents.get(ev.agent_id);
  // A subagent's tools while the main turn is over (or tagged with its id) are background work.
  const background = sub || (activity.state === 'idle' && subagents.size > 0);
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit':
      setActivity('thinking');
      break;
    case 'PreToolUse':
      if (sub) { sub.activity = describeTool(toolName(ev.tool_name), ev.tool_input); broadcastActivity(); }
      else if (background) break;
      else if (ev.tool_name === 'mcp__voice__speak') setActivity('thinking');
      else setActivity('tool', describeTool(toolName(ev.tool_name), ev.tool_input));
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (!background) setActivity('thinking');
      break;
    case 'SubagentStart':
      subagents.set(ev.agent_id || crypto.randomUUID(), { label: ev.agent_type || 'agent', activity: '' });
      broadcastActivity();
      break;
    case 'SubagentStop':
      if (subagents.delete(ev.agent_id)) broadcastActivity();
      break;
    case 'Stop':
    case 'StopFailure':
      setActivity('idle');
      break;
    case 'SessionEnd':
      subagents.clear();
      setActivity('idle');
      break;
  }
}

// Let hook.sh (spawned by this session's Claude Code process) find us: ~/.claude-voice/run/<claude pid>.
function registerForHooks() {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    for (const f of fs.readdirSync(RUN_DIR)) {
      try { process.kill(Number(f), 0); } catch { fs.rmSync(path.join(RUN_DIR, f), { force: true }); }
    }
    // Line 1 is what hook.sh reads; the rest lets other threads list this one (see listThreads).
    fs.writeFileSync(path.join(RUN_DIR, String(process.ppid)), `${port} ${token}\n${cwd}\n${startedAt}\n`, { mode: 0o600 });
    // Keep the installed hook script current (it can't run from inside the app's asar).
    const script = fs.readFileSync(path.join(__dirname, 'hook.sh'), 'utf8');
    if ((() => { try { return fs.readFileSync(HOOK_FILE, 'utf8'); } catch { return ''; } })() !== script) {
      fs.writeFileSync(HOOK_FILE, script, { mode: 0o755 });
    }
  } catch (err) {
    process.stderr.write(`voice channel: activity hooks unavailable: ${err.message}\n`);
  }
}

function hooksInstalled() {
  try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8').includes('.claude-voice/hook.sh'); } catch { return false; }
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'speak',
      description: 'Say something out loud to the user through the Claude Voice app. Use plain conversational sentences.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'What to say aloud' } },
        required: ['text'],
      },
    },
    {
      name: 'attach',
      description: 'Connect the user\'s voice app to this session so they can talk to you by voice. '
        + 'device "mac" (default) opens the Claude Voice desktop app; "phone" is for the iOS app, which finds this session on the local network by itself.',
      inputSchema: {
        type: 'object',
        properties: { device: { type: 'string', enum: ['mac', 'phone'], description: 'Which voice app the user is using. Default "mac".' } },
      },
    },
    {
      name: 'spawn_agent',
      description: 'Start a sub-agent: a new, separate headless Claude Code thread in this project that works on a task in the background. '
        + 'The user watches its progress live in the Claude Voice agents panel. You are notified with its result when it finishes.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent (it does not see this conversation).' },
          name: { type: 'string', description: 'Short label shown in the agents panel (2-5 words).' },
          model: { type: 'string', description: 'Optional model alias or id (e.g. "sonnet", "opus"). Defaults to the user\'s default model.' },
          permission_mode: {
            type: 'string', enum: ['auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'],
            description: 'Permission mode for the sub-agent. Default "auto". Use "plan" for read-only research.',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'new_thread',
      description: 'Open a new interactive Claude Code thread on this Mac (a Terminal window with the voice channel), which the user '
        + 'can then talk to from the voice apps. Unlike a sub-agent it is not supervised by you.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Project folder (absolute or ~/…). Defaults to this thread\'s folder.' },
          prompt: { type: 'string', description: 'Optional first message for the new thread.' },
        },
      },
    },
    {
      name: 'list_threads',
      description: 'List the interactive Claude Code threads with a voice channel running on this Mac (pid, project, folder).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'end_thread',
      description: 'End another running thread (its Claude Code session exits). Use the pid from list_threads.',
      inputSchema: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'] },
    },
    {
      name: 'app_state',
      description: 'What the Claude Voice desktop app is showing right now: history and agents panels open or closed, mic on or off, '
        + 'whether it is speaking, voice mode (realtime reads your replies verbatim; live is a full-duplex GPT-Live conversation), open dialogs.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'app_control',
      description: 'Operate the Claude Voice desktop app for the user: open/close the history or agents panel, turn the mic on/off, '
        + 'stop the current speech, open/close settings or the iPhone pairing QR code, open/close the typed-context box, '
        + 'switch voice mode, or show/minimize the window. Returns the app state afterwards.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: APP_ACTIONS } },
        required: ['action'],
      },
    },
    {
      name: 'list_agents',
      description: 'List the sub-agents started in this session with their status and current activity.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_output',
      description: 'Get a sub-agent\'s final result (or latest output if still running) and its recent activity log.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'message_agent',
      description: 'Send a follow-up instruction to a finished or stopped sub-agent; it continues the same thread with its full context.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    },
    {
      name: 'stop_agent',
      description: 'Stop a running sub-agent.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'copy_install_prompt',
      description: 'Copy the Claude Voice install prompt to the user\'s clipboard. Call this when the user asks how to install Claude Voice, how to set it up on another machine, or how to share it. After calling, speak one short sentence telling them it\'s on their clipboard and to paste into a Claude Code session.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'speak') {
    if (!clients.size) return { content: [{ type: 'text', text: 'Voice app is not connected; nothing was spoken. Run /voice to connect it.' }] };
    broadcast({ type: 'speak', text: String(args.text || '') });
    if (!hooksSeen) setActivity('idle');
    return { content: [{ type: 'text', text: 'spoken' }] };
  }
  if (name === 'attach') {
    const phone = args.device === 'phone';
    if (phone && !remoteToken) {
      return text('The iPhone app is not paired with this Mac yet. Tell the user to run "claude-voice pair" in a terminal, '
        + 'scan the QR code with the iPhone app, then start a new Claude Code session (running sessions only listen locally).', true);
    }
    if (inT3 && !phone) {
      return {
        content: [{
          type: 'text',
          text: 'This session runs inside T3 Code. The Claude Voice app handles voice mode for T3 threads by itself '
            + '(it reads this thread through T3), so do not start a Monitor and do not call speak. '
            + 'Reply with one short line: "🎙️ Voice mode on." If the app does not open, the user needs to connect T3 Code '
            + 'once in Claude Voice → Settings → T3 Code.',
        }],
      };
    }
    if (!phone) {
      const err = await openApp();
      if (err) return { content: [{ type: 'text', text: err }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: [
          phone
            ? `This session is announced on the local network as "${path.basename(cwd)}"; the user picks it in the iPhone app. `
              + `${clients.size ? 'A voice app is already connected.' : 'No voice app is connected yet.'}`
            : 'Claude Voice is opening and connecting to this session.',
          channelsDelivered
            ? 'Channels are enabled in this session (started with claude-voice): do not start a Monitor, speech arrives as '
              + '<channel source="voice"> messages.'
            // Claude desktop app, T3 Code and other apps that run Claude Code through the Agent SDK.
            : `Channels are not delivered to this session, so start a Monitor now with ws url ${monitorUrl()} `
              + '(description "voice messages", timeout_ms 1800000) to receive the user\'s speech, and re-arm it whenever it expires.',
          ...(hooksInstalled() ? [] : ['The voice app can\'t show what you are doing (thinking, running tools) because the Claude Voice hooks '
            + 'aren\'t installed. Mention once, in text, that running "claude-voice hooks" in a terminal enables it.']),
        ].join('\n'),
      }],
    };
  }
  if (name === 'app_state') {
    if (!clients.size) return text('The voice app is not connected. Run /voice to connect it.', true);
    if (!appUi) return text('The connected voice app does not report its state (only the desktop app does).');
    return text(JSON.stringify(appUi, null, 2));
  }
  if (name === 'app_control') {
    const action = String(args.action || '');
    if (!APP_ACTIONS.includes(action)) return text(`Unknown action "${action}". One of: ${APP_ACTIONS.join(', ')}.`, true);
    if (!clients.size) return text('The voice app is not connected. Run /voice to connect it.', true);
    const before = JSON.stringify(appUi);
    broadcast({ type: 'ui_action', action });
    // Give the app a moment to report the new state.
    for (let i = 0; i < 15 && JSON.stringify(appUi) === before; i++) await new Promise((r) => setTimeout(r, 100));
    return text(`Done: ${action}. App now: ${uiSummary() || 'state unknown'}`);
  }
  if (name === 'spawn_agent') {
    const task = String(args.task || '').trim();
    if (!task) return text('task is required', true);
    const a = spawnAgent({ ...args, task });
    return text(`Started sub-agent ${a.id} ("${a.name}"). It runs in the background; you'll get "[agent ${a.id}] finished" with its result.`
      + (clients.size ? '' : ' (The voice app is not connected, so the user can\'t see the agents panel.)'));
  }
  if (name === 'new_thread') {
    const r = await newThread(args);
    return text(r.text, !r.ok);
  }
  if (name === 'list_threads') return text(threadsText());
  if (name === 'end_thread') {
    if (Number(args.pid) === process.ppid) return text('That is this thread; the user can end it themselves.', true);
    const r = endThread(args.pid);
    return text(r.text, !r.ok);
  }
  if (name === 'list_agents') {
    if (!agents.size) return text('No sub-agents yet.');
    return text([...agents.values()].map((a) => `${a.id} [${a.status}] ${a.name}${a.activity ? ` — ${a.activity}` : ''}`).join('\n'));
  }
  const a = agents.get(String(args.id || ''));
  if (['agent_output', 'message_agent', 'stop_agent'].includes(name) && !a) return text(`No sub-agent with id ${args.id}.`, true);
  if (name === 'agent_output') {
    const recent = a.log.slice(-30).map((l) => `${l.kind}: ${l.text.slice(0, 300)}`).join('\n');
    return text(`${a.id} [${a.status}] ${a.name}\n\nResult:\n${a.result || a.lastText || '(none yet)'}\n\nRecent activity:\n${recent}`);
  }
  if (name === 'message_agent') {
    if (a.child) return text(`${a.id} is still running; stop it first or wait for it to finish.`, true);
    if (!a.sessionId) return text(`${a.id} has no session to continue.`, true);
    runAgent(a, String(args.text || ''));
    return text(`Sent to ${a.id}; it is working again.`);
  }
  if (name === 'stop_agent') return text(stopAgent(a) ? `Stopping ${a.id}.` : `${a.id} is not running.`);
  if (name === 'copy_install_prompt') {
    const prompt = await loadInstallPrompt();
    if (!prompt) return text('Could not load the install prompt (no bundled copy and GitHub fetch failed).', true);
    try {
      await new Promise((resolve, reject) => {
        // Without a UTF-8 locale (Claude Code doesn't pass LANG) pbcopy reads the bytes as Mac Roman: "ç" -> "√ß".
        const p = spawn('pbcopy', { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exit ${code}`)));
        p.stdin.end(prompt);
      });
    } catch (e) {
      return text(`Could not copy to clipboard: ${e.message}`, true);
    }
    return text('The install prompt is now on the user\'s clipboard. Tell them to paste it into a Claude Code session on the target Mac.');
  }
  throw new Error(`Unknown tool: ${name}`);
});

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => broadcast({ type: 'permission_request', ...params }),
);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const isLoopback = (addr = '') => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

let machine = null;
function machineName() {
  if (machine) return machine;
  try { machine = require('child_process').execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(); } catch {}
  return machine || os.hostname().replace(/\.local$/, '');
}

// Announce this session over Bonjour with the system's dns-sd (it stays registered while the process lives).
let bonjour = null;
function advertise() {
  let host = os.hostname();
  try { host = `${require('child_process').execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`; } catch {}
  const project = path.basename(cwd);
  const txt = [
    'v=1', `port=${port}`, `project=${project}`, `cwd=${cwd.replace(os.homedir(), '~').slice(-200)}`, `host=${host}`,
    `machine=${machineName()}`, `pid=${process.pid}`, `started=${Date.now()}`,
  ];
  bonjour = spawn('dns-sd', ['-R', `${project} · ${process.pid}`, '_claudevoice._tcp', 'local', String(port), ...txt], { stdio: 'ignore' });
  bonjour.on('error', () => { bonjour = null; });
}

async function main() {
  // Paired with a phone: listen on every interface (token required); otherwise loopback only.
  // Plain HTTP on the same port takes hook events (POST /hook, this Mac only).
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method !== 'POST' || u.pathname !== '/hook' || !isLoopback(req.socket.remoteAddress)
      || !safeEqual(u.searchParams.get('token'), token)) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let ev = null;
      try { ev = JSON.parse(body); } catch {}
      const reply = ev && hookReply(ev);
      if (reply) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      else res.writeHead(204).end();
      if (ev) try { onHook(ev); } catch {}
    });
  });
  const wss = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, remoteToken ? '0.0.0.0' : '127.0.0.1', r));
  port = server.address().port;
  registerForHooks();
  process.stderr.write(`voice channel listening on ws://127.0.0.1:${port}/?token=${token}\n`);
  if (remoteToken) advertise();

  wss.on('connection', (ws, req) => {
    const u = new URL(req.url, 'http://x');
    const t = u.searchParams.get('token');
    if (!safeEqual(t, token) && !(remoteToken && safeEqual(t, remoteToken))) return ws.close(4001, 'bad token');
    // Only this Mac may arm a Monitor (it delivers speech into the thread as-is).
    if (u.pathname === '/monitor' && !isLoopback(req.socket.remoteAddress)) return ws.close(4003, 'local only');
    if (u.pathname === '/monitor') {
      monitors.add(ws);
      ws.on('close', () => { monitors.delete(ws); broadcast({ type: 'monitor', count: liveMonitors(), needed: !channelsDelivered }); });
      broadcast({ type: 'monitor', count: liveMonitors(), needed: !channelsDelivered });
      // Speech that arrived before Claude armed the Monitor (e.g. the phone talked before /voice phone).
      for (const frame of pendingSpeech.splice(0)) ws.send(frame);
      return;
    }
    clients.add(ws);
    clearTimeout(monitorCloseTimer);
    ws.send(JSON.stringify({ type: 'hello', cwd, project: path.basename(cwd), machine: machineName() }));
    ws.send(JSON.stringify({ type: 'agents', agents: agentSnapshot() }));
    ws.send(JSON.stringify({ type: 'activity', activity: activityInfo() }));
    ws.send(JSON.stringify({ type: 'monitor', count: liveMonitors(), needed: !channelsDelivered }));
    ws.on('close', () => {
      clients.delete(ws);
      if (ws === uiClient) { appUi = null; uiClient = null; }
      // Voice is over: end the session's Monitor too, so it isn't left open (and shown as in use).
      // Phones drop briefly (Wi-Fi, app switching) and reconnect, so wait a little first.
      if (clients.size) return;
      clearTimeout(monitorCloseTimer);
      monitorCloseTimer = setTimeout(() => {
        if (!clients.size) for (const m of monitors) m.close(4000, 'voice app disconnected');
      }, remoteToken ? 30000 : 0);
    });
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'ui_state' && msg.state) {
        appUi = msg.state;
        uiClient = ws;
      } else if (msg.type === 'user' && msg.text?.trim()) {
        setActivity('thinking');
        const ui = uiSummary();
        const frame = `[voice] The user said (transcribed speech, answer with the speak tool): ${monitorText(msg.text.trim())}`
          + (ui ? `\n[app: ${ui}]` : '');
        for (const m of monitors) if (m.readyState === 1) m.send(frame);
        // A desktop-app session only hears speech through its Monitor. Without one, hold the speech
        // until /voice arms it, and tell the app so the user knows what to do.
        if (!channelsDelivered && !liveMonitors()) {
          pendingSpeech.push(frame);
          if (pendingSpeech.length > 10) pendingSpeech.shift();
          ws.send(JSON.stringify({ type: 'needs_attach' }));
        }
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: msg.text.trim(), meta: { kind: 'speech', ...(ui ? { app: ui } : {}) } },
        });
      } else if (msg.type === 'permission' && msg.request_id) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: msg.request_id, behavior: msg.behavior === 'allow' ? 'allow' : 'deny' },
        });
      } else if (msg.type === 'cancel') {
        cancelTurn();
      } else if (msg.type === 'agent_stop') {
        stopAgent(agents.get(msg.id));
      } else if (msg.type === 'agent_spawn' && msg.task?.trim()) {
        const mode = ['auto', 'plan', 'acceptEdits'].includes(msg.permission_mode) ? msg.permission_mode : 'auto';
        const a = spawnAgent({ task: msg.task.trim(), name: msg.name, permission_mode: mode });
        notifyClaude(`[agent ${a.id}] started by the user from the voice app ("${a.name}"): ${a.task.slice(0, 500)}`);
      } else if (msg.type === 'agent_message' && msg.text?.trim()) {
        const a = agents.get(msg.id);
        if (a && !a.child && a.sessionId) runAgent(a, msg.text.trim());
      } else if (msg.type === 'threads') {
        ws.send(JSON.stringify({ type: 'threads', threads: listThreads() }));
      } else if (msg.type === 'thread_new') {
        const r = await newThread({ cwd: msg.cwd, prompt: msg.prompt });
        ws.send(JSON.stringify({ type: 'thread_result', ...r }));
      } else if (msg.type === 'thread_end') {
        const t = listThreads().find((x) => x.port === Number(msg.port) || x.pid === Number(msg.pid));
        const r = t ? endThread(t.pid) : { ok: false, text: 'That thread is not running.' };
        ws.send(JSON.stringify({ type: 'thread_result', ...r }));
      }
    });
  });

  await mcp.connect(new StdioServerTransport());
  // Die with the Claude Code session that spawned us.
  const quit = () => {
    for (const a of agents.values()) a.child?.kill('SIGINT');
    bonjour?.kill();
    try { fs.rmSync(path.join(RUN_DIR, String(process.ppid)), { force: true }); } catch {}
    process.exit(0);
  };
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
}

main().catch((err) => {
  process.stderr.write(`voice channel failed: ${err.stack || err}\n`);
  process.exit(1);
});
