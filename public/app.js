'use strict';
const $ = (s) => document.querySelector(s);
const { pixelCritter, hueFor, crab, lookFor, SHELLS, emptyShell } = window.Critter;

const ui = {
  view: 'room', prevView: 'room', sel: null, convos: [], groups: [], filter: 'all', q: '',
  lastStatus: new Map(), limit: 250, sending: false, skills: null, enhSkill: null,
};

// ---------- utils ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shortPath(p) { return (p || '').replace(/^\/Users\/[^/]+/, '~'); }
function folderName(p) { const s = shortPath(p).split('/').filter(Boolean); return s[s.length - 1] || 'home'; }
function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
}
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text, { gfm: true }));
  return `<p style="white-space:pre-wrap">${esc(text)}</p>`;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800); }
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function setHtml(el, html) { if (el._html !== html) { el._html = html; el.innerHTML = html; } }
function whereLabel(live) {
  if (!live) return '';
  if (live.inHub) return 'here';
  if (live.phone) return 'phone';
  if (live.entrypoint === 'claude-vscode') return 'vs code';
  if (live.entrypoint === 'claude-desktop') return 'claude app';
  if (live.tty) return 'terminal';
  return live.entrypoint || '';
}
function mood(c) { return !c.live ? 'nap' : c.live.status === 'busy' ? 'busy' : 'idle'; }
function activityText(live) {
  const a = live && live.activity;
  if (!a) return 'working';
  return a.kind === 'tool' ? `${a.tool.toLowerCase()} ${a.text}` : a.text;
}
const groupById = (id) => ui.groups.find((g) => g.id === id);
const cur = () => ui.convos.find((x) => x.id === ui.sel);
const liveOnes = () => ui.convos.filter((c) => c.live && !c.bot);
const PARK_WHERE = { 'claude-vscode': 'vs code', 'claude-desktop': 'claude app', cli: 'terminal', phone: 'phone', hub: 'here', 'sdk-cli': 'here' };
// parked chats get a stand-in live record so the pen can draw them napping
const parkedOnes = () => ui.convos.filter((c) => c.parked && !c.live && !c.archived).map((c) => ({
  ...c, live: { parked: true, where: PARK_WHERE[c.parked.where] || c.parked.where, status: 'parked', statusSince: c.parked.since, activity: c.parked.activity || {}, helpers: c.parked.helpers || [] },
}));

const stillCache = new Map();
function stillCritter(c) {
  const l = lookFor(c);
  const key = `${mood(c)}|${l.hue}|${l.shell}`;
  if (!stillCache.has(key)) stillCache.set(key, crab(c, mood(c), 34, true));
  return stillCache.get(key);
}

// ---------- views ----------
function show(view) {
  if (view !== 'chat') ui.prevView = view;
  ui.view = view;
  $('#vRoom').classList.toggle('hidden', view !== 'room');
  $('#vChats').classList.toggle('hidden', view !== 'chats');
  $('#vChat').classList.toggle('hidden', view !== 'chat');
  $('#vLog').classList.toggle('hidden', view !== 'log');
  if (view === 'log') { ui.sel = null; history.replaceState(null, '', '#'); window.LogView.open(); }
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
  if (view !== 'chat') leaveSub();
  if (view === 'room') { ui.sel = null; history.replaceState(null, '', '#'); renderRoom(); }
  if (view === 'chats') { ui.sel = null; history.replaceState(null, '', '#'); renderList(); }
}

async function refresh() {
  let data;
  try { data = await api('/api/overview'); } catch { return; }
  ui.convos = data.convos;
  ui.groups = data.groups || [];
  window.Pen.overlaps = data.overlaps || [];
  notifyChanges();
  const waiting = liveOnes().filter((c) => c.live.status !== 'busy').length;
  $('#tabRoomCount').textContent = waiting ? `!${waiting}` : '';
  document.title = waiting ? `(${waiting}) Claw Hub` : 'Claw Hub';
  if (ui.view === 'room') renderRoom();
  if (ui.view === 'chats') renderList();
  if (ui.view === 'chat' && !ui.sub) { const c = cur(); if (c) renderHead(c); }
}

function notifyChanges() {
  for (const c of ui.convos) {
    const now = c.live ? c.live.status : null;
    const before = ui.lastStatus.get(c.id);
    if (before === 'busy' && now === 'idle' && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || c.id !== ui.sel)) {
      const n = new Notification('your turn', { body: c.title, icon: 'icon.svg' });
      n.onclick = () => { window.focus(); openConvo(c.id); };
    }
    ui.lastStatus.set(c.id, now);
  }
}

// ---------- room ----------
let penBuilt = false;
function renderRoom() {
  if (!penBuilt) { window.Pen.buildPen($('#pen')); penBuilt = true; }
  const live = liveOnes().filter((c) => !window.inTank || window.inTank(c));
  const parked = parkedOnes().filter((c) => !window.inTank || window.inTank(c));
  if (window.Board) window.Board.render();
  const now = Date.now();
  const busy = live.filter((c) => c.live.status === 'busy').length;
  const waiting = live.length - busy;
  setHtml($('#roomSummary'), live.length
    ? `<span class="g"><b>${waiting}</b> waiting for you</span> · <span class="p"><b>${busy}</b> working</span>${parked.length ? ` · <b>${parked.length}</b> parked` : ''}`
    : parked.length ? `<b>${parked.length}</b> parked · nothing running right now` : 'the pen is empty. start one with + new');
  window.Pen.render(live.concat(parked), now);
  const tips = window.Pen.tips(live, now);
  const btn = (t, a) => {
    if (a === 'compact') return `<button class="btn" data-tip="compact" data-id="${t.id}" title="ask it to /compact">compact</button>`;
    if (a === 'fresh') return `<button class="btn" data-tip="fresh" data-id="${t.id}" title="new chat from a short brief of this one">fresh shell</button>`;
    if (a === 'open') return `<button class="btn" data-tip="open" data-id="${t.id}">answer</button>`;
    if (a === 'close') return `<button class="btn" data-tip="close" data-id="${t.id}">close</button>`;
    return '';
  };
  // two crabs on the same job: offer to merge (you confirm first)
  const open = live.concat(parked);
  const byId = (id) => open.find((c) => c.id === id);
  const merges = (window.Pen.overlaps || []).map((o) => {
    const a = byId(o.a), b = byId(o.b);
    if (!a || !b) return null;
    // keep the one already in the hub, else the one with more history
    const keepA = (a.live && a.live.inHub) !== (b.live && b.live.inHub) ? !!(a.live && a.live.inHub) : (a.size || 0) >= (b.size || 0);
    const [keep, drop] = keepA ? [a, b] : [b, a];
    return { keep, drop, why: o.why };
  }).filter(Boolean);
  const cut = (x, n) => (x.length > n ? x.slice(0, n - 1) + '…' : x);
  const mergeHtml = merges.map((m) => `<div class="tip tip-merge"><p>two crabs on the same job${m.why ? `: ${esc(m.why)}` : ''}. merge them?</p>
    <ul class="tip-pair"><li>${esc(cut(m.keep.title, 44))}</li><li>${esc(cut(m.drop.title, 44))}</li></ul>
    <div class="tip-acts"><button class="btn" data-tip="merge" data-keep="${m.keep.id}" data-drop="${m.drop.id}">merge into the first</button><button class="btn" data-tip="keepboth" data-keep="${m.keep.id}" data-drop="${m.drop.id}">keep both</button></div></div>`).join('');
  setHtml($('#tips'), merges.length || tips.length
    ? mergeHtml + tips.map((t) => `<div class="tip tip-${t.kind}"><p>${esc(t.text)}</p>${(t.actions || []).length ? `<div class="tip-acts">${t.actions.map((a) => btn(t, a)).join('')}</div>` : ''}</div>`).join('')
    : '<p class="tip-none">all calm. nothing needs you.</p>');
  const naps = ui.convos.filter((c) => !c.live && !c.parked && !c.bot && !c.archived && !c.empty && Date.now() - c.updatedAt < 86400000).length;
  $('#napsLink').classList.toggle('hidden', !naps);
  $('#napsLink').textContent = `${naps} closed chat${naps === 1 ? '' : 's'} from today →`;
}

async function compactSession(id) {
  const c = ui.convos.find((x) => x.id === id); if (!c || !c.live) return;
  if (c.live.inHub) {
    try { await api('/api/chat/send', { id, text: '/compact' }); toast('compacting…'); } catch (e) { toast(e.message); }
    return;
  }
  try { await navigator.clipboard.writeText('/compact'); } catch { /* clipboard blocked */ }
  try { await api('/api/focus', { pid: c.live.pid }); } catch { /* not focusable */ }
  toast(`copied /compact. paste it into ${whereLabel(c.live)}`);
}

// ---------- chats list ----------
function renderFilter() {
  const sel = $('#filter');
  const opts = [['all', 'all chats'], ['running', 'running'], ['pinned', 'pinned']]
    .concat(ui.groups.map((g) => [`g:${g.id}`, `▸ ${g.name}`]))
    .concat([['filed', 'filed away'], ['auto', 'auto runs'], ['__new', '+ new project…']]);
  const html = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (sel._html !== html) { sel._html = html; sel.innerHTML = html; }
  sel.value = ui.filter;
}

function visible() {
  const q = ui.q.toLowerCase();
  const f = ui.filter;
  return ui.convos.filter((c) => {
    if (c.empty) return false;
    if (f === 'auto') { if (!c.bot) return false; } else if (c.bot) return false;
    if (f === 'filed') { if (!c.archived) return false; } else if (c.archived) return false;
    if (f === 'pinned' && !c.pinned) return false;
    if (f === 'running' && !c.live) return false;
    if (f.startsWith('g:') && c.group !== f.slice(2)) return false;
    if (q) {
      const g = groupById(c.group);
      const hay = `${c.title} ${c.autoTitle || ''} ${c.firstPrompt || ''} ${c.lastPrompt || ''} ${c.cwd || ''} ${c.note || ''} ${g ? g.name : ''}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

function dayGroup(ms) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(new Date()) - day(new Date(ms))) / 86400000;
  if (diff < 1) return 'today';
  if (diff < 2) return 'yesterday';
  if (diff < 7) return 'this week';
  if (diff < 31) return 'this month';
  return 'earlier';
}

function renderList() {
  renderFilter();
  const items = visible();
  const pinned = ui.filter === 'all' && !ui.q ? items.filter((c) => c.pinned) : [];
  const rest = items.filter((c) => !pinned.includes(c));
  const row = (c) => {
    const g = groupById(c.group);
    const r = c.live ? `<span class="r ${mood(c)}">${c.live.status === 'busy' ? 'working' : 'your turn'}</span>` : `<span class="r">${esc(ago(c.updatedAt))}</span>`;
    return `<button class="row" data-id="${c.id}">
      ${stillCritter(c)}
      <div style="min-width:0"><div class="t">${c.pinned ? '★ ' : ''}${esc(c.title)}</div>
      <div class="s">${esc(folderName(c.cwd))}${g ? ` · ▸ ${esc(g.name)}` : ''}${c.note ? ` · <span class="rnote">${esc(c.note)}</span>` : ''}</div></div>
      ${r}
    </button>`;
  };
  let html = pinned.length ? `<div class="day">pinned</div>${pinned.map(row).join('')}` : '';
  let g = null;
  for (const c of rest.slice(0, 300)) {
    const ng = dayGroup(c.updatedAt);
    if (ng !== g) { g = ng; html += `<div class="day">${g}</div>`; }
    html += row(c);
  }
  if (!items.length) html = `<div class="empty-list">${ui.q ? 'nothing matches.' : ui.filter.startsWith('g:') ? 'no chats in this project yet. open a chat, then ⋯ → project.' : 'nothing here.'}</div>`;
  const list = $('#list'); const top = $('#vChats').scrollTop;
  setHtml(list, html);
  $('#vChats').scrollTop = top;
}

// ---------- one chat ----------
function renderHead(c) {
  const m = mood(c);
  setHtml($('#chatCritter'), crab(c, m, 46));
  renderLookPicker(c);
  const h1 = $('#cTitle');
  if (document.activeElement !== h1) h1.textContent = c.title;
  const g = groupById(c.group);
  const status = c.live ? `<span class="${m}">● ${m === 'busy' ? 'working' : 'your turn'}</span> in ${esc(whereLabel(c.live))} · ` : '';
  setHtml($('#cSub'), `${status}${esc(shortPath(c.cwd))}${g ? ` · ▸ ${esc(g.name)}` : ''} · started ${esc(ago(c.createdAt))} ago`);
  const elsewhere = c.live && !c.live.inHub;
  const main = $('#aMain');
  main.classList.toggle('hidden', !elsewhere);
  main.textContent = 'jump to it';
  const note = $('#cNote');
  if (document.activeElement !== note) {
    note.textContent = c.note || '';
    note.classList.toggle('hidden', !c.note && !note._editing);
  }
  // menu items
  const menu = $('#moreMenu');
  menu.querySelector('[data-act=pin]').textContent = c.pinned ? 'unpin' : 'pin';
  menu.querySelector('[data-act=note]').textContent = c.note ? 'edit note' : 'add a note';
  menu.querySelector('[data-act=file]').textContent = c.archived ? 'unfile' : 'file away';
  menu.querySelector('[data-act=terminal]').classList.toggle('hidden', !!c.live || !!c.empty);
  menu.querySelector('[data-act=copy]').classList.toggle('hidden', !!c.empty);
  menu.querySelector('[data-act=close]').classList.toggle('hidden', !c.live);
  menu.querySelector('[data-act=enhance]').classList.toggle('hidden', !!c.empty);
  menu.querySelector('[data-act=side]').classList.toggle('hidden', !!c.empty);
  const gsel = $('#aGroup');
  const opts = `<option value="">none</option>` + ui.groups.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('') + `<option value="__new">+ new…</option>`;
  if (gsel._opts !== opts) { gsel._opts = opts; gsel.innerHTML = opts; }
  if (document.activeElement !== gsel) gsel.value = c.group || '';
  renderComposer(c);
}

// ---------- questions from hub crabs: multiple choice, plans, permissions ----------
// picks are kept per request (by its time) so a refresh doesn't lose half-picked answers
function askKey(p) { return `${ui.sel}:${p.at}`; }
function askPicks(p) {
  if (!ui.ask || ui.ask.key !== askKey(p)) ui.ask = { key: askKey(p), picks: {} };
  return ui.ask.picks;
}
function askDone(p) {
  const picks = askPicks(p);
  return p.questions.every((q, i) => picks[i] && (q.multiSelect ? picks[i].length : true));
}
function typedPick(q, pick) {
  const labels = (q.options || []).map((o) => o.label);
  const own = [].concat(pick || []).filter((x) => !labels.includes(x));
  return own.join(', ');
}
function renderAsk(c) {
  const card = $('#askCard');
  const p = c.live && c.live.inHub && c.live.pending;
  card.classList.toggle('hidden', !p);
  if (!p) { setHtml(card, ''); return; }
  let html = '';
  if (p.kind === 'ask') {
    const picks = askPicks(p);
    const quick = p.questions.length === 1 && !p.questions[0].multiSelect;
    html = p.questions.map((q, i) => {
      const on = (o) => (q.multiSelect ? (picks[i] || []).includes(o.label) : picks[i] === o.label);
      return `<div class="q">
        <div class="q-head">${esc((q.header || 'question').toLowerCase())}${q.multiSelect ? ' · pick any' : ''}</div>
        <div class="q-text">${esc(q.question)}</div>
        <div class="opts">${(q.options || []).map((o, j) => `<button type="button" class="opt ${on(o) ? 'on' : ''}" data-q="${i}" data-o="${j}">
          <span class="k">${j + 1}</span><b>${esc(o.label)}</b>${o.description ? `<span class="d">${esc(o.description)}</span>` : ''}</button>`).join('')}</div>
        ${typedPick(q, picks[i]) ? `<div class="typed">✎ ${esc(typedPick(q, picks[i]))}</div>` : ''}
      </div>`;
    }).join('');
    html += `<div class="ask-foot"><span>${quick ? 'tap one, or press its number' : 'pick for each, then send'} · or type your own answer below</span>${quick ? '' : `<button type="button" class="btn primary" data-ask="send" ${askDone(p) ? '' : 'disabled'}>send answers</button>`}</div>`;
  } else if (p.kind === 'plan') {
    html = `<div class="q"><div class="q-head">plan · wants your ok</div><div class="plan-md">${md(p.plan)}</div></div>
      <div class="ask-foot"><span>or type what to change below</span><button type="button" class="btn" data-ask="no">keep planning</button><button type="button" class="btn primary" data-ask="yes">approve</button></div>`;
  } else {
    html = `<div class="q"><div class="q-head">permission</div><div class="q-text">ok to ${esc(p.summary)}?</div></div>
      <div class="ask-foot"><span>or type why not below</span><button type="button" class="btn" data-ask="no">deny</button><button type="button" class="btn primary" data-ask="yes">allow</button></div>`;
  }
  setHtml(card, html);
}
async function sendAsk(body) {
  const c = cur(); if (!c || ui.sending) return false;
  ui.sending = true;
  let ok = false;
  try {
    await api('/api/chat/answer', { id: c.id, ...body });
    c.live.pending = null; c.live.status = 'busy'; c.live.activity = { kind: 'say', text: 'thinking…' };
    ui.ask = null;
    ok = true;
  } catch (e) { toast(e.message); }
  ui.sending = false;
  const now = cur(); if (now) renderComposer(now);
  setTimeout(loadMsgs, 400);
  return ok;
}
function pickOpt(qi, oi) {
  const c = cur(); const p = c && c.live && c.live.pending;
  if (!p || p.kind !== 'ask' || !p.questions[qi]) return;
  const q = p.questions[qi]; const o = (q.options || [])[oi]; if (!o) return;
  const picks = askPicks(p);
  if (q.multiSelect) {
    const cur2 = picks[qi] || [];
    picks[qi] = cur2.includes(o.label) ? cur2.filter((x) => x !== o.label) : [...cur2, o.label];
  } else picks[qi] = o.label;
  if (p.questions.length === 1 && !q.multiSelect) return submitPicks(p);
  renderAsk(c);
}
function submitPicks(p) {
  const picks = askPicks(p);
  const answers = {};
  p.questions.forEach((q, i) => { answers[q.question] = q.multiSelect ? (picks[i] || []).join(', ') : picks[i]; });
  return sendAsk({ answers });
}
$('#askCard').addEventListener('click', (e) => {
  const o = e.target.closest('.opt');
  if (o) return pickOpt(+o.dataset.q, +o.dataset.o);
  const b = e.target.closest('[data-ask]');
  if (!b) return;
  const c = cur(); const p = c && c.live && c.live.pending; if (!p) return;
  if (b.dataset.ask === 'send') return submitPicks(p);
  if (b.dataset.ask === 'yes') return sendAsk({ allow: true });
  const txt = $('#sendText').value.trim();
  if (b.dataset.ask === 'no' && !txt && p.kind === 'plan') { $('#sendText').focus(); toast('type what to change, then send'); return; }
  sendAsk({ allow: false, message: txt || undefined }).then((ok) => { if (ok) { $('#sendText').value = ''; autosize($('#sendText')); } });
});
// number keys pick options when you're not typing
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') || document.activeElement.isContentEditable) return;
  if (ui.view !== 'chat' || ui.sub || $('#composer').classList.contains('hidden')) return;
  const c = cur(); const p = c && c.live && c.live.inHub && c.live.pending;
  if (!p || p.kind !== 'ask' || $('#askCard').classList.contains('hidden')) return;
  const picks = askPicks(p);
  let qi = p.questions.findIndex((q, i) => !picks[i]);
  if (qi < 0) qi = p.questions.length - 1;
  e.preventDefault();
  pickOpt(qi, +e.key - 1);
});

function renderComposer(c) {
  renderAsk(c);
  const live = c.live;
  const elsewhere = live && !live.inHub;
  const busy = live && live.inHub && live.status === 'busy';
  const sl = $('#working');
  sl.classList.toggle('hidden', !busy && !elsewhere);
  sl.classList.toggle('idle', !!elsewhere && live.status !== 'busy');
  if (busy) setHtml(sl, `&gt; ${esc(activityText(live))} <span class="caret">▌</span>`);
  else if (elsewhere) setHtml(sl, `open in ${esc(whereLabel(live))}, reply there <button class="btn" id="takeOver" title="close it there and keep going here">move it here</button>`);
  $('#sendForm').classList.toggle('hidden', !!elsewhere);
  const ta = $('#sendText');
  ta.placeholder = live && live.inHub ? 'message claude…' : 'continue this chat here…';
  // claude reads new messages mid-turn and picks them up at its next step,
  // so a busy chat still takes messages (it used to lock the button for the whole turn)
  const asked = live && live.inHub && live.pending;
  ta.placeholder = asked ? (asked.kind === 'ask' ? 'or type your own answer…' : asked.kind === 'plan' ? 'what should change?' : 'why not?') : ta.placeholder;
  $('#sendBtn').textContent = !(live && live.inHub) ? 'continue' : asked ? 'answer' : busy ? 'queue' : 'send';
  $('#sendBtn').title = busy ? 'claude is working. it reads this at its next step.' : '';
  $('#sendBtn').disabled = ui.sending;
}

function toolGroupHtml(tools) {
  const names = [...new Set(tools.map((t) => t.name.toLowerCase()))].slice(0, 4).join(', ');
  return `<details class="tools"><summary>${tools.length} step${tools.length > 1 ? 's' : ''} · ${esc(names)}</summary>
    ${tools.map((t) => `<div class="tool ${t.error ? 'err' : ''}"><b>${esc(t.name.toLowerCase())}</b> ${esc(t.summary)}${t.result ? `<pre>${esc(t.result)}</pre>` : ''}</div>`).join('')}
  </details>`;
}

function renderMsgs(data) {
  const box = $('#msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  let html = data.start > 0 ? `<button class="btn more-msgs" id="loadMore">show earlier</button>` : '';
  let tools = [];
  let lastTs = 0;
  const flush = () => { if (tools.length) { html += toolGroupHtml(tools); tools = []; } };
  for (const it of data.items) {
    if (it.ts && it.ts - lastTs > 30 * 60 * 1000) {
      flush();
      html += `<div class="time">${new Date(it.ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toLowerCase()}</div>`;
    }
    if (it.ts) lastTs = it.ts;
    if (it.kind === 'tool') { tools.push(it); continue; }
    flush();
    if (it.kind === 'user') html += `<div class="msg user">${esc(it.text)}</div>`;
    else if (it.kind === 'assistant') html += `<div class="msg assistant">${md(it.text)}</div>`;
    else if (it.kind === 'command') html += `<div class="msg command">${esc(it.text)}</div>`;
    else if (it.kind === 'note') html += `<div class="msg note-line">— ${esc(it.text.toLowerCase())} —</div>`;
  }
  flush();
  if (!data.items.length) html = '<div class="msg note-line">starting up…</div>';
  if (box._html === html) return;
  const openIdx = [...box.querySelectorAll('details.tools')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0);
  box._html = html;
  box.innerHTML = html;
  const ds = box.querySelectorAll('details.tools');
  for (const i of openIdx) if (ds[i]) ds[i].open = true;
  if (nearBottom || box._first) { box.scrollTop = box.scrollHeight; box._first = false; }
  const more = $('#loadMore');
  if (more) more.onclick = () => { ui.limit += 500; loadMsgs(); };
}

// read-only view of a baby crab's (subagent's) transcript
function openSub(key) {
  const [sid, aid] = key.split('/');
  const mom = ui.convos.find((x) => x.id === sid);
  ui.sel = sid; ui.sub = aid; ui.limit = 250;
  show('chat');
  const h = ((mom && ((mom.live && mom.live.helpers) || (mom.parked && mom.parked.helpers))) || []).find((x) => x.id === aid) || {};
  setHtml($('#chatCritter'), crab(mom || { id: sid }, h.status === 'stuck' ? 'tired' : 'read', 30));
  $('#cTitle').textContent = h.description || 'baby crab';
  $('#cTitle').contentEditable = 'false';
  setHtml($('#cSub'), `baby of <b>${esc(mom ? mom.title : 'a session')}</b> · ${esc(h.type || 'subagent')} · ${esc(h.status === 'stuck' ? 'stuck' : h.status === 'done' ? 'done' : 'working')}`);
  ['#aMain', '.more', '#cNote', '#composer'].forEach((q) => $(q).classList.add('hidden'));
  const box = $('#msgs'); box._html = ''; box._first = true;
  box.innerHTML = '<div class="msg note-line">loading…</div>';
  loadMsgs();
}
function leaveSub() {
  if (!ui.sub) return;
  ui.sub = null;
  $('#cTitle').contentEditable = 'true';
  ['.more', '#composer'].forEach((q) => $(q).classList.remove('hidden'));
}

async function loadMsgs() {
  if (!ui.sel) return;
  const id = ui.sel;
  const sub = ui.sub;
  try {
    const data = await api(sub ? `/api/sub/${id}/${sub}?limit=${ui.limit}` : `/api/convo/${id}?limit=${ui.limit}`);
    if (ui.sel === id && ui.sub === sub) renderMsgs(data);
  } catch (e) {
    if (ui.sel === id) {
      const c = cur();
      $('#msgs').innerHTML = c && c.live ? '<div class="msg note-line">starting up…</div>' : `<div class="msg note-line">couldn't read this chat: ${esc(e.message)}</div>`;
    }
  }
}

function openConvo(id) {
  const c = ui.convos.find((x) => x.id === id);
  if (!c) return;
  leaveSub();
  ui.sel = id; ui.limit = 250;
  show('chat');
  const box = $('#msgs'); box._html = ''; box._first = true;
  box.innerHTML = '<div class="msg note-line">loading…</div>';
  $('#cNote')._editing = false;
  $('#moreMenu').classList.add('hidden');
  renderHead(c);
  history.replaceState(null, '', `#${id}`);
  if (!c.empty) loadMsgs(); else box.innerHTML = '<div class="msg note-line">nothing typed yet</div>';
}

async function setState(patch, id = ui.sel) {
  const c = ui.convos.find((x) => x.id === id); if (!c) return;
  Object.assign(c, patch);
  if ('label' in patch) c.title = patch.label || c.autoTitle || (c.firstPrompt || '').slice(0, 80) || 'untitled';
  if (c.id === ui.sel) renderHead(c);
  try { await api('/api/state', { id: c.id, ...patch }); } catch (e) { toast(e.message); }
}

async function newGroup() {
  const name = (prompt('name the project (like portfolio, school, roblox):') || '').trim();
  if (!name) return null;
  const r = await api('/api/groups', { action: 'create', name });
  ui.groups.push(r.group);
  return r.group;
}

async function closeSession(id) {
  const c = ui.convos.find((x) => x.id === id);
  if (!c || !c.live) return;
  const warn = c.live.status === 'busy' ? '\n\nit is still working. whatever it is doing stops.' : '';
  if (!confirm(`close "${c.title}"?\n\nthe chat stays saved and you can continue it later.${warn}`)) return;
  try { await api('/api/stop', { id }); toast('closed. still saved.'); setTimeout(refresh, 600); } catch (e) { toast(e.message); }
}

async function mergeCrabs(keepId, dropId) {
  const keep = ui.convos.find((x) => x.id === keepId), drop = ui.convos.find((x) => x.id === dropId);
  if (!keep || !drop) return;
  const moves = keep.live && !keep.live.inHub ? `\n\n"${keep.title}" is open in ${whereLabel(keep.live)}. it closes there and keeps going here in claw hub.` : '';
  if (!confirm(`merge "${drop.title}" into "${keep.title}"?\n\n"${keep.title}" gets a summary of everything "${drop.title}" was asked, where it left off, and which files it edited.\n\n"${drop.title}" then closes and gets filed away. it stays saved in chats.${moves}`)) return;
  toast('merging…');
  try { const r = await api('/api/merge', { keep: keepId, drop: dropId }); toast('merged. it\'s reading the other crab\'s notes.'); await refresh(); openConvo(r.id); } catch (e) { toast(e.message); }
}

// ---------- crab look picker ----------
const HUES = [0, 18, 36, 54, 90, 130, 165, 190, 210, 235, 260, 285, 310, 335];
function lookHtml(c) {
  const l = lookFor(c);
  const custom = Number.isInteger(c.hue);
  return `<div class="look-h">crab color</div>
    <div class="swatches">${HUES.map((h) => `<button type="button" class="sw-btn ${custom && c.hue === h ? 'on' : ''}" data-hue="${h}" style="background:hsl(${h} 80% 66%)" title="hue ${h}"></button>`).join('')}
    <button type="button" class="sw-btn auto ${custom ? '' : 'on'}" data-hue="auto" title="automatic (from its folder)">A</button></div>
    <div class="look-h">shell</div>
    <div class="shells">${SHELLS.map((s) => `<button type="button" class="sh-btn ${l.shell === s ? 'on' : ''}" data-shell="${s}" title="${s}">${emptyShell(s, l.hue, 2)}</button>`).join('')}</div>`;
}
function renderLookPicker(c) {
  const box = document.querySelector('#moreMenu [data-look]');
  if (box) setHtml(box, lookHtml(c));
}
let lookTarget = null;
function openLookPop(id, x, y) {
  const c = ui.convos.find((v) => v.id === id); if (!c) return;
  lookTarget = id;
  const pop = $('#lookPop');
  $('#lookPopTitle').textContent = c.title;
  setHtml(pop.querySelector('[data-look]'), lookHtml(c));
  pop.classList.remove('hidden');
  pop.style.left = Math.min(x, innerWidth - 230) + 'px';
  pop.style.top = Math.min(y, innerHeight - 200) + 'px';
}
function closeLookPop() { $('#lookPop').classList.add('hidden'); lookTarget = null; }
document.addEventListener('click', (e) => {
  const sw = e.target.closest('[data-hue], [data-shell]');
  if (!sw) { if (!e.target.closest('#lookPop')) closeLookPop(); return; }
  e.stopPropagation();
  const id = sw.closest('#lookPop') ? lookTarget : ui.sel;
  const c = ui.convos.find((v) => v.id === id); if (!c) return;
  const patch = sw.dataset.shell ? { shell: sw.dataset.shell } : { hue: sw.dataset.hue === 'auto' ? null : Number(sw.dataset.hue) };
  setState(patch, id);
  if (sw.closest('#lookPop')) setHtml($('#lookPop [data-look]'), lookHtml(c));
  if (ui.view === 'room') renderRoom();
}, true);
document.addEventListener('contextmenu', (e) => {
  const cr = e.target.closest('.crab:not(.baby)');
  if (!cr) return;
  e.preventDefault();
  openLookPop(cr.dataset.id, e.clientX, e.clientY);
});

// ---------- sending ----------
function autosize(el) { el.style.height = 'auto'; el.style.height = Math.min(220, el.scrollHeight) + 'px'; }

// typed text while a multiple-choice card is open: fills the first question you haven't picked yet
function typedAnswer(p, text) {
  const picks = askPicks(p);
  let i = p.questions.findIndex((q, k) => !(picks[k] && (q.multiSelect ? picks[k].length : true)));
  if (i < 0) i = p.questions.length - 1;
  picks[i] = p.questions[i].multiSelect ? [text] : text;
  if (askDone(p)) return submitPicks(p);
  renderAsk(cur());
  toast('got it. pick the rest, then send');
  return Promise.resolve(true);
}

async function sendMessage() {
  const c = cur(); if (!c) return;
  const box = $('#sendText');
  const text = box.value.trim();
  const asked = c.live && c.live.inHub && c.live.pending;
  if (asked && asked.kind === 'ask' && text && asked.questions.length > 1) {
    if (await typedAnswer(asked, text)) { box.value = ''; autosize(box); }
    return;
  }
  if ((!text && !ui.att.send.length) || ui.sending) return;
  let images;
  try { images = takeImages('send'); } catch (e) { toast(e.message); return; }
  ui.sending = true; renderComposer(c);
  try {
    if (c.live && c.live.inHub) {
      const wasBusy = c.live.status === 'busy';
      await api('/api/chat/send', { id: c.id, text, images, asAnswer: !!asked });
      if (wasBusy) toast('queued. claude reads it at its next step.');
      c.live.status = 'busy'; c.live.activity = { kind: 'say', text: 'thinking…' };
    } else {
      toast('waking claude up…');
      const r = await api('/api/chat/start', { resumeId: c.id, prompt: text, images });
      await refresh();
      if (r.id !== c.id) openConvo(r.id);
    }
    box.value = ''; autosize(box); clearAtt('send');
    setTimeout(loadMsgs, 400);
  } catch (e) { toast(e.message); }
  ui.sending = false;
  const now = cur(); if (now) renderComposer(now);
}

// ---------- enhance with a skill ----------
const enh = $('#enhDlg');
async function openEnhance() {
  const c = cur(); if (!c) return;
  $('#moreMenu').classList.add('hidden');
  ui.enhSkill = null;
  clearAtt('enh');
  $('#skillQ').value = ''; $('#enhNext').value = ''; $('#enhTerminal').checked = false;
  $('#enhBrief').value = 'loading…';
  enh.showModal();
  $('#skillQ').focus();
  try {
    const [s, b] = await Promise.all([ui.skills ? { skills: ui.skills } : api('/api/skills'), api(`/api/brief/${c.id}`)]);
    ui.skills = s.skills;
    $('#enhBrief').value = b.brief;
  } catch (e) { toast(e.message); }
  renderSkills(); updateTok();
}
function renderSkills() {
  const q = $('#skillQ').value.toLowerCase().trim();
  const list = (ui.skills || []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)).slice(0, 80);
  $('#skillList').innerHTML = list.map((s) => `<button type="button" class="skill ${ui.enhSkill === s.name ? 'on' : ''}" data-skill="${esc(s.name)}"><b>/${esc(s.name)}</b><span class="k">${s.kind}</span><span class="d">${esc(s.description)}</span></button>`).join('')
    || '<div class="empty-list" style="padding:12px">no skill matches.</div>';
}
function enhPrompt() {
  const next = $('#enhNext').value.trim();
  const body = `${$('#enhBrief').value.trim()}${next ? `\nnext: ${next}` : '\nnext: continue + improve'}`;
  return ui.enhSkill ? `/${ui.enhSkill} ${body}` : body;
}
function updateTok() { $('#enhTok').textContent = `~${Math.ceil(enhPrompt().length / 4)} tokens${ui.enhSkill ? ` · /${ui.enhSkill}` : ' · no skill picked'}`; }
$('#skillQ').addEventListener('input', renderSkills);
$('#enhBrief').addEventListener('input', updateTok);
$('#enhNext').addEventListener('input', updateTok);
$('#skillList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-skill]'); if (!b) return;
  ui.enhSkill = ui.enhSkill === b.dataset.skill ? null : b.dataset.skill;
  renderSkills(); updateTok();
});
$('#enhForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'go') return;
  e.preventDefault();
  const c = cur(); if (!c) return;
  if (!ui.enhSkill && !confirm('no skill picked. start a plain chat with the brief?')) return;
  const prompt = enhPrompt();
  let images;
  try { images = takeImages('enh'); } catch (err) { toast(err.message); return; }
  $('#enhGo').disabled = true;
  try {
    if ($('#enhTerminal').checked) {
      await api('/api/new', { cwd: c.cwd, prompt, images });
      enh.close(); toast('opening a terminal…'); setTimeout(refresh, 3000);
    } else {
      toast('starting…');
      const r = await api('/api/chat/start', { cwd: c.cwd, prompt, group: c.group || '', images });
      enh.close();
      await refresh();
      openConvo(r.id);
    }
  } catch (err) { toast(err.message); } finally { $('#enhGo').disabled = false; }
});

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { show(go.dataset.go); return; }
  const tip = e.target.closest('[data-tip]');
  if (tip) {
    const id = tip.dataset.id;
    if (tip.dataset.tip === 'compact') compactSession(id);
    if (tip.dataset.tip === 'fresh') { openConvo(id); openEnhance(); }
    if (tip.dataset.tip === 'open') openConvo(id);
    if (tip.dataset.tip === 'close') closeSession(id);
    if (tip.dataset.tip === 'merge') mergeCrabs(tip.dataset.keep, tip.dataset.drop);
    if (tip.dataset.tip === 'keepboth') {
      try { await api('/api/merge/dismiss', { a: tip.dataset.keep, b: tip.dataset.drop }); toast('ok, keeping both. won\'t ask again.'); refresh(); } catch (err) { toast(err.message); }
    }
    return;
  }
  const baby = e.target.closest('.crab.baby');
  if (baby) { openSub(baby.dataset.sub); return; }
  const r = e.target.closest('.crab, .row');
  if (r) { openConvo(r.dataset.id); return; }
  if (e.target.id === 'napsLink') { show('chats'); return; }
  if (e.target.id === 'takeOver') {
    const c = cur(); if (!c || !c.live) return;
    if (!confirm(`close "${c.title}" in ${whereLabel(c.live)} so you can keep going here?`)) return;
    try { await api('/api/stop', { id: c.id }); toast('moved. type below.'); setTimeout(refresh, 600); } catch (err) { toast(err.message); }
    return;
  }
  const menu = $('#moreMenu');
  if (e.target.id === 'moreBtn') { menu.classList.toggle('hidden'); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const c = cur(); if (!c) return;
    const a = act.dataset.act;
    if (a !== 'enhance') menu.classList.add('hidden');
    if (a === 'enhance') openEnhance();
    if (a === 'side') startSide(c);
    if (a === 'pin') setState({ pinned: !c.pinned });
    if (a === 'file') { setState({ archived: !c.archived }); toast(c.archived ? 'filed away' : 'back in your chats'); }
    if (a === 'close') closeSession(c.id);
    if (a === 'note') { const n = $('#cNote'); n._editing = true; n.classList.remove('hidden'); n.focus(); }
    if (a === 'copy') {
      const cmd = `cd ${JSON.stringify(c.cwd || '~')} && claude --resume ${c.id}`;
      try { await navigator.clipboard.writeText(cmd); toast('copied'); } catch { prompt('copy this:', cmd); }
    }
    if (a === 'terminal') {
      try { await api('/api/resume', { id: c.id }); toast('opening in terminal…'); setTimeout(refresh, 2500); } catch (err) { toast(err.message); }
    }
    return;
  }
  if (!e.target.closest('.more')) menu.classList.add('hidden');
});

// side chat: copy this chat's whole context into a second crab that does another task
async function startSide(c) {
  const task = prompt(`side chat off "${c.title}"\nsame history, same folder and files. the original keeps going.\n\nwhat should the side chat do?`);
  if (!task || !task.trim()) return;
  toast('copying the chat into a side crab…');
  try {
    const r = await api('/api/chat/side', { id: c.id, prompt: task.trim() });
    await refresh();
    openConvo(r.id);
    toast('side chat started');
  } catch (err) { toast(err.message); }
}

$('#aMain').onclick = async () => {
  const c = cur(); if (!c || !c.live) return;
  try { const r = await api('/api/focus', { pid: c.live.pid }); toast(r.how === 'terminal' ? 'switched to its terminal tab' : `opened ${whereLabel(c.live)}`); } catch (e) { toast(e.message); }
};
$('#back').onclick = () => show(ui.prevView);
$('#aGroup').addEventListener('change', async (e) => {
  let v = e.target.value;
  if (v === '__new') { const g = await newGroup(); v = g ? g.id : (cur().group || ''); }
  setState({ group: v });
});
$('#filter').addEventListener('change', async (e) => {
  if (e.target.value === '__new') {
    const g = await newGroup();
    ui.filter = g ? `g:${g.id}` : ui.filter;
  } else ui.filter = e.target.value;
  renderList();
});
$('#q').addEventListener('input', (e) => { ui.q = e.target.value.trim(); renderList(); });

const h1 = $('#cTitle');
h1.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); h1.blur(); } if (e.key === 'Escape') { h1.textContent = cur().title; h1.blur(); } });
h1.addEventListener('blur', () => {
  const c = cur(); if (!c) return;
  const v = h1.textContent.trim();
  if (v === c.title) return;
  setState({ label: v === (c.autoTitle || '') ? '' : v });
});
const noteEl = $('#cNote');
noteEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); noteEl.blur(); } });
noteEl.addEventListener('blur', () => {
  noteEl._editing = false;
  const c = cur(); if (!c) return;
  const v = noteEl.textContent.trim();
  if (v !== (c.note || '')) setState({ note: v }); else renderHead(c);
});

const sendBox = $('#sendText');
sendBox.addEventListener('input', () => autosize(sendBox));
sendBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
$('#sendForm').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });

// new chat
const dlg = $('#newDlg');
$('#newBtn').onclick = () => {
  const c = cur();
  const counts = new Map();
  for (const x of ui.convos) if (!x.bot && x.cwd) counts.set(x.cwd, (counts.get(x.cwd) || 0) + 1);
  $('#cwdList').innerHTML = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([p]) => `<option value="${esc(shortPath(p))}">`).join('');
  $('#newCwd').value = c && c.cwd && !c.bot ? shortPath(c.cwd) : '~';
  $('#newGroup').innerHTML = `<option value="">none</option>` + ui.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  $('#newGroup').value = (c && c.group) || (ui.filter.startsWith('g:') ? ui.filter.slice(2) : '');
  $('#newPrompt').value = '';
  $('#newSkill').value = '';
  $('#newBrief').value = '';
  $('#newBriefWrap').classList.add('hidden');
  const recent = ui.convos.filter((x) => !x.bot && !x.empty && !x.archived).slice(0, 40);
  $('#newImport').innerHTML = '<option value="">none</option>' + recent.map((x) => `<option value="${x.id}">${esc(x.title.slice(0, 60))}</option>`).join('');
  (ui.skills ? Promise.resolve({ skills: ui.skills }) : api('/api/skills')).then((r) => {
    ui.skills = r.skills;
    $('#newSkillList').innerHTML = r.skills.map((k) => `<option value="${esc(k.name)}">${esc(k.description.slice(0, 80))}</option>`).join('');
  }).catch(() => {});
  clearAtt('new');
  dlg.showModal(); $('#newPrompt').focus();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
};
$('#newImport').addEventListener('change', async (e) => {
  const id = e.target.value;
  const wrap = $('#newBriefWrap');
  if (!id) { wrap.classList.add('hidden'); $('#newBrief').value = ''; return; }
  wrap.classList.remove('hidden');
  $('#newBrief').value = 'loading…';
  try {
    const r = await api(`/api/brief/${id}`);
    $('#newBrief').value = r.brief;
    if (r.cwd) $('#newCwd').value = shortPath(r.cwd);
  } catch (err) { $('#newBrief').value = ''; toast(err.message); }
});

// skill + imported brief + your message, in the terse form
function composeNew() {
  const skill = $('#newSkill').value.trim().replace(/^\//, '');
  const brief = $('#newBriefWrap').classList.contains('hidden') ? '' : $('#newBrief').value.trim();
  const msg = $('#newPrompt').value.trim();
  let body = brief ? `${brief}\nnext: ${msg || 'continue + improve'}` : msg;
  if (skill) body = `/${skill}${body ? ' ' + body : ''}`;
  return body;
}

$('#newForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value !== 'go') return;
  e.preventDefault();
  const cwd = $('#newCwd').value.trim() || '~';
  const skillName = $('#newSkill').value.trim().replace(/^\//, '');
  if (skillName && ui.skills && !ui.skills.some((k) => k.name === skillName)) { toast(`no skill called /${skillName}`); return; }
  const promptText = composeNew();
  const group = $('#newGroup').value;
  let images;
  try { images = takeImages('new'); } catch (err) { toast(err.message); return; }
  try {
    if ($('#newInTerminal').checked) {
      await api('/api/new', { cwd, prompt: promptText, images });
      dlg.close(); toast('opening a terminal…'); setTimeout(refresh, 3000);
      return;
    }
    if (!promptText && !images.length) { toast('type a first message'); return; }
    $('#newGo').disabled = true; toast('starting…');
    const r = await api('/api/chat/start', { cwd, prompt: promptText, group, images });
    dlg.close();
    await refresh();
    openConvo(r.id);
  } catch (err) { toast(err.message); } finally { $('#newGo').disabled = false; }
});
$('#newPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#newGo').click(); });

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  const modal = dlg.open || enh.open;
  if (e.key === '/' && !typing && !modal) { e.preventDefault(); show('chats'); $('#q').focus(); }
  if (e.key === 'n' && !typing && !modal) { e.preventDefault(); $('#newBtn').click(); }
  if (e.key === 'Escape' && !typing && !modal) {
    if (!$('#moreMenu').classList.contains('hidden')) $('#moreMenu').classList.add('hidden');
    else if (ui.view === 'chat') show(ui.prevView);
    else if (ui.view === 'chats') show('room');
  }
  if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; ui.q = ''; renderList(); $('#q').blur(); }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && ui.view === 'chats' && !modal) {
    const rows = [...document.querySelectorAll('#list .row')];
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus(); next.scrollIntoView({ block: 'nearest' });
  }
});
document.addEventListener('click', () => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== ui.sel && ui.convos.some((c) => c.id === id)) openConvo(id);
});

// ---------- loop ----------
(async () => {
  await refresh();
  const fromHash = location.hash.slice(1);
  if (fromHash && ui.convos.some((c) => c.id === fromHash)) openConvo(fromHash);
  else show('room');
  setInterval(refresh, 2500);
  setInterval(() => { const c = cur(); if (ui.view === 'chat' && c && (c.live || ui.sub) && !document.hidden) loadMsgs(); }, 1500);
})();

// ---------- image attachments (composer, new chat, enhance) ----------
ui.att = { send: [], new: [], enh: [] };
function attBox(k) { return document.querySelector(`.att[data-att="${k}"]`); }
function renderAtt(k) {
  attBox(k).querySelector('.thumbs').innerHTML = ui.att[k].map((a, i) => `<div class="thumb ${a.path ? '' : 'loading'}" title="${esc(a.name)}"><img src="${a.url}" alt=""><button type="button" data-rm="${k}:${i}" title="remove">×</button></div>`).join('');
}
function readAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function addImages(k, files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast('only png, jpg, gif or webp'); continue; }
    const a = { name: f.name || 'pasted', url: URL.createObjectURL(f), path: null };
    ui.att[k].push(a); renderAtt(k);
    try { a.path = (await api('/api/upload', { name: a.name, dataUrl: await readAsDataUrl(f) })).path; }
    catch (e) { toast(e.message); ui.att[k] = ui.att[k].filter((x) => x !== a); }
    renderAtt(k);
  }
}
function takeImages(k) {
  if (ui.att[k].some((a) => !a.path)) throw new Error('images still uploading');
  const paths = ui.att[k].map((a) => a.path);
  return paths;
}
function clearAtt(k) { ui.att[k].forEach((a) => URL.revokeObjectURL(a.url)); ui.att[k] = []; renderAtt(k); }

document.querySelectorAll('.att').forEach((box) => {
  const k = box.dataset.att;
  const input = box.querySelector('input[type=file]');
  box.querySelector('.att-btn').onclick = () => input.click();
  input.onchange = () => { addImages(k, [...input.files]); input.value = ''; };
});
document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]'); if (!rm) return;
  const [k, i] = rm.dataset.rm.split(':');
  const [a] = ui.att[k].splice(Number(i), 1);
  if (a) URL.revokeObjectURL(a.url);
  renderAtt(k);
});
// paste images into any text box of that area
const pasteMap = [['#sendText', 'send'], ['#newPrompt', 'new'], ['#enhBrief', 'enh'], ['#enhNext', 'enh']];
for (const [sel, k] of pasteMap) {
  $(sel).addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(k, files); }
  });
}
// drag and drop: composer -> send, open dialog -> its own
function dropTarget(e) {
  if (dlg.open) return 'new';
  if (enh.open) return 'enh';
  if (ui.view === 'chat' && !$('#sendForm').classList.contains('hidden')) return 'send';
  return null;
}
document.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  const k = dropTarget(e); if (!k) return;
  e.preventDefault();
  (k === 'send' ? $('#composer') : (k === 'new' ? dlg : enh)).classList.add('drop-on');
});
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, () => document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'))));
document.addEventListener('drop', (e) => {
  const k = dropTarget(e);
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!k || !files.length) return;
  e.preventDefault();
  addImages(k, files);
});
