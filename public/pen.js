// The playpen: every live session is a critter that goes to the spot that matches what it's doing.
(function () {
  const { pixelCritter, hueFor, prop, emptyShell, SHELLS, lookFor, crab } = window.Critter;

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

  // slot layout in % of the pen (x = center, y = feet)
  const SLOTS = {
    desk: [[16, 40], [37, 40], [16, 66], [37, 66], [16, 92], [37, 92]],
    library: [[64, 38], [86, 38]],
    bed: [[78, 70], [91, 76], [82, 90]],
    gate: [[50, 97], [36, 97], [64, 97]],
  };
  const PLAY = { x0: 40, x1: 72, y0: 52, y1: 86 };

  const crabs = new Map(); // id -> { el, x, y, zone, pose, facing, movingUntil }
  let penEl = null;

  function scale() { return Math.max(3, Math.min(6, Math.round(penEl.clientWidth / 175))); }

  function buildPen(el) {
    penEl = el;
    el.innerHTML = `
      <div class="pen-floor"></div>
      <div class="pen-label" style="left:6%;top:4%">work</div>
      <div class="pen-label" style="left:62%;top:4%">library</div>
      <div class="pen-label" style="left:84%;top:96%">shell beach</div>
      <div class="pen-gate"><span>you</span></div>
      <div class="props"></div>
      <div class="crabs"></div>`;
    placeProps();
    window.addEventListener('resize', () => { placeProps(); for (const c of crabs.values()) place(c); });
  }

  function placeProps(deskCount = 3) {
    const S = scale();
    penEl.style.setProperty('--s', S + 'px');
    const props = [];
    const at = (name, x, y, z, extra = '') => props.push(`<div class="pp ${extra}" style="left:${x}%;top:${y}%;z-index:${z}">${prop(name, S)}</div>`);
    at('shelf', 76, 22, 22);
    props.push('<div class="rug"></div>');
    at('ball', 66, 58, 58);
    at('plant', 4, 30, 30);
    at('plant', 50, 30, 30);
    props.push('<div class="sand"></div>');
    // spare shells lying on the beach: bigger homes to move into
    [[70, 84, 0], [95, 90, 2], [88, 64, 3]].forEach(([x, y, i]) => props.push(`<div class="pp spare" style="left:${x}%;top:${y}%;z-index:${y}">${emptyShell(SHELLS[i], 40 + i * 70, Math.max(2, S - 2))}</div>`));
    for (const [x, y] of SLOTS.desk.slice(0, Math.max(2, deskCount))) at('desk', x, y + 3, Math.round(y) + 2);
    penEl.querySelector('.props').innerHTML = props.join('');
    penEl._desks = Math.max(2, deskCount);
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

  function render(convos, now) {
    const S = scale();
    const live = convos;
    // assign slots per zone
    const zones = { desk: [], library: [], bed: [], gate: [], play: [] };
    const states = new Map();
    for (const conv of live) { const st = stateOf(conv, now); states.set(conv.id, st); zones[st.zone].push(conv); }
    // overflow → play
    for (const z of ['desk', 'library', 'bed', 'gate']) {
      while (zones[z].length > SLOTS[z].length) zones.play.push(zones[z].pop());
    }
    if (penEl._desks !== Math.max(2, zones.desk.length) || penEl.style.getPropertyValue('--s') !== S + 'px') placeProps(zones.desk.length);

    const seen = new Set();
    const container = penEl.querySelector('.crabs');
    const targets = new Map();
    for (const z of ['desk', 'library', 'bed', 'gate']) zones[z].forEach((conv, i) => targets.set(conv.id, { zone: z, x: SLOTS[z][i][0], y: SLOTS[z][i][1] }));
    for (const conv of zones.play) targets.set(conv.id, { zone: 'play' });

    for (const conv of live) {
      seen.add(conv.id);
      const st = states.get(conv.id);
      const tgt = targets.get(conv.id);
      let c = crabs.get(conv.id);
      if (!c) {
        const el = document.createElement('button');
        el.className = 'crab';
        el.dataset.id = conv.id;
        el.innerHTML = '<span class="say"></span><span class="fxs"></span><span class="spr"></span><span class="tag"></span>';
        container.appendChild(el);
        c = { el, x: 61, y: 98, zone: null, pose: null, facing: 1, movingUntil: 0, key: '' };
        crabs.set(conv.id, c);
        place(c);
        el.getBoundingClientRect(); // so the first move animates (walks in from the gate)
      }
      c.conv = conv; c.st = st;
      const say = sayFor(conv, st);
      const sayEl = c.el.querySelector('.say');
      if (sayEl.textContent !== say) sayEl.textContent = say;
      if (tgt.zone !== c.zone) {
        c.zone = tgt.zone;
        const [nx, ny] = tgt.zone === 'play' ? freeSpot(c) : [tgt.x, tgt.y];
        walkTo(c, nx, ny);
      } else if (tgt.zone !== 'play' && (c.x !== tgt.x || c.y !== tgt.y)) {
        walkTo(c, tgt.x, tgt.y);
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
    }
    for (const [id, c] of crabs) if (!seen.has(id)) { c.el.remove(); crabs.delete(id); }
    renderBabies(live);
  }

  // ---------- baby crabs (subagents) ----------
  const babies = new Map(); // "sid/agent-x" -> { el, x, y, status, ... }
  const wentHome = new Set();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function babyPose(h) {
    if (h.status === 'stuck') return 'tired';
    if (h.status === 'done') return 'walk';
    if (h.tool && READ_TOOLS.test(h.tool)) return 'read';
    if (h.tool) return 'type';
    return 'think';
  }
  // babies near their mother sit on a half ring below her, each in its own spot
  function babyTarget(h, mom, i = 0, n = 1) {
    if (h.status === 'done') return [mom.x, mom.y];
    if (h.status !== 'stuck' && h.tool && READ_TOOLS.test(h.tool)) return [rand(58, 94), rand(42, 54)];
    const ang = Math.PI * (n === 1 ? 0.5 : 0.08 + 0.84 * (i / (n - 1)));
    return [clamp(mom.x - Math.cos(ang) * 15 + rand(-1, 1), 5, 95), clamp(mom.y + Math.sin(ang) * 13 + 3, 14, 97)];
  }
  function ringIndex(conv, h) {
    const near = (conv.live.helpers || []).filter((x) => x.status !== 'done' && (x.status === 'stuck' || !(x.tool && READ_TOOLS.test(x.tool))));
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
        const bsay = h.status === 'stuck' ? `stuck on: ${short(h.description, 40)}. help?` : h.status === 'done' ? 'done! bringing it home' : `${h.tool ? (VERBS[h.tool] || h.tool.toLowerCase()) : 'working on'} · ${short(h.description, 36)}`;
        const bs = b.el.querySelector('.say');
        if (bs.textContent !== bsay) bs.textContent = bsay;
        b.onArrive = () => {
          if (b.h.status === 'done') {
            b.el.classList.add('home');
            setTimeout(() => { b.el.remove(); babies.delete(key); wentHome.add(key); }, 700);
          } else babyDraw(b);
        };
        if ((h.status !== was || ringChanged) && !b.hatching) { const [x, y] = babyTarget(h, mom, ...ring); walkTo(b, x, y); }
        babyDraw(b);
      }
    }
    for (const [key, b] of babies) if (!seen.has(key) && !b.el.classList.contains('home')) { b.el.remove(); babies.delete(key); }
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

  window.Pen = { buildPen, render, tips, stateOf };
})();
