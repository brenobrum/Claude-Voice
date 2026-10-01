// T3 Code bridge: Claude Voice as a T3 client, so voice mode works for any agent T3 runs (Claude, Codex, …).
// Typing /voice (or $voice) in a T3 thread attaches the app to it: what the user says becomes a message in that thread
// (as if typed in the composer) and the assistant's replies are read aloud as they stream in.
//
// T3's server writes ~/.t3/userdata/server-runtime.json ({ pid, origin }). Access is a bearer token from a
// one-time pairing token, minted with the `t3 pair` command bundled in T3 Code (or a link pasted from
// T3 → Settings → Connections), saved in ~/.claude-voice/t3.json. The wire protocol is
// Effect RPC over a WebSocket (JSON messages; stream chunks must be acked); commands go over HTTP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const OPEN = 1; // WebSocket.OPEN (ws is required lazily, see connect)

const CREDS_FILE = path.join(os.homedir(), '.claude-voice', 't3.json');
const t3Home = () => process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
const RUNTIME_FILE = () => path.join(t3Home(), 'userdata', 'server-runtime.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// The running T3 server's origin, if any.
function serverOrigin() {
  const rt = readJson(RUNTIME_FILE());
  if (!rt?.origin || (rt.pid && !pidAlive(rt.pid))) return null;
  return rt.origin.replace(/\/$/, '');
}

// Accept a pairing link (…/pair#token=… or ?token=…) or a bare token.
function parsePairing(input) {
  const raw = String(input || '').trim();
  try {
    const url = new URL(raw);
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('token') || url.searchParams.get('token');
    if (token) return { origin: url.origin, token };
  } catch {}
  return raw && !/\s/.test(raw) ? { origin: null, token: raw } : null;
}

// Text that reads well aloud: no code blocks, markdown syntax or URLs.
function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' (code on screen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------- pairing (also used by `claude-voice t3`, bin/t3.js) ----------

// Exchange a one-time pairing link or token for a bearer token and save it.
async function pairWithLink(input) {
  const parsed = parsePairing(input);
  if (!parsed) throw new Error('Paste the pairing link from T3 Code (Settings → Connections).');
  const base = (parsed.origin || serverOrigin() || '').replace(/\/$/, '');
  if (!base) throw new Error("T3 Code isn't running. Open it and try again.");
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: parsed.token,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_label: 'Claude Voice',
      client_device_type: 'desktop',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`T3 Code refused the pairing link (${body.error_description || body.error || `HTTP ${res.status}`}). Links expire after a few minutes and work once; create a new one.`);
  }
  const creds = { origin: base, token: body.access_token, expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null };
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

// No link needed: mint one with the `t3 pair` command inside the installed T3 Code app.
async function autoPair() {
  const app = fs.readdirSync('/Applications').find((n) => /^T3 Code.*\.app$/.test(n));
  if (!app) throw new Error("T3 Code isn't installed in /Applications.");
  if (!serverOrigin()) throw new Error("T3 Code isn't running. Open it and try again.");
  const root = path.join('/Applications', app, 'Contents');
  const exe = path.join(root, 'MacOS', fs.readdirSync(path.join(root, 'MacOS'))[0]);
  const cli = path.join(root, 'Resources', 'app.asar', 'apps', 'server', 'dist', 'bin.mjs');
  const out = await new Promise((resolve, reject) => {
    execFile(exe, [cli, 'pair', '--label', 'Claude Voice', '--ttl', '2m'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`t3 pair failed: ${String(stderr || err.message).trim().split('\n').pop()}`)) : resolve(stdout)));
  });
  const link = out.match(/Pairing URL:\s*(\S+)/)?.[1] || out.match(/Token:\s*(\S+)/)?.[1];
  if (!link) throw new Error("Couldn't read the pairing link from t3 pair.");
  return pairWithLink(link);
}

function createT3({ onAttach, onSpeak, onActivity, onState, onUserText, log = () => {} }) {
  let creds = readJson(CREDS_FILE);
  let ws = null;
  let origin = null;
  let retryTimer = null;
  let pingTimer = null;
  let nextId = 1;
  const streams = new Map(); // request id -> handler(value)
  const threads = new Map(); // thread id -> shell
  const projects = new Map(); // project id -> shell
  const seenUserAt = new Map(); // thread id -> latestUserMessageAt already looked at
  let status = { state: creds?.token ? 'searching' : 'unpaired' };
  let attached = null; // { threadId, title, project, cwd, runtimeMode, interactionMode, requestId }
  const buffers = new Map(); // assistant message id -> text not yet spoken
  let running = false;

  const setStatus = (s) => { status = s; onState(s); };

  async function http(method, route, body, form = false) {
    const res = await fetch(`${origin}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      },
      body: body ? (form ? new URLSearchParams(body) : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`T3 ${route}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  // ---------- RPC over the WebSocket ----------

  function rpc(tag, payload, onValue) {
    const id = String(nextId++);
    streams.set(id, onValue);
    ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
    return id;
  }

  function cancel(id) {
    if (!id || !streams.has(id)) return;
    streams.delete(id);
    if (ws?.readyState === OPEN) ws.send(JSON.stringify({ _tag: 'Interrupt', requestId: id, interruptors: [] }));
  }

  function onWire(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (msg._tag === 'Chunk') {
        const handler = streams.get(String(msg.requestId));
        for (const v of msg.values || []) {
          try { handler?.(v); } catch (err) { log(`T3 handler: ${err.message}`); }
        }
        ws.send(JSON.stringify({ _tag: 'Ack', requestId: msg.requestId }));
      } else if (msg._tag === 'Exit') {
        streams.delete(String(msg.requestId));
        if (msg.exit?._tag === 'Failure') log(`T3 request ${msg.requestId} failed: ${JSON.stringify(msg.exit.cause).slice(0, 300)}`);
      } else if (msg._tag === 'Defect' || msg._tag === 'ClientProtocolError') {
        log(`T3 protocol error: ${JSON.stringify(msg).slice(0, 300)}`);
      }
    }
  }

  // ---------- connection ----------

  function schedule(ms = 5000) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!creds?.token) creds = readJson(CREDS_FILE); // `claude-voice t3` may have paired meanwhile
    if (!creds?.token) { setStatus({ state: 'unpaired' }); schedule(10000); return; }
    origin = serverOrigin() || creds.origin;
    if (!origin || !serverOrigin()) { setStatus({ state: 'searching' }); schedule(); return; }
    const WebSocket = require('ws'); // loaded here so bin/t3.js (pairing only) needs no node_modules
    const sock = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { headers: { Authorization: `Bearer ${creds.token}` } });
    ws = sock;
    sock.on('open', () => {
      setStatus({ state: 'connected' });
      pingTimer = setInterval(() => sock.readyState === OPEN && sock.send(JSON.stringify({ _tag: 'Ping' })), 20000);
      rpc('orchestration.subscribeShell', {}, onShell);
      if (attached) subscribeThread(attached.threadId);
    });
    sock.on('message', onWire);
    sock.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        setStatus({ state: 'expired' });
        creds = null;
        try { fs.rmSync(CREDS_FILE); } catch {}
      }
    });
    sock.on('close', () => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(pingTimer);
      streams.clear();
      if (attached) attached.requestId = null;
      if (running) { running = false; onActivity(false); }
      if (status.state !== 'expired') { setStatus({ state: creds ? 'searching' : 'unpaired' }); schedule(); }
    });
    sock.on('error', () => {});
  }

  // ---------- projects and threads; spotting /voice ----------

  function onShell(item) {
    if (item.kind === 'snapshot') {
      for (const p of item.snapshot.projects || []) projects.set(p.id, p);
      for (const t of item.snapshot.threads || []) {
        threads.set(t.id, t);
        if (seenUserAt.has(t.id)) continue;
        seenUserAt.set(t.id, t.latestUserMessageAt);
        // Older messages are old news, but a /voice from just now may be what opened the app.
        if (!attached && !t.archivedAt && Date.now() - Date.parse(t.latestUserMessageAt || 0) < 60000) checkForVoiceCommand(t.id);
      }
    } else if (item.kind === 'project-upserted') {
      projects.set(item.project.id, item.project);
    } else if (item.kind === 'thread-upserted') {
      const t = item.thread;
      threads.set(t.id, t);
      if (attached?.threadId === t.id) attached.title = t.title;
      if (t.latestUserMessageAt && t.latestUserMessageAt !== seenUserAt.get(t.id) && !t.archivedAt) {
        seenUserAt.set(t.id, t.latestUserMessageAt);
        checkForVoiceCommand(t.id);
      }
    } else if (item.kind === 'thread-removed') {
      threads.delete(item.threadId);
      if (attached?.threadId === item.threadId) detach();
    }
  }

  async function checkForVoiceCommand(threadId) {
    if (attached?.threadId === threadId) return; // the thread stream already sees it
    try {
      const detail = await http('GET', `/api/orchestration/threads/${encodeURIComponent(threadId)}`);
      const users = (detail?.thread?.messages || []).filter((m) => m.role === 'user');
      const last = users[users.length - 1];
      if (last && /^[/$]voice\b/i.test(last.text.trim())) attach(threadId);
    } catch (err) { log(err.message); }
  }

  // ---------- the attached thread ----------

  function attach(threadId) {
    if (attached?.threadId === threadId && attached.requestId) { onAttach(describe()); return; }
    if (attached) cancel(attached.requestId);
    const shell = threads.get(threadId);
    attached = { threadId, title: shell?.title || 'T3 thread', runtimeMode: null, interactionMode: null, requestId: null };
    buffers.clear();
    subscribeThread(threadId);
    onAttach(describe());
  }

  function describe() {
    if (!attached) return null;
    const project = projects.get(threads.get(attached.threadId)?.projectId);
    return { threadId: attached.threadId, title: attached.title, project: project?.title || '', cwd: project?.workspaceRoot || '' };
  }

  function subscribeThread(threadId) {
    if (!ws || ws.readyState !== OPEN) return;
    let ready = false;
    attached.requestId = rpc('orchestration.subscribeThread', { threadId }, (item) => {
      if (item.kind === 'snapshot') {
        const t = item.snapshot.thread;
        attached.runtimeMode = t.runtimeMode;
        attached.interactionMode = t.interactionMode;
        setRunning(t.session?.status === 'running');
        ready = true;
      } else if (item.kind === 'event' && ready) {
        onThreadEvent(item.event);
      }
    });
  }

  function setRunning(on) {
    if (on === running) return;
    running = on;
    onActivity(on);
  }

  function onThreadEvent(ev) {
    const p = ev.payload || {};
    if (ev.type === 'thread.message-sent' && p.role === 'assistant') {
      const prev = buffers.get(p.messageId) || '';
      const text = prev + (p.streaming ? p.text : '');
      if (p.streaming) {
        // Speak whole sentences as they complete; keep the tail until more arrives.
        const cut = lastSentenceEnd(text);
        if (cut > 0 && !insideCode(text.slice(0, cut))) {
          say(text.slice(0, cut));
          buffers.set(p.messageId, text.slice(cut));
        } else buffers.set(p.messageId, text);
      } else {
        // A final event repeats the whole text when nothing streamed.
        say(prev || (p.text && !buffers.has(p.messageId) ? p.text : ''));
        buffers.delete(p.messageId);
      }
    } else if (ev.type === 'thread.message-sent' && p.role === 'user' && !p.streaming) {
      onUserText?.(p.text);
    } else if (ev.type === 'thread.session-set') {
      setRunning(p.session?.status === 'running');
    } else if (ev.type === 'thread.runtime-mode-set') {
      attached.runtimeMode = p.runtimeMode;
    } else if (ev.type === 'thread.interaction-mode-set') {
      attached.interactionMode = p.interactionMode;
    }
  }

  function lastSentenceEnd(text) {
    const re = /[.!?…:](\s+|\n)|\n\n/g;
    let end = 0;
    for (let m; (m = re.exec(text));) end = m.index + m[0].length;
    return end >= 40 ? end : 0;
  }

  const insideCode = (text) => ((text.match(/```/g) || []).length % 2) === 1;

  function say(text) {
    const clean = speakable(text);
    if (clean) onSpeak(clean, text);
  }

  function detach() {
    if (attached) cancel(attached.requestId);
    attached = null;
    buffers.clear();
    setRunning(false);
    onAttach(null);
  }

  // What the user said: a new turn in the attached thread, as if typed in T3's composer.
  async function sendText(text) {
    if (!attached || !creds) return false;
    const shell = threads.get(attached.threadId);
    try {
      await http('POST', '/api/orchestration/dispatch', {
        type: 'thread.turn.start',
        commandId: crypto.randomUUID(),
        threadId: attached.threadId,
        createdAt: new Date().toISOString(),
        message: { messageId: crypto.randomUUID(), role: 'user', text, attachments: [] },
        runtimeMode: attached.runtimeMode || shell?.runtimeMode || 'approval-required',
        interactionMode: attached.interactionMode || shell?.interactionMode || 'default',
      });
      return true;
    } catch (err) {
      log(err.message);
      return false;
    }
  }

  async function pair(link) {
    creds = await (String(link || '').trim() ? pairWithLink(link) : autoPair());
    if (ws) ws.close();
    connect();
    return true;
  }

  function unpair() {
    creds = null;
    try { fs.rmSync(CREDS_FILE); } catch {}
    if (attached) detach();
    if (ws) ws.close();
    setStatus({ state: 'unpaired' });
  }

  return {
    start: connect,
    stop() { clearTimeout(retryTimer); const s = ws; ws = null; s?.close(); },
    pair,
    unpair,
    attach,
    detach,
    sendText,
    status: () => ({ ...status, attached: describe() }),
    isAttached: () => !!attached,
  };
}

module.exports = { createT3, speakable, autoPair, pairWithLink, serverOrigin };
