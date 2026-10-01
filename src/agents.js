const $ = (id) => document.getElementById(id);
const agents = new Map(); // id -> { info, el }
const LOG_MAX = 400;

function fmtElapsed(a) {
  const s = Math.max(0, Math.round(((a.endedAt || Date.now()) - a.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
}

function card(info) {
  const el = document.createElement('div');
  el.className = 'agent open';
  el.innerHTML = '<div class="head"><span class="adot"></span><span class="name"></span><span class="meta"></span>'
    + '<button class="stop" title="Stop this agent">Stop</button></div><div class="activity"></div><div class="log"></div>';
  el.querySelector('.head').onclick = (e) => { if (!e.target.closest('.stop')) el.classList.toggle('open'); };
  el.querySelector('.stop').onclick = () => window.api.agentStop(info.id);
  $('list').prepend(el); // newest on top
  return el;
}

function render(id) {
  const { info, el } = agents.get(id);
  const running = info.status === 'running';
  el.classList.toggle('running', running);
  el.querySelector('.adot').className = `adot${running ? ' running' : ''}`;
  el.querySelector('.name').textContent = info.name;
  el.querySelector('.name').title = info.task || '';
  el.querySelector('.meta').textContent = fmtElapsed(info);
  el.querySelector('.stop').hidden = !running;
  el.querySelector('.activity').textContent = running ? (info.activity || 'Working…') : `${info.activity || info.status}`;
  renderHeader();
}

function renderHeader() {
  const all = [...agents.values()].map((a) => a.info);
  const running = all.filter((a) => a.status === 'running').length;
  $('headDot').className = `adot${running ? ' running' : ''}`;
  $('count').textContent = all.length ? `${running} running · ${all.length}` : '';
  $('empty').hidden = !!all.length;
}

function appendLog(id, line) {
  const a = agents.get(id);
  if (!a) return;
  const log = a.el.querySelector('.log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const l = document.createElement('div');
  l.className = `l ${line.kind}`;
  l.textContent = line.text;
  log.appendChild(l);
  while (log.childElementCount > LOG_MAX) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function upsert(info) {
  let a = agents.get(info.id);
  if (!a) {
    a = { info, el: card(info) };
    agents.set(info.id, a);
  } else {
    const wasRunning = a.info.status === 'running';
    a.info = { ...a.info, ...info };
    // A follow-up run (message_agent) reopens the log.
    if (!wasRunning && info.status === 'running') a.el.classList.add('open');
  }
  render(info.id);
}

window.api.onAgentsAll((list) => {
  agents.clear();
  $('list').querySelectorAll('.agent').forEach((el) => el.remove());
  for (const info of list) {
    upsert(info);
    for (const line of info.log || []) appendLog(info.id, line);
    if (info.status !== 'running') agents.get(info.id).el.classList.remove('open');
  }
  renderHeader();
});
window.api.onAgentUpdate(upsert);
window.api.onAgentLog(({ id, line }) => appendLog(id, line));

$('closeBtn').onclick = () => window.api.agentsClose();

// Tick elapsed time for running agents.
setInterval(() => {
  for (const [id, a] of agents) if (a.info.status === 'running') a.el.querySelector('.meta').textContent = fmtElapsed(a.info);
}, 1000);

renderHeader();
