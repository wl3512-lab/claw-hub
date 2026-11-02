'use strict';
// Logbook tab: one page per day of what every crab did. Uses app.js helpers.
(function () {
  let day = null;
  async function open() {
    const { days } = await api('/api/logbook');
    if (!day) day = days[0];
    setHtml($('#logDays'), days.map((d) => {
      const dt = new Date(d + 'T12:00:00');
      const label = d === days[0] ? 'today' : dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toLowerCase();
      return `<button class="log-day ${d === day ? 'on' : ''}" data-day="${d}">${label}</button>`;
    }).join(''));
    load(false);
  }
  async function load(fresh) {
    const box = $('#logPage');
    box.innerHTML = '<p class="tip-none">reading the transcripts…</p>';
    try {
      const b = await api(`/api/logbook/${day}${fresh ? '?fresh=1' : ''}`);
      const s = b.summary;
      const head = `<div class="log-head"><h1>${esc(new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase())}</h1>
        <p class="summary"><b>${s.chats}</b> chats · <b>${s.asks}</b> asks · <b>${s.steps}</b> steps${s.waiting ? ` · <span class="g"><b>${s.waiting}</b> waiting on you</span>` : ''}
        <button class="btn" id="logRefresh">rebuild</button></p></div>`;
      const ent = b.entries.map((e) => {
        const g = groupById(e.group);
        const endCls = /waiting|asked/.test(e.ending) ? 'g' : e.ending === 'working' ? 'p' : /stopped/.test(e.ending) ? 'r' : '';
        return `<article class="log-entry">
          <button class="log-crab" data-id="${e.id}" title="open chat">${crab(e, e.ending === 'working' ? 'type' : /waiting|asked/.test(e.ending) ? 'idle' : 'nap', 54, true)}</button>
          <div class="log-body">
            <h3><button data-id="${e.id}" class="log-link">${esc(e.title)}</button></h3>
            <div class="log-meta">${esc(folderName(e.cwd))}${g ? ` · ▸ ${esc(g.name)}` : ''} · ${new Date(e.first).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()}–${new Date(e.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()} · ${e.steps} steps${e.babies ? ` · ${e.babies} babies` : ''} · <span class="${endCls}">${esc(e.ending)}</span></div>
            ${e.asks.length ? `<ul class="log-asks">${e.asks.slice(-4).map((a) => `<li>${esc(a)}</li>`).join('')}${e.asks.length > 4 ? `<li class="more">+${e.asks.length - 4} more</li>` : ''}</ul>` : ''}
            ${e.last ? `<p class="log-last">${esc(e.last)}</p>` : ''}
          </div></article>`;
      }).join('') || '<p class="tip-none">no crabs worked this day.</p>';
      setHtml(box, head + ent);
    } catch (err) { box.innerHTML = `<p class="tip-none">${esc(err.message)}</p>`; }
  }
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-day]');
    if (d) { day = d.dataset.day; document.querySelectorAll('.log-day').forEach((b) => b.classList.toggle('on', b.dataset.day === day)); load(false); return; }
    if (e.target.id === 'logRefresh') { load(true); return; }
    const l = e.target.closest('.log-crab, .log-link');
    if (l) openConvo(l.dataset.id);
  });
  window.LogView = { open };
})();
