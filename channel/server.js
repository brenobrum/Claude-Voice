#!/usr/bin/env node
// Claude Code channel that bridges a live terminal session to the Claude Voice app.
// Claude Code spawns this over stdio; the app connects to it over a local WebSocket.
//
//   app --(user speech)--> ws --> notifications/claude/channel --> Claude
//   Claude --(speak tool)--> ws --> app (streams TTS)
//   Claude Code --(permission_request)--> ws --> app; app --(verdict)--> Claude Code
//   Claude --(spawn_agent)--> headless `claude -p` sub-agent --(stream-json)--> ws --> app's agents panel
//
// Phones: once paired (`claude-voice pair` writes ~/.claude-voice/remote.json), the socket also listens on the
// local network and is announced over Bonjour as _claudevoice._tcp, so the iOS app can find every live session.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { WebSocketServer } = require('ws');
const { execFile, spawn } = require('child_process');
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

// Phone pairing: a stable token shared by every session on this Mac. Absent = local only.
const REMOTE_FILE = path.join(os.homedir(), '.claude-voice', 'remote.json');
let remoteToken = null;
try { remoteToken = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')).token || null; } catch {}

const INSTRUCTIONS = `
The user can talk to you by voice through the Claude Voice app.
Voice messages arrive as <channel source="voice"> tags containing transcribed speech; transcription can have errors, so infer intent.
The user is listening, not reading: ALWAYS answer a voice message by calling the voice "speak" tool. Whatever you pass to it is read aloud immediately.
- Reply in the language the user is speaking.
- Keep spoken text short, natural and conversational. No markdown, code, lists, file paths or URLs in spoken text; describe them in words.
- If a task will take more than a few seconds, first call speak with a one-sentence acknowledgement, then do the work, then speak a brief summary.
- You can still write longer details (code, tables) as normal text in the terminal and say "details are on screen".
If the user asks you to connect, start or attach voice, call the voice "attach" tool.
Sub-agents: when the user asks to start a new thread, run something in parallel or hand work off to an agent, call the voice "spawn_agent" tool.
Each sub-agent is a separate headless Claude Code session in this project; the user watches it live in the voice app's agents panel.
When one finishes you get a message "[agent <id>] finished"; tell the user briefly by voice what it did. Use "agent_output" for its full result,
"message_agent" to send it a follow-up, "stop_agent" to stop it and "list_agents" to see them all.
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

function monitorUrl() {
  return `ws://127.0.0.1:${port}/monitor?token=${token}`;
}

function openApp() {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/?token=${token}`;
    // We run as Electron-in-Node mode; don't let the GUI app inherit that.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile('open', ['-n', '-a', 'Claude Voice', '--args', '--connect', url, '--cwd', cwd], { env }, (err) => {
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'speak') {
    if (!clients.size) return { content: [{ type: 'text', text: 'Voice app is not connected; nothing was spoken. Run /voice to connect it.' }] };
    broadcast({ type: 'speak', text: String(args.text || '') });
    return { content: [{ type: 'text', text: 'spoken' }] };
  }
  if (name === 'attach') {
    const phone = args.device === 'phone';
    if (phone && !remoteToken) {
      return text('The iPhone app is not paired with this Mac yet. Tell the user to run "claude-voice pair" in a terminal, '
        + 'scan the QR code with the iPhone app, then start a new Claude Code session (running sessions only listen locally).', true);
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
          `If this session runs in the Claude desktop app (channels are not delivered there), start a Monitor with ws url ${monitorUrl()} `
            + '(description "voice messages", timeout_ms 1800000) to receive the user\'s speech, and re-arm it whenever it expires. '
            + 'In a terminal session started with claude-voice, do not start the Monitor: speech arrives as <channel source="voice"> messages.',
        ].join('\n'),
      }],
    };
  }
  if (name === 'spawn_agent') {
    const task = String(args.task || '').trim();
    if (!task) return text('task is required', true);
    const a = spawnAgent({ ...args, task });
    return text(`Started sub-agent ${a.id} ("${a.name}"). It runs in the background; you'll get "[agent ${a.id}] finished" with its result.`
      + (clients.size ? '' : ' (The voice app is not connected, so the user can\'t see the agents panel.)'));
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
    'v=1', `port=${port}`, `project=${project}`, `cwd=${cwd.replace(os.homedir(), '~')}`, `host=${host}`,
    `machine=${machineName()}`, `pid=${process.pid}`, `started=${Date.now()}`,
  ];
  bonjour = spawn('dns-sd', ['-R', `${project} · ${process.pid}`, '_claudevoice._tcp', 'local', String(port), ...txt], { stdio: 'ignore' });
  bonjour.on('error', () => { bonjour = null; });
}

async function main() {
  // Paired with a phone: listen on every interface (token required); otherwise loopback only.
  const wss = new WebSocketServer({ host: remoteToken ? '0.0.0.0' : '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  port = wss.address().port;
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
      ws.on('close', () => monitors.delete(ws));
      broadcast({ type: 'monitor', count: monitors.size });
      return;
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', cwd, project: path.basename(cwd), machine: machineName() }));
    ws.send(JSON.stringify({ type: 'agents', agents: agentSnapshot() }));
    ws.on('close', () => {
      clients.delete(ws);
      // Voice is over: end the session's Monitor too, so it isn't left open (and shown as in use).
      if (!clients.size) for (const m of monitors) m.close(4000, 'voice app disconnected');
    });
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'user' && msg.text?.trim()) {
        const frame = `[voice] The user said (transcribed speech, answer with the speak tool): ${msg.text.trim()}`;
        for (const m of monitors) if (m.readyState === 1) m.send(frame);
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: msg.text.trim(), meta: { kind: 'speech' } },
        });
      } else if (msg.type === 'permission' && msg.request_id) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: msg.request_id, behavior: msg.behavior === 'allow' ? 'allow' : 'deny' },
        });
      } else if (msg.type === 'agent_stop') {
        stopAgent(agents.get(msg.id));
      }
    });
  });

  await mcp.connect(new StdioServerTransport());
  // Die with the Claude Code session that spawned us.
  const quit = () => {
    for (const a of agents.values()) a.child?.kill('SIGINT');
    bonjour?.kill();
    process.exit(0);
  };
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
}

main().catch((err) => {
  process.stderr.write(`voice channel failed: ${err.stack || err}\n`);
  process.exit(1);
});
