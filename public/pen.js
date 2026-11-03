// The playpen: every live session is a critter that goes to the spot that matches what it's doing.
(function () {
  const { pixelCritter, hueFor, prop, emptyShell, SHELLS, lookFor, crab, topCritter } = window.Critter;

  const READ_TOOLS = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead)$/;
  const ASLEEP_AFTER = 20 * 60 * 1000;

  const VERBS = { Edit: 'editing', Write: 'writing', MultiEdit: 'editing', NotebookEdit: 'editing', Bash: 'running', Read: 'reading',
    Grep: 'searching for', Glob: 'looking for', LS: 'looking in', WebFetch: 'reading', WebSearch: 'looking up', Agent: 'sending a baby to', Task: 'sending a baby to',
    Skill: 'using skill', TodoWrite: 'planning', AskUserQuestion: 'asking you', ExitPlanMode: 'showing you a plan' };
  function short(t, n = 46) { t = String(t || '').replace(/\s+/g, ' ').trim(); t = t.replace(/^\/Users\/[^/]+/, '~'); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function base(p) { return /^[~\/]/.test(p) && !/\s/.test(p) ? p.split('/').pop() : p; }
  function sayFor(c, st) {
    const a = (c.live && c.live.activity) || {};
    if (c.live.parked) return `parked in ${c.live.where}. send me a message to wake me up`;
    if (st.pose === 'tired') return `out of juice. back ${a.limit && a.limit.at ? 'at ' + a.limit.at : 'later'}`;
    if (st.zone === 'gate') return a.kind === 'tool' ? 'i have a question for you' : `"${short(a.text, 60)}"`;
    if (st.pose === 'nap') return 'zzz… your turn whenever';
    if (c.live.status === 'busy') {
      if (a.kind === 'tool') return `${VERBS[a.tool] || a.tool.toLowerCase()} ${short(base(a.text))}`.trim();
      return a.text && a.text !== 'thinking…' ? `"${short(a.text, 60)}"` : 'thinking…';
    }
    if (st.pose === 'full') return `stuffed, ${st.pct}% full. compact me?`;
    return a.text ? `done: "${short(a.text, 50)}"` : 'your turn';
  }

  // Decide what a session's critter is doing.
  function stateOf(c, now) {
    const l = c.live;
    const a = l.activity || {};
    const s = { pose: 'idle', zone: 'play', label: '', fx: null, pct: a.ctxPct || null, limit: a.limit || null };
    if (l.parked) return { ...s, pose: 'nap', zone: 'bed', fx: 'zz', label: `parked in ${l.where}` };
    if (a.limit) return { ...s, pose: 'tired', zone: 'bed', fx: 'limit', label: `limit · back ${a.limit.at || 'later'}` };
    if (l.status === 'busy') {
      if (a.kind === 'tool' && READ_TOOLS.test(a.tool)) return { ...s, pose: 'read', zone: 'library', label: a.text };
      if (a.kind === 'tool' && /^(Agent|Task)$/.test(a.tool)) return { ...s, pose: 'type', zone: 'desk', fx: 'boss', label: a.text };
      if (a.kind === 'tool' && a.tool === 'Bash') return { ...s, pose: s.pct >= 85 ? 'full' : 'type', zone: 'desk', fx: 'bash', label: a.text };
      if (a.kind === 'tool') return { ...s, pose: s.pct >= 85 ? 'full' : 'type', zone: 'desk', fx: 'code', label: a.text };
      return { ...s, pose: 'think', zone: 'desk', fx: 'think', label: 'thinking' };
    }
    if (a.asking) return { ...s, pose: 'ask', zone: 'gate', fx: 'ask', label: 'has a question' };
    if (now - (l.statusSince || now) > ASLEEP_AFTER) return { ...s, pose: 'nap', zone: 'bed', fx: 'zz', label: 'asleep · your turn' };
    if (s.pct >= 85) return { ...s, pose: 'full', zone: 'play', fx: 'full', label: 'your turn · stuffed' };
    return { ...s, pose: 'idle', zone: 'play', label: 'your turn' };
  }

  // ---------- places ----------
  // The pen has an overview map (seen from the top) and one room page per place.
  const ROOMS = [
    { id: 'desk', name: 'office', blurb: 'working', box: [3, 5, 47, 47] },
    { id: 'library', name: 'library', blurb: 'reading', box: [53, 5, 97, 47] },
    { id: 'gate', name: 'front door', blurb: 'asking you', box: [3, 53, 29, 95] },
    { id: 'play', name: 'lounge', blurb: 'your turn', box: [33, 53, 67, 95] },
    { id: 'bed', name: 'shell beach', blurb: 'asleep · parked', box: [71, 53, 97, 95] },
  ];
  const roomById = (id) => ROOMS.find((r) => r.id === id);
  let PLAY = { x0: 12, x1: 88, y0: 40, y1: 90 };

  let room = null; // null = the map
  try { const r = localStorage.getItem('clawhub.room'); if (roomById(r)) room = r; } catch { /* private mode */ }
  let last = null; // last render args, to redraw right away when you switch rooms

  // where crabs stand on a room page (x = center, y = feet, in % of the pen)
  function slotsFor(id, n) {
    const out = [];
    const grid = (cols, x0, dx, y0, dy) => { for (let i = 0; i < n; i++) out.push([x0 + (i % cols) * dx, y0 + Math.floor(i / cols) * dy]); };
    if (id === 'desk') { const cols = n <= 4 ? 2 : n <= 9 ? 3 : 4; grid(cols, 50 - (cols - 1) * 12 + 4, 24, 36, n > cols * 2 ? 22 : 28); }
    else if (id === 'library') grid(4, 15, 23, 50, 22);
    else if (id === 'gate') { for (let i = 0; i < n; i++) { const k = Math.ceil(i / 2) * (i % 2 ? -1 : 1); out.push([50 + k * 13, 92 - Math.floor(i / 7) * 20]); } }
    else if (id === 'bed') grid(5, 14, 18, 46, 22);
    return out.map(([x, y]) => [Math.max(6, Math.min(94, x)), Math.max(24, Math.min(97, y))]);
  }

  const crabs = new Map(); // id -> { el, x, y, zone, pose, facing, movingUntil } (only crabs in the open room)
  let penEl = null;

  function scale() { return Math.max(3, Math.min(6, Math.round(penEl.clientWidth / 175))); }

  function buildPen(el) {
    penEl = el;
    el.innerHTML = `
      <div class="pen-map"></div>
      <div class="pen-scene">
        <div class="pen-floor"></div>
        <div class="room-bar"><button class="btn room-back" data-room-back>← all rooms</button><span class="room-name"></span></div>
        <div class="pen-gate"><span>you</span></div>
        <div class="props"></div>
        <div class="crabs"></div>
      </div>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-room-back]')) { setRoom(null); return; }
      const mc = e.target.closest('.mapcrab');
      if (mc) { if (window.openConvo) window.openConvo(mc.dataset.id); return; }
      const tile = e.target.closest('.mroom');
      if (tile) setRoom(tile.dataset.room);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && room && !el.closest('.hidden') && !e.target.closest('input, textarea, [contenteditable="true"]')) setRoom(null);
    });
    // hover (or tab to) a crab: a card that says what it's for
    const card = document.createElement('div');
    card.className = 'crab-card hidden';
    card.setAttribute('role', 'tooltip');
    document.body.appendChild(card);
    const crabEl = (t) => t.closest && (t.closest('.mapcrab') || t.closest('.crab:not(.baby)'));
    const show = (e) => {
      const t = crabEl(e.target);
      if (!t || !last) return;
      const conv = last[0].find((c) => c.id === t.dataset.id);
      if (!conv) return;
      card.innerHTML = cardHtml(conv, last[1]);
      card.classList.remove('hidden');
      const r = t.getBoundingClientRect();
      const w = card.offsetWidth, h = card.offsetHeight;
      let x = r.left + r.width / 2 - w / 2, y = r.top - h - 10;
      if (y < 8) y = r.bottom + 10;
      x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
      card.style.left = x + 'px'; card.style.top = y + 'px';
    };
    const hide = (e) => { if (!e.relatedTarget || crabEl(e.relatedTarget) !== crabEl(e.target)) card.classList.add('hidden'); };
    el.addEventListener('mouseover', show);
    el.addEventListener('mouseout', hide);
    el.addEventListener('focusin', show);
    el.addEventListener('focusout', () => card.classList.add('hidden'));
    el.addEventListener('click', () => card.classList.add('hidden'));
    window.addEventListener('resize', () => { penEl._propsKey = ''; if (last) render(...last); for (const c of crabs.values()) place(c); });
  }

  function setRoom(id) {
    room = id;
    try { if (id) localStorage.setItem('clawhub.room', id); else localStorage.removeItem('clawhub.room'); } catch { /* fine */ }
    // leaving or switching: crabs on screen go away, the new room's crabs walk in from the door
    for (const c of crabs.values()) c.el.remove();
    crabs.clear();
    for (const b of babies.values()) b.el.remove();
    babies.clear();
    penEl._propsKey = '';
    if (last) render(...last);
  }

  function placeProps(id, n) {
    const S = scale();
    penEl.style.setProperty('--s', S + 'px');
    const key = `${id}|${n}|${S}`;
    if (penEl._propsKey === key) return;
    penEl._propsKey = key;
    const props = [];
    const at = (name, x, y, z, extra = '') => props.push(`<div class="pp ${extra}" style="left:${x}%;top:${y}%;z-index:${z}">${prop(name, S)}</div>`);
    penEl.querySelector('.pen-scene').dataset.room = id;
    penEl.querySelector('.pen-gate').classList.toggle('hidden', id !== 'gate');
    if (id === 'desk') {
      for (const [x, y] of slotsFor('desk', Math.max(2, n))) at('desk', x, y + 3, Math.round(y) + 2);
      at('plant', 4, 30, 30); at('plant', 96, 30, 30);
    } else if (id === 'library') {
      [15, 38, 61, 84].forEach((x) => at('shelf', x, 30, 22));
      at('plant', 4, 40, 40);
    } else if (id === 'play') {
      props.push('<div class="rug"></div>');
      at('ball', 70, 62, 62); at('plant', 6, 34, 34); at('plant', 94, 34, 34);
      PLAY = { x0: 14, x1: 86, y0: 52, y1: 92 };
    } else if (id === 'bed') {
      props.push('<div class="sand"></div>');
      [[90, 34, 0], [8, 92, 2], [94, 90, 3], [52, 30, 1]].forEach(([x, y, i]) => props.push(`<div class="pp spare" style="left:${x}%;top:${y}%;z-index:${y}">${emptyShell(SHELLS[i], 40 + i * 70, Math.max(2, S - 2))}</div>`));
    } else if (id === 'gate') {
      at('plant', 30, 90, 90); at('plant', 70, 90, 90);
    }
    penEl.querySelector('.props').innerHTML = props.join('');
  }

  function place(c) {
    c.el.style.left = c.x + '%';
    c.el.style.top = c.y + '%';
    c.el.style.zIndex = String(Math.round(c.y) + (c.zone === 'desk' ? 0 : 1));
  }

  function fxHtml(st) {
    switch (st.fx) {
      case 'ask': return '<span class="fx q">?</span>';
      case 'zz': return '<span class="fx zz">z<i>z</i><b>z</b></span>';
      case 'bash': return '<span class="fx code">$_</span>';
      case 'code': return '<span class="fx code">&lt;/&gt;</span>';
      case 'think': return '<span class="fx dots">· · ·</span>';
      case 'boss': return '<span class="fx code">+helpers</span>';
      case 'limit': return '<span class="fx limit">▯ limit</span>';
      case 'full': return '<span class="fx q warn">!</span>';
      default: return '';
    }
  }

  function meterHtml(pct) {
    if (!pct || pct < 60) return '';
    const cls = pct >= 85 ? 'hot' : pct >= 70 ? 'warm' : '';
    return `<span class="meter ${cls}" title="context ${pct}% full"><i style="width:${pct}%"></i></span>`;
  }

  function spriteHtml(c, conv, pose) {
    return crab(conv, pose, 96);
  }

  const escHtml = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // ---------- hover card ----------
  const WHERE = { 'claude-vscode': 'vs code', 'claude-desktop': 'claude app', cli: 'terminal', hub: 'claw hub', 'sdk-cli': 'claw hub' };
  function cardHtml(conv, now) {
    const st = stateOf(conv, now);
    const what = conv.purpose
      ? escHtml(conv.purpose)
      : conv.firstPrompt ? `<span class="cc-dim">(still figuring it out) first ask:</span> "${escHtml(short(conv.firstPrompt, 140))}"`
        : '<span class="cc-dim">no job yet. nothing typed.</span>';
    const l = conv.live || {};
    const where = l.parked ? l.where : l.inHub ? 'claw hub' : l.phone ? 'phone' : WHERE[l.entrypoint] || (l.tty ? 'terminal' : l.entrypoint || '');
    const twins = (window.Pen.overlaps || []).filter((o) => o.a === conv.id || o.b === conv.id).map((o) => {
      const other = last && last[0].find((c) => c.id === (o.a === conv.id ? o.b : o.a));
      return other ? `<p class="cc-twin">same job as <b>${escHtml(short(other.title, 40))}</b>? ${escHtml(o.why || '')}</p>` : '';
    }).join('');
    return `<b class="cc-title">${escHtml(conv.title)}</b>
      <p class="cc-for"><i>for</i>${what}</p>
      <p class="cc-now"><i>now</i>${escHtml(sayFor(conv, st))}</p>
      <p class="cc-meta">${escHtml(short(conv.cwd || '', 40))}${where ? ` · ${escHtml(where)}` : ''}</p>${twins}`;
  }

  // ---------- the map (top view) ----------
  const MAX_ICONS = 12;
  function renderMap(zones) {
    const S = scale();
    penEl.style.setProperty('--s', S + 'px');
    const html = ROOMS.map((r) => {
      const list = zones[r.id];
      const [x0, y0, x1, y1] = r.box;
      const icons = list.slice(0, MAX_ICONS).map((conv) => {
        const l = lookFor(conv);
        const busy = conv.live.status === 'busy' && !conv.live.parked;
        return `<button class="mapcrab${busy ? ' busy' : ''}" data-id="${conv.id}" aria-label="${escHtml(conv.title)}">${topCritter(l.hue, S * 9, l.shell)}</button>`;
      }).join('') + (list.length > MAX_ICONS ? `<span class="more-crabs">+${list.length - MAX_ICONS}</span>` : '');
      const names = list.slice(0, 3).map((c) => escHtml(c.title.length > 20 ? c.title.slice(0, 19) + '…' : c.title)).join(' · ')
        + (list.length > 3 ? ` · +${list.length - 3}` : '');
      return `<div class="mroom r-${r.id}${list.length ? '' : ' empty'}" data-room="${r.id}" role="button" tabindex="0" aria-label="${r.name}: ${list.length} crabs"
          style="left:${x0}%;top:${y0}%;width:${x1 - x0}%;height:${y1 - y0}%">
        <div class="furn"></div>
        <div class="mhead"><b>${r.name}</b><span class="mcount">${list.length}</span><i>${r.blurb}</i></div>
        <div class="mcrabs">${icons}</div>
        <div class="mnames">${list.length ? names : 'empty'}</div>
      </div>`;
    }).join('');
    const map = penEl.querySelector('.pen-map');
    if (map._html !== html) { map._html = html; map.innerHTML = html; }
  }

  function render(convos, now) {
    last = [convos, now];
    const live = convos;
    const zones = { desk: [], library: [], bed: [], gate: [], play: [] };
    const states = new Map();
    for (const conv of live) { const st = stateOf(conv, now); states.set(conv.id, st); zones[st.zone].push(conv); }
    renderMap(zones);
    penEl.classList.toggle('in-room', !!room);
    if (!room) { for (const c of crabs.values()) c.el.remove(); crabs.clear(); for (const b of babies.values()) b.el.remove(); babies.clear(); return; }

    const here = zones[room];
    const r = roomById(room);
    const nameEl = penEl.querySelector('.room-name');
    const label = `${r.name} · ${here.length} ${here.length === 1 ? 'crab' : 'crabs'} ${r.blurb}`;
    if (nameEl.textContent !== label) nameEl.textContent = here.length ? label : `${r.name} · empty right now`;
    placeProps(room, here.length);

    const slots = slotsFor(room, here.length);
    const seen = new Set();
    const container = penEl.querySelector('.crabs');
    here.forEach((conv, i) => {
      seen.add(conv.id);
      const st = states.get(conv.id);
      const spot = room === 'play' ? null : slots[i];
      let c = crabs.get(conv.id);
      if (!c) {
        const el = document.createElement('button');
        el.className = 'crab';
        el.dataset.id = conv.id;
        el.innerHTML = '<span class="say"></span><span class="fxs"></span><span class="spr"></span><span class="tag"></span>';
        container.appendChild(el);
        c = { el, x: 50, y: 99, zone: null, pose: null, facing: 1, movingUntil: 0, key: '' };
        crabs.set(conv.id, c);
        place(c);
        el.getBoundingClientRect(); // so the first move animates (walks in through the door)
      }
      c.conv = conv; c.st = st;
      const say = sayFor(conv, st);
      const sayEl = c.el.querySelector('.say');
      if (sayEl.textContent !== say) sayEl.textContent = say;
      if (c.zone !== room) {
        c.zone = room;
        const [nx, ny] = spot || freeSpot(c);
        walkTo(c, nx, ny);
      } else if (spot && !c.leaving && (c.x !== spot[0] || c.y !== spot[1])) {
        walkTo(c, spot[0], spot[1]);
      }
      const moving = Date.now() < c.movingUntil;
      const pose = moving ? 'walk' : st.pose;
      const key = `${pose}|${st.fx}|${st.pct}|${conv.title}|${c.facing}|${conv.hue}|${conv.shell}`;
      if (key !== c.key) {
        c.key = key;
        c.el.className = `crab z-${c.zone} p-${st.pose}${moving ? ' moving' : ''}`;
        c.el.querySelector('.spr').innerHTML = spriteHtml(c, conv, pose);
        c.el.querySelector('.spr').style.transform = c.facing < 0 ? 'scaleX(-1)' : '';
        c.el.querySelector('.fxs').innerHTML = moving ? '' : fxHtml(st) + meterHtml(st.pct);
        const short = conv.title.length > 22 ? conv.title.slice(0, 21) + '…' : conv.title;
        c.el.querySelector('.tag').textContent = short;
        c.el.removeAttribute('title');
        c.el.setAttribute('aria-label', `${conv.title}: ${say}`);
      }
    });
    // crabs that moved to another place walk out the door
    for (const [id, c] of crabs) {
      if (seen.has(id) || c.leaving) continue;
      c.leaving = true;
      c.onArrive = () => { c.el.remove(); crabs.delete(id); };
      walkTo(c, 50, 104);
    }
    renderBabies(live.filter((conv) => seen.has(conv.id)));
  }

  // ---------- baby crabs (subagents) ----------
  const babies = new Map(); // "sid/agent-x" -> { el, x, y, status, ... }
  const wentHome = new Set();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function babyPose(h) {
    if (h.status === 'stuck') return 'tired';
    if (h.status === 'done') return 'ask'; // waving its scroll until you open it
    if (h.tool && READ_TOOLS.test(h.tool)) return 'read';
    if (h.tool) return 'type';
    return 'think';
  }
  // babies near their mother sit on a half ring below her, each in its own spot
  function babyTarget(h, mom, i = 0, n = 1) {
    if (room === 'library' && h.status !== 'stuck' && h.tool && READ_TOOLS.test(h.tool)) return [rand(10, 90), rand(40, 54)];
    const ang = Math.PI * (n === 1 ? 0.5 : 0.08 + 0.84 * (i / (n - 1)));
    return [clamp(mom.x - Math.cos(ang) * 15 + rand(-1, 1), 5, 95), clamp(mom.y + Math.sin(ang) * 13 + 3, 14, 97)];
  }
  function ringIndex(conv, h) {
    const near = (conv.live.helpers || []).filter((x) => x.status === 'done' || x.status === 'stuck' || !(x.tool && READ_TOOLS.test(x.tool)));
    return [Math.max(0, near.findIndex((x) => x.id === h.id)), Math.max(1, near.length)];
  }
  function babyDraw(b) {
    const pose = Date.now() < b.movingUntil ? 'walk' : babyPose(b.h);
    const key = `${pose}|${b.h.status}|${b.facing}`;
    if (key === b.key) return;
    b.key = key;
    b.el.className = `crab baby s-${b.h.status}${Date.now() < b.movingUntil ? ' moving' : ''}${b.hatching ? ' hatch' : ''}`;
    const spr = b.el.querySelector('.spr');
    spr.innerHTML = pixelCritter(pose, b.hue, 48, false, b.shell);
    spr.style.transform = b.h.status === 'stuck' ? 'rotate(180deg)' : b.facing < 0 ? 'scaleX(-1)' : '';
    b.el.querySelector('.fxs').innerHTML = b.h.status === 'stuck' ? '<span class="fx q bad">!</span>' : b.h.status === 'done' ? '<span class="fx scroll"></span>' : '';
  }

  function renderBabies(live) {
    const seen = new Set();
    const container = penEl.querySelector('.crabs');
    for (const conv of live) {
      const mom = crabs.get(conv.id);
      if (!mom) continue;
      for (const h of conv.live.helpers || []) {
        const key = `${conv.id}/${h.id}`;
        if (wentHome.has(key)) continue;
        seen.add(key);
        let b = babies.get(key);
        if (!b) {
          const el = document.createElement('button');
          el.className = 'crab baby hatch';
          el.dataset.sub = key;
          el.innerHTML = '<span class="say"></span><span class="fxs"></span><span class="spr"></span><span class="tag"></span>';
          el.querySelector('.tag').textContent = h.description.length > 22 ? h.description.slice(0, 21) + '…' : h.description;
          container.appendChild(el);
          b = { el, x: mom.x, y: mom.y, facing: 1, movingUntil: 0, key: '', hue: lookFor(conv).hue, shell: lookFor(conv).shell, h, conv, hatching: true };
          babies.set(key, b);
          place(b);
          b.el.style.zIndex = String(Math.round(mom.y) + 2);
          babyDraw(b);
          setTimeout(() => { b.hatching = false; const [x, y] = babyTarget(b.h, mom, ...ringIndex(b.conv, b.h)); walkTo(b, x, y); }, 500);
        }
        const was = b.h.status;
        const ring = ringIndex(conv, h);
        const ringChanged = b.ring && (b.ring[0] !== ring[0] || b.ring[1] !== ring[1]);
        b.h = h; b.conv = conv; b.ring = ring;
        const lk = lookFor(conv);
        if (lk.hue !== b.hue || lk.shell !== b.shell) { b.hue = lk.hue; b.shell = lk.shell; b.key = ''; }
        const bsay = h.orphan ? `stopped: ${short(h.description, 36)}. my crab closed, wake it to retry`
          : h.status === 'stuck' ? `stuck on: ${short(h.description, 40)}. help?` : h.status === 'done' ? 'done! tap me to see what I found' : `${h.tool ? (VERBS[h.tool] || h.tool.toLowerCase()) : 'working on'} · ${short(h.description, 36)}`;
        const bs = b.el.querySelector('.say');
        if (bs.textContent !== bsay) bs.textContent = bsay;
        b.onArrive = () => babyDraw(b);
        if ((h.status !== was || ringChanged) && !b.hatching) { const [x, y] = babyTarget(h, mom, ...ring); walkTo(b, x, y); }
        babyDraw(b);
      }
    }
    for (const [key, b] of babies) {
      if (seen.has(key) || b.leaving) continue;
      const mom = crabs.get(b.conv.id);
      if (b.h.status === 'done' && mom) {
        // you opened it: walk the finished work home to its mom, then go
        b.leaving = true;
        b.say = b.el.querySelector('.say'); b.say.textContent = 'bringing it home';
        b.onArrive = () => { b.el.classList.add('home'); setTimeout(() => { b.el.remove(); babies.delete(key); wentHome.add(key); }, 700); };
        walkTo(b, mom.x, mom.y);
      } else { b.el.remove(); babies.delete(key); }
    }
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  // a spot in the play area that keeps its distance from the other critters
  function freeSpot(self) {
    let best = null, bestD = -1;
    for (let i = 0; i < 14; i++) {
      const x = rand(PLAY.x0, PLAY.x1), y = rand(PLAY.y0, PLAY.y1);
      let d = Infinity;
      for (const o of crabs.values()) if (o !== self) d = Math.min(d, Math.hypot(o.x - x, (o.y - y) * 1.4));
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    return best;
  }

  function walkTo(c, x, y) {
    const dist = Math.hypot(x - c.x, (y - c.y) * 0.6);
    const ms = Math.max(600, dist * 70);
    c.facing = x < c.x ? -1 : 1;
    c.el.style.transitionDuration = ms + 'ms';
    c.x = x; c.y = y;
    c.movingUntil = Date.now() + ms;
    c.key = '';
    place(c);
    if (c.h) babyDraw(c);
    clearTimeout(c.stopT);
    c.stopT = setTimeout(() => { c.key = ''; if (c.onArrive) c.onArrive(); else if (c.conv) refreshOne(c); }, ms + 30);
  }

  function refreshOne(c) {
    if (c.leaving || !c.st) return;
    const st = c.st; const conv = c.conv;
    const pose = st.pose;
    if (c.zone !== 'play') c.facing = 1; // face the laptop / shelf / you
    c.el.querySelector('.spr').style.transform = c.facing < 0 ? 'scaleX(-1)' : '';
    c.el.className = `crab z-${c.zone} p-${st.pose}`;
    c.el.querySelector('.spr').innerHTML = spriteHtml(c, conv, pose);
    c.el.querySelector('.fxs').innerHTML = fxHtml(st) + meterHtml(st.pct);
    c.key = `${pose}|${st.fx}|${st.pct}|${conv.title}|${c.facing}`;
  }

  // idle critters wander around the rug
  setInterval(() => {
    if (document.hidden) return;
    for (const c of crabs.values()) {
      if (c.zone !== 'play' || Date.now() < c.movingUntil) continue;
      if (c.st && c.st.pose !== 'idle') continue;
      if (Math.random() < 0.4) { const [x, y] = freeSpot(c); walkTo(c, x, y); }
    }
    for (const b of babies.values()) {
      if (b.hatching || b.h.status !== 'run' || Date.now() < b.movingUntil || Math.random() > 0.15) continue;
      const mom = [...crabs.values()].find((c) => c.conv && b.el.dataset.sub.startsWith(c.conv.id));
      if (mom && b.h.tool && READ_TOOLS.test(b.h.tool)) { const [x, y] = babyTarget(b.h, mom); walkTo(b, x, y); }
    }
  }, 2600);

  // ---------- tips ----------
  function tips(all, now) {
    const out = [];
    const convos = all.filter((c) => !c.live.parked);
    const limit = convos.map((c) => c.live.activity && c.live.activity.limit).find(Boolean);
    if (limit) out.push({ kind: 'limit', text: `usage limit hit. claude picks back up ${limit.at ? 'at ' + limit.at : 'later'}.` });
    for (const c of convos) {
      const a = c.live.activity || {};
      if (a.ctxPct >= 85) out.push({ kind: 'full', id: c.id, text: `${c.title} is ${a.ctxPct}% full. compact it now, or it auto-compacts soon and loses detail.`, actions: ['compact', 'fresh'] });
    }
    for (const c of convos) {
      const a = c.live.activity || {};
      if (a.asking && c.live.status !== 'busy') out.push({ kind: 'ask', id: c.id, text: `${c.title} asked you something.`, actions: ['open'] });
    }
    for (const c of convos) {
      const a = c.live.activity || {};
      if (a.ctxPct >= 70 && a.ctxPct < 85) out.push({ kind: 'warm', id: c.id, text: `${c.title} is ${a.ctxPct}% full. a good time to /compact is between tasks.`, actions: ['compact'] });
    }
    const sleepy = convos.filter((c) => c.live.status !== 'busy' && now - (c.live.statusSince || now) > 2 * 3600 * 1000);
    for (const c of sleepy.slice(0, 2)) out.push({ kind: 'old', id: c.id, text: `${c.title} has waited ${Math.round((now - c.live.statusSince) / 3600000)}h. close it if you're done.`, actions: ['close'] });
    for (const c of convos) for (const h of c.live.helpers || []) {
      if (h.status === 'stuck') out.push({ kind: 'full', id: c.id, text: `a baby of ${c.title} ("${h.description}") has gone quiet for minutes. check on it.`, actions: ['open'] });
    }
    if (convos.length >= 6) out.push({ kind: 'many', text: `${convos.length} sessions open. sleeping ones still use memory, close a few.` });
    return out.slice(0, 5);
  }

  window.Pen = { buildPen, render, tips, stateOf, overlaps: [] };
})();
