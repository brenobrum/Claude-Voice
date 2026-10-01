const $ = (id) => document.getElementById(id);
const log = $('caption'); // shows only the latest line

let settings = {};
let connected = false;
let listening = false;
let waitingForClaude = false;
let pendingPermission = null;
const userBubbles = new Map();  // stt item_id -> bubble
const ttsBubbles = new Map();   // tts utterance id -> bubble

// ---------- UI helpers ----------

function scrollDown() {}

function addMsg(role, text = '') {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  log.replaceChildren(el);
  return el;
}

function addNote(text, kind = '') {
  const el = document.createElement('div');
  el.className = `note ${kind}`;
  el.textContent = text;
  (kind === 'perm' ? $('perm') : log).replaceChildren(el);
  return el;
}

function showEmpty() {
  if (log.querySelector('.msg, .note')) return;
  const el = document.createElement('div');
  el.className = 'empty';
  if (!settings.openaiKey) el.innerHTML = 'Add your OpenAI API key in Settings.';
  else if (!connected) el.innerHTML = 'Run <code>claude-voice</code> in a terminal, then type <code>/voice</code>.';
  else return log.replaceChildren();
  log.replaceChildren(el);
}

function refreshStatus() {
  document.body.classList.toggle('listening', listening);
  document.body.classList.toggle('speaking', player.speaking);
  $('dot').className = `dot ${connected ? 'on' : ''}`;
  let s;
  if (!connected) s = 'Not connected — run /voice in a claude-voice terminal';
  else if (pendingPermission) s = 'Say “yes” or “no”';
  else if (player.speaking) s = fullDuplex() ? 'Speaking… (just talk to interrupt)' : 'Speaking… (Esc to interrupt)';
  else if (waitingForClaude) s = 'Claude is working… (watch the terminal)';
  else if (listening) s = settings.ttsEngine === 'live' ? 'Live — just talk' : 'Listening…';
  else s = 'Mic off — press Space';
  $('status').textContent = s;
}

// ---------- audio playback (24 kHz PCM16 stream) ----------

const player = {
  ctx: null,
  node: null,
  ready: null,
  speaking: false,
  idleTimer: null,
  lastVoicedAt: 0,   // wall-clock time of the last voiced chunk received
  muteUntil: 0,      // drop incoming audio until then (after a barge-in)
  backlog: [],       // chunks that arrive before the worklet is loaded

  init() {
    if (this.ready) return this.ready;
    this.ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'playback' });
    this.analyser = this.ctx.createAnalyser();
    orb.setOutput(this.analyser);
    this.ready = this.ctx.audioWorklet.addModule('player-worklet.js').then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'player-processor', { outputChannelCount: [1] });
      this.node.connect(this.ctx.destination);
      this.node.connect(this.analyser);
      // Speaking = something audible is coming out of the speakers right now.
      this.node.port.onmessage = ({ data }) => {
        if (data.peak > 0.006) { this.setSpeaking(true); this.checkIdle(); }
      };
      for (const c of this.backlog) this.node.port.postMessage({ type: 'push', samples: c }, [c.buffer]);
      this.backlog = [];
    });
    return this.ready;
  },

  play(bytes) {
    this.init();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const u8 = new Uint8Array(bytes);
    const pcm = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + (u8.byteLength & ~1)));
    if (!pcm.length) return;
    let peak = 0;
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      samples[i] = pcm[i] / 0x8000;
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }
    const now = performance.now();
    if (now < this.muteUntil) return; // just interrupted by the user
    if (peak > 200) this.lastVoicedAt = now;
    // GPT-Live streams audio continuously, including pure silence while idle. Keep the quiet
    // parts inside an utterance (pauses, soft sounds) but drop the idle stream so it doesn't
    // add latency.
    else if (now - this.lastVoicedAt > 1200) return;
    if (this.node) this.node.port.postMessage({ type: 'push', samples }, [samples.buffer]);
    else this.backlog.push(samples);
  },

  checkIdle() {
    clearTimeout(this.idleTimer);
    // Small tail so the mic doesn't pick up the last syllable echoing in the room.
    this.idleTimer = setTimeout(() => this.setSpeaking(false), 400);
  },

  setSpeaking(on) {
    if (this.speaking === on) return;
    this.speaking = on;
    if (!on) window.api.sttClear();
    refreshStatus();
  },

  // GPT-Live over WebRTC plays through an <audio> element; we only analyse that stream
  // (for the orb and to know when Claude is audibly speaking).
  attachStream(stream) {
    this.init();
    this.detachStream();
    this.remoteSrc = this.ctx.createMediaStreamSource(stream);
    this.remoteSrc.connect(this.analyser);
    const data = new Float32Array(1024);
    this.levelTimer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) { const a = Math.abs(v); if (a > peak) peak = a; }
      if (peak > 0.006) { this.setSpeaking(true); this.checkIdle(); }
    }, 50);
  },

  detachStream() {
    clearInterval(this.levelTimer);
    this.remoteSrc?.disconnect();
    this.remoteSrc = null;
  },

  stop() {
    this.node?.port.postMessage({ type: 'clear' });
    this.backlog = [];
    this.lastVoicedAt = 0;
    clearTimeout(this.idleTimer);
    this.setSpeaking(false);
  },
};

let ttsActive = 0;

window.api.onAudio((bytes) => player.play(bytes));

// Assistant text is revealed like typing, paced to the voice: while audio is playing it
// reveals at speaking speed (catching up if it falls behind); once the audio stops it flushes fast.
const typer = {
  items: new Set(), // bubbles with text still to reveal
  last: 0,
  running: false,

  push(b, text) {
    b._pending = (b._pending || '') + text;
    this.items.add(b);
    this.kick();
  },

  kick() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  },

  tick(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    for (const b of this.items) {
      const backlog = b._pending.length;
      const cps = player.speaking ? Math.max(16, backlog / 1.5) : Math.max(60, backlog * 3);
      b._carry = (b._carry || 0) + cps * dt;
      const n = Math.min(backlog, Math.floor(b._carry));
      if (n > 0) {
        b._carry -= n;
        b._text = (b._text || '') + b._pending.slice(0, n);
        b._pending = b._pending.slice(n);
        b.firstChild ? (b.firstChild.nodeValue = b._text) : b.appendChild(document.createTextNode(b._text));
        scrollDown();
      }
      if (!b._pending.length) {
        this.items.delete(b);
        if (b._ended) finishBubble(b);
      }
    }
    if (this.items.size) requestAnimationFrame((tt) => this.tick(tt));
    else this.running = false;
  },

  flush(b) {
    if (b._pending) { b._text = (b._text || '') + b._pending; b._pending = ''; b.textContent = b._text; }
    this.items.delete(b);
  },
};

function finishBubble(b) {
  // Show exactly what Claude said, even if the voice model's transcript differs slightly.
  if (b.dataset.full) b.textContent = b.dataset.full;
  b.classList.remove('streaming');
  if (!b.textContent.trim()) b.remove();
}

window.api.onTts((ev) => {
  if (ev.type === 'start') {
    ttsActive++;
    waitingForClaude = false;
    const b = addMsg('assistant');
    b.classList.add('streaming');
    b.dataset.full = ev.text;
    ttsBubbles.set(ev.id, b);
  } else if (ev.type === 'text') {
    const b = ttsBubbles.get(ev.id);
    if (b) typer.push(b, ev.delta);
  } else if (ev.type === 'end') {
    ttsActive = Math.max(0, ttsActive - 1);
    const b = ttsBubbles.get(ev.id);
    if (b) {
      ttsBubbles.delete(ev.id);
      b._ended = true;
      if (!b._pending) finishBubble(b); // otherwise the typer finishes it
    }
  }
  refreshStatus();
});

function stopSpeaking() {
  window.api.ttsStop();
  player.stop();
  ttsActive = 0;
  for (const b of ttsBubbles.values()) { typer.flush(b); finishBubble(b); }
  ttsBubbles.clear();
  refreshStatus();
}

// ---------- microphone (24 kHz PCM16 to the transcription socket) ----------

const mic = { stream: null, ctx: null, node: null };

let starting = false;

async function startListening() {
  if (listening || starting) return;
  if (!settings.openaiKey) { openSettings(); return; }
  starting = true;
  try { await openMic(); } finally { starting = false; }
}

async function openMic() {
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    addNote(`Microphone unavailable: ${err.message}. Allow it in System Settings → Privacy & Security → Microphone.`, 'error');
    return;
  }
  mic.ctx = new AudioContext({ sampleRate: 24000 });
  await mic.ctx.audioWorklet.addModule('mic-worklet.js');
  mic.node = new AudioWorkletNode(mic.ctx, 'mic-processor');
  mic.node.port.onmessage = ({ data }) => {
    if (!player.speaking) {
      bargeIn.reset();
      if (settings.ttsEngine !== 'live') window.api.sttAudio(data.pcm);
      return;
    }
    const interrupted = fullDuplex() && bargeIn.check(data.level, data.pcm);
    if (interrupted) interrupt();
    if (settings.ttsEngine === 'live') return; // GPT-Live gets the mic on its WebRTC track
    // While Claude talks, the speakers leak into the mic. The transcriber only gets silence then,
    // so it can't transcribe (and answer) Claude's own voice. On a real barge-in, replay the
    // recent frames so the start of what the user said isn't lost.
    if (interrupted) { for (const pcm of bargeIn.recent) window.api.sttAudio(pcm); bargeIn.recent = []; }
    else window.api.sttAudio(new ArrayBuffer(data.pcm.byteLength));
  };
  const source = mic.ctx.createMediaStreamSource(mic.stream);
  source.connect(mic.node);
  orb.setMic(mic.ctx, source);
  window.api.sttOpen();
  listening = true;
  refreshStatus();
}

// ---------- GPT-Live over WebRTC (same transport as the ChatGPT app) ----------

const rtc = {
  pc: null,
  dc: null,
  audio: null,

  async connect() {
    if (this.pc) return;
    if (!mic.stream) { window.api.liveEvent({ type: 'transport.closed', reason: 'microphone is not open' }); return; }
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => this.attachOutput(e.streams[0] || new MediaStream([e.track]));
    for (const track of mic.stream.getAudioTracks()) pc.addTrack(track, mic.stream);
    // The event channel must exist before the offer is created.
    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = ({ data }) => {
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      window.api.liveEvent(ev);
    };
    dc.onclose = () => { if (this.pc === pc) this.teardown('connection closed'); };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && ['failed', 'closed'].includes(pc.connectionState)) this.teardown(`WebRTC ${pc.connectionState}`);
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, 3000); // host candidates are enough; don't wait forever on STUN
      });
      const answer = await window.api.liveCreate(pc.localDescription.sdp);
      if (this.pc !== pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (err) {
      addNote(err.message.replace(/^Error invoking remote method 'live:create': (Error: )?/, ''), 'error');
      if (this.pc === pc) this.teardown('');
    }
  },

  attachOutput(stream) {
    // Play through a media element: that's what WebRTC's jitter buffer and echo canceller expect.
    this.audio?.pause();
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.srcObject = stream;
    this.audio.play().catch(() => {});
    player.attachStream(stream);
  },

  send(ev) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  },

  disconnect() {
    if (!this.pc) return;
    this.send({ type: 'session.close' });
    const pc = this.pc;
    setTimeout(() => { if (this.pc === pc) this.teardown(null, true); }, 2500);
  },

  teardown(reason, quiet = false) {
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    try { pc?.close(); } catch {}
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = null; }
    player.detachStream();
    player.setSpeaking(false);
    if (!quiet) window.api.liveEvent({ type: 'transport.closed', reason });
  },

  // Local barge-in: silence what's already buffered right away; GPT-Live stops on its own.
  duck(ms) {
    if (!this.audio) return;
    this.audio.muted = true;
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => { if (this.audio) this.audio.muted = false; }, ms);
  },
};

window.api.onLiveConnect(() => rtc.connect());
window.api.onLiveSend((ev) => rtc.send(ev));
window.api.onLiveDisconnect(() => rtc.disconnect());

// GPT-Live is built for full duplex: it hears you while it talks and stops on its own when
// you interrupt. Echo cancellation on the mic keeps its own voice out.
const fullDuplex = () => settings.ttsEngine === 'live' || settings.bargeIn;

// Local barge-in: cut our buffered audio the moment the user starts talking over Claude.
// Echo cancellation never removes Claude's voice completely, so learn how loud the leftover
// echo is (a slow average of mic frames while Claude talks) and only count frames clearly
// above it. ~300 ms of that triggers it.
const bargeIn = {
  echo: 0,     // typical mic level of Claude's own voice leaking back in
  loud: 0,     // consecutive loud frames
  recent: [],  // last ~500 ms of mic frames (100 ms each)

  reset() { this.loud = 0; this.recent = []; },

  check(level, pcm) {
    if (pcm) { this.recent.push(pcm); if (this.recent.length > 5) this.recent.shift(); }
    if (level > Math.max(0.2, this.echo * 3)) {
      if (++this.loud < 3) return false;
      this.loud = 0;
      return true;
    }
    this.loud = 0;
    this.echo = this.echo ? this.echo * 0.95 + level * 0.05 : level;
    return false;
  },
};

function interrupt() {
  stopSpeaking();
  rtc.duck(700);
  // The server keeps streaming for a moment before it registers the interruption; don't play that tail.
  player.muteUntil = performance.now() + 700;
}

function stopListening() {
  if (!listening) return;
  listening = false;
  mic.stream?.getTracks().forEach((t) => t.stop());
  mic.ctx?.close();
  mic.stream = mic.ctx = mic.node = null;
  orb.clearMic();
  window.api.sttClose();
  refreshStatus();
}

window.api.onStt((ev) => {
  switch (ev.type) {
    case 'closed':
      if (listening) {
        stopListening();
        if (ev.reason) addNote(`Transcription closed (${ev.reason}).`, 'error');
      }
      break;
    case 'speech_started':
      if (!userBubbles.has(ev.id)) {
        const b = addMsg('user partial', '…');
        userBubbles.set(ev.id, b);
      }
      break;
    case 'speech_stopped': {
      // Noise that never produces a transcript: drop the placeholder.
      const id = ev.id;
      setTimeout(() => {
        const b = userBubbles.get(id);
        if (b && b.textContent === '…') { b.remove(); userBubbles.delete(id); }
      }, 6000);
      break;
    }
    case 'delta': {
      let b = userBubbles.get(ev.id);
      if (!b) { b = addMsg('user partial'); userBubbles.set(ev.id, b); }
      if (b.textContent === '…') b.textContent = '';
      b.textContent += ev.text;
      scrollDown();
      break;
    }
    case 'final': {
      const b = userBubbles.get(ev.id);
      userBubbles.delete(ev.id);
      const text = ev.text ?? (b && b.textContent !== '…' ? b.textContent.trim() : '');
      if (!text) { b?.remove(); break; }
      if (b) { b.textContent = text; b.classList.remove('partial'); } else addMsg('user', text);
      handleUtterance(text, ev.forward !== false);
      break;
    }
  }
  refreshStatus();
});

// ---------- talking to the thread ----------

const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|allow|approve|go ahead|do it|sim|pode)\b/i;
const NO = /^\s*(no|nope|nah|deny|don'?t|stop|cancel|não|nao)\b/i;

async function handleUtterance(text, forward = true) {
  if (pendingPermission) {
    if (YES.test(text)) return answerPermission('allow');
    if (NO.test(text)) return answerPermission('deny');
  }
  // With GPT-Live, speech reaches Claude when GPT-Live delegates (see onDelegated).
  if (forward) await sendToThread(text);
}

window.api.onDelegated(() => { waitingForClaude = true; refreshStatus(); });

async function sendToThread(text) {
  const ok = await window.api.send({ type: 'user', text });
  if (!ok) { addNote('Not connected to a Claude Code thread. Run /voice in a claude-voice terminal.', 'error'); return; }
  waitingForClaude = true;
  refreshStatus();
}

window.api.onChannel((ev) => {
  connected = ev.state === 'connected';
  if (ev.state === 'connected') {
    $('folder').textContent = (ev.cwd || '').replace(/^\/(Users|home)\/[^/]+/, '~');
    $('folder').title = ev.cwd || '';
    addNote(`Attached to the Claude Code thread in ${ev.cwd}`);
    if (!listening && settings.openaiKey) startListening();
  } else if (ev.state === 'disconnected') {
    addNote('Thread disconnected (the claude session ended?). Run /voice again to reattach.', 'warn');
    waitingForClaude = false;
    $('folder').textContent = '';
    stopListening();
  }
  showEmpty();
  refreshStatus();
});

// ---------- permission prompts relayed from Claude Code ----------

window.api.onPermission((req) => {
  pendingPermission = req;
  const card = addNote('', 'perm');
  card.innerHTML = '<div class="perm-title"></div><pre></pre><div class="perm-actions"><button class="primary">Allow</button><button>Deny</button></div>';
  card.querySelector('.perm-title').textContent = `Claude wants to use ${req.tool_name}: ${req.description}`;
  card.querySelector('pre').textContent = req.input_preview;
  const [allow, deny] = card.querySelectorAll('button');
  allow.onclick = () => answerPermission('allow');
  deny.onclick = () => answerPermission('deny');
  req.card = card;
  const desc = req.description.length > 160 ? `${req.description.slice(0, 160)}…` : req.description;
  window.api.ttsSay(`I need permission to use ${req.tool_name}: ${desc}. Should I go ahead? Say yes or no.`);
  refreshStatus();
});

async function answerPermission(behavior) {
  const req = pendingPermission;
  if (!req) return;
  pendingPermission = null;
  await window.api.send({ type: 'permission', request_id: req.request_id, behavior });
  req.card.querySelector('.perm-actions').textContent = behavior === 'allow' ? '✓ Allowed' : '✕ Denied';
  setTimeout(() => req.card.remove(), 1500);
  waitingForClaude = true;
  refreshStatus();
}

window.api.onError((msg) => addNote(msg, 'error'));

// ---------- settings ----------

const form = $('settingsForm');

function openSettings() {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name] ?? '';
  }
  $('settings').showModal();
}

function readForm() {
  const next = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    next[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  }
  return next;
}

$('testVoice').onclick = async () => {
  settings = await window.api.setSettings(readForm());
  window.api.ttsTest();
};

$('settings').addEventListener('close', async () => {
  if ($('settings').returnValue !== 'save') return;
  settings = await window.api.setSettings(readForm());
  showEmpty();
});

// ---------- wiring ----------

function primaryAction() {
  if (player.speaking || ttsActive) stopSpeaking();
  else if (listening) stopListening();
  else startListening();
}

// ---------- typed context (sent along with the next voice message) ----------

function setContextOpen(open) {
  $('contextBox').hidden = !open;
  $('contextBtn').classList.toggle('open', open);
  document.body.classList.toggle('context-open', open);
  if (open) $('contextInput').focus();
  else $('contextInput').blur();
}

function syncContext() {
  const text = $('contextInput').value.trim();
  window.api.setContext(text);
  $('contextBtn').classList.toggle('has-context', !!text);
  $('contextBtn').title = text ? `Attached to your next voice message: ${text}` : 'Add typed context to your next voice message';
}

$('contextBtn').onclick = () => { $('contextBtn').blur(); setContextOpen($('contextBox').hidden); };
$('contextInput').addEventListener('input', syncContext);
$('contextInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); setContextOpen(false); }
});

window.api.onContextSent(() => {
  $('contextInput').value = '';
  syncContext();
  setContextOpen(false);
});

function toggleMic() { listening ? stopListening() : startListening(); }

$('orb').onclick = toggleMic;
$('micBtn').onclick = () => { $('micBtn').blur(); toggleMic(); };
$('settingsBtn').onclick = () => { $('settingsBtn').blur(); openSettings(); };
$('agentsBtn').onclick = () => { $('agentsBtn').blur(); window.api.agentsToggle(); };

function renderAgentsSummary({ total, running, open }) {
  $('agentsDot').className = `adot${running ? ' running' : ''}`;
  $('agentsCount').textContent = running ? `${running}/${total}` : total;
  $('agentsBtn').classList.toggle('open', open);
  $('agentsBtn').title = `Sub-agents: ${running} running, ${total} total (click to ${open ? 'hide' : 'show'} the panel)`;
}
window.api.onAgentsSummary(renderAgentsSummary);

$('historyBtn').onclick = () => { $('historyBtn').blur(); window.api.historyToggle(); };
function renderHistorySummary({ count, open }) {
  $('historyBtn').classList.toggle('open', open);
  $('historyBtn').title = `Message history: ${count} message${count === 1 ? '' : 's'} (click to ${open ? 'hide' : 'show'})`;
}
window.api.onHistorySummary(renderHistorySummary);
window.api.historySummary().then(renderHistorySummary);
window.api.agentsSummary().then(renderAgentsSummary);
window.api.onHotkey(primaryAction);

document.addEventListener('keydown', (e) => {
  if ($('settings').open || e.target === $('contextInput')) return;
  if (e.code === 'Space' && !e.repeat && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleMic(); }
  else if (e.key === 'Escape') stopSpeaking();
});

(async () => {
  orb.init($('orb'));
  settings = await window.api.getSettings();
  const st = await window.api.channelState();
  connected = connected || st.connected;
  if (connected && settings.openaiKey) startListening();
  showEmpty();
  refreshStatus();
})();
