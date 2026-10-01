// What the Claude thread is doing (channel/server.js `activity`), as a small live indicator:
//   ● Thinking… · 12s            or   ● Bash  npm test · 4s
//   ◌ 2 in background: Fix tests — Read src/main.js
// Shared by the main window (under the orb) and the history panel (under the messages).
(() => {
  const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };

  function row(cls) {
    const el = document.createElement('div');
    el.className = `act-row ${cls}`;
    return el;
  }

  function dots() {
    const d = document.createElement('span');
    d.className = 'act-dots';
    d.append(...[0, 1, 2].map(() => document.createElement('i')));
    return d;
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  let timer = null;

  // Render `a` into `el` (hidden when there's nothing going on).
  function render(el, a) {
    clearInterval(timer);
    el.replaceChildren();
    const busy = a && a.state && a.state !== 'idle';
    const bg = (a && a.background) || [];
    el.hidden = !busy && !bg.length;
    if (el.hidden) return;

    if (busy) {
      const r = row('main');
      r.append(dots());
      if (a.state === 'tool' && a.detail) {
        const [name, ...rest] = a.detail.split('  ');
        r.append(span('act-tool', name));
        if (rest.length) r.append(span('act-arg', rest.join('  ')));
      } else {
        r.append(span('act-label', 'Thinking…'));
      }
      const t = span('act-time', '');
      r.append(t);
      const tick = () => { t.textContent = a.since ? fmtElapsed(Date.now() - a.since) : ''; };
      tick();
      timer = setInterval(tick, 1000);
      el.append(r);
    }

    if (bg.length) {
      const r = row('bg');
      const d = document.createElement('span');
      d.className = 'adot running';
      r.append(d);
      const first = bg[0];
      const label = bg.length === 1 ? `In background: ${first.label}` : `${bg.length} in background: ${first.label}`;
      r.append(span('act-label', label));
      if (first.activity) r.append(span('act-arg', `— ${first.activity}`));
      r.title = bg.map((b) => `${b.label}${b.activity ? ` — ${b.activity}` : ''}`).join('\n');
      el.append(r);
    }
  }

  window.Activity = { render };
})();
