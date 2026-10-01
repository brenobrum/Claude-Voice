const $ = (id) => document.getElementById(id);
const log = $('log');
let count = 0;
let lastDay = '';

const fmtTime = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (at) => new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function renderCount() {
  $('count').textContent = count ? ` · ${count}` : '';
  $('empty').hidden = !!count;
}

function add(entry, scroll = true) {
  const day = fmtDay(entry.at);
  if (day !== lastDay) {
    lastDay = day;
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = day;
    log.appendChild(d);
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const el = document.createElement('div');
  el.className = `m ${entry.dir} ${entry.kind}`;
  el.textContent = entry.text;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${entry.dir === 'sent' ? 'You' : 'Claude'} · ${fmtTime(entry.at)}`;
  el.appendChild(meta);
  log.appendChild(el);
  count++;
  renderCount();
  if (scroll && atBottom) log.scrollTop = log.scrollHeight;
}

window.api.onHistoryAll((list) => {
  log.querySelectorAll('.m, .day').forEach((el) => el.remove());
  count = 0;
  lastDay = '';
  for (const entry of list) add(entry, false);
  renderCount();
  log.scrollTop = log.scrollHeight;
});
window.api.onHistoryAdd((entry) => add(entry));

$('closeBtn').onclick = () => window.api.historyClose();
$('clearBtn').onclick = () => { if (count && confirm('Clear the message history?')) window.api.historyClear(); };

renderCount();
