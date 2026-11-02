// Chunky pixel claw critters + playpen props, drawn procedurally and auto-outlined.
(function () {
  const W = 24, H = 20;

  function blank(w = W, h = H) { return Array.from({ length: h }, () => Array(w).fill('.')); }
  function set(g, x, y, c) { x = Math.round(x); y = Math.round(y); if (g[y] && x >= 0 && x < g[y].length) g[y][x] = c; }
  function ellipse(g, cx, cy, rx, ry, c, pred) {
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1 && (!pred || pred(x, y))) g[y][x] = c;
    }
  }
  function rect(g, x0, y0, w, h, c) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(g, x, y, c); }
  function claw(g, cx, cy, open) {
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) set(g, cx + x, cy + y, 'c');
    set(g, cx, cy - 1, open ? '.' : 'c');
    if (open) set(g, cx, cy - 2, '.');
    set(g, cx - 1, cy - 2, 'c'); set(g, cx + 1, cy - 2, 'c');
    set(g, cx - 1, cy + 1, 'd'); set(g, cx + 1, cy + 1, 'd');
  }
  function line(g, x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let i = 0; i <= n; i++) set(g, Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c);
  }
  function outline(g) {
    const out = g.map((r) => r.slice());
    for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) {
      if (g[y][x] !== '.') continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const c = (g[y + dy] || [])[x + dx]; return c && c !== '.' && c !== 'G'; });
      if (n) out[y][x] = 'o';
    }
    return out;
  }

  // ---------- hermit crab (faces right) ----------
  // shell types: spiral, conch, moon, tower
  function shell(g, type, cx, cy, r) {
    if (type === 'tower') {
      // stacked whorls leaning back-left
      ellipse(g, cx, cy + 2, r, 3.6, 'S');
      const n = 5;
      for (let k = 1; k < n; k++) {
        const rr = r * (1 - k * 0.19);
        const wy = cy + 2 - k * 2.4, wx = cx - k * 1.3;
        ellipse(g, wx, wy, rr, 2.3, 'S');
        const ry = Math.round(wy + 2);
        for (let x = Math.round(wx - rr + 1); x <= wx + rr - 1; x++) set(g, x, ry, 'T');
      }
      set(g, cx - n * 1.3 + 0.5, cy + 2 - n * 2.4 + 1, 'S');
    } else if (type === 'conch') {
      ellipse(g, cx, cy + 1, r, r * 0.85, 'S');
      for (let i = 0; i < 4; i++) { set(g, cx - r + 1 - i, cy - r + 2 - i, 'S'); set(g, cx - r + 2 - i, cy - r + 2 - i, 'S'); }
      for (let y = -2; y <= 3; y += 2) line(g, cx - r + 1, cy + y, cx + r - 1, cy + y - 1, 'T');
      set(g, cx - r - 3, cy - r - 1, 'U');
    } else if (type === 'moon') {
      ellipse(g, cx, cy, r, r, 'S');
      for (let y = Math.ceil(cy - r) + 1; y < cy + r; y += 2) for (let x = 0; x < W; x++) if (g[y] && g[y][x] === 'S' && (x + y) % 3) set(g, x, y, 'T');
    } else {
      ellipse(g, cx, cy, r, r, 'S');
      let px = null, py = null;
      for (let t = 0; t < Math.PI * 4.2; t += 0.12) {
        const rr = (r - 0.8) * (1 - t / (Math.PI * 4.6));
        const x = Math.round(cx + rr * Math.cos(t)), y = Math.round(cy + rr * Math.sin(t));
        if (x !== px || y !== py) set(g, x, y, 'T');
        px = x; py = y;
      }
    }
    // highlight
    set(g, cx - r * 0.5, cy - r * 0.6, 'U'); set(g, cx - r * 0.5 + 1, cy - r * 0.6, 'U'); set(g, cx - r * 0.5, cy - r * 0.6 + 1, 'U');
  }

  // pose: { lc, rc, open, eyes, bob, step, book, page, sweat, hide, tight }
  function draw(p, shellType) {
    const g = blank();
    const b = p.bob || 0;
    const tight = !!p.tight;
    const sr = tight ? 4.2 : 6.6;
    const scx = tight ? 6.5 : 8, scy = (tight ? 9 : 10) + b + (p.hide ? 2 : 0);
    shell(g, shellType, scx, scy, sr);
    if (!p.hide) {
      // legs
      const st = p.step || 0;
      const legs = [[12, 16, 11, 18], [14, 16, 14, 18], [16, 16, 17, 18], [18, 15, 20, 17]];
      legs.forEach(([x0, y0, x1, y1], i) => { const lift = st && i % 2 === (st === 1 ? 0 : 1) ? -1 : 0; line(g, x0, y0 + b, x1, y1 + b + lift, 'd'); });
      // body
      const bx = tight ? 14.5 : 15, by = 13 + b, brx = tight ? 6 : 5, bry = tight ? 4 : 3.6;
      ellipse(g, bx, by, brx, bry, 'b');
      ellipse(g, bx, by, brx, bry, 'd', (x, y) => y >= by + bry - 1.4);
      ellipse(g, bx + 0.5, by + 0.8, brx * 0.45, bry * 0.4, 'l');
      // eye stalks
      const up = p.eyes === 'up' ? -1 : p.eyes === 'down' ? 1 : 0;
      line(g, 15, 11 + b, 15, 7 + b + up, 'd');
      line(g, 17, 11 + b, 18, 7 + b + up, 'd');
      for (const ex of [14, 17]) {
        const ey = 5 + b + up;
        if (p.eyes === 'shut') { set(g, ex, ey + 1, 'k'); set(g, ex + 1, ey + 1, 'k'); }
        else if (p.eyes === 'half') { set(g, ex, ey, 'd'); set(g, ex + 1, ey, 'd'); set(g, ex, ey + 1, 'k'); set(g, ex + 1, ey + 1, 'k'); }
        else { set(g, ex, ey, 'w'); set(g, ex + 1, ey, 'k'); set(g, ex, ey + 1, 'k'); set(g, ex + 1, ey + 1, 'k'); }
      }
      set(g, 18, 13 + b, 'r');
      // arms + claws (lc = small claw, rc = big claw)
      line(g, 16, 14 + b, p.lc[0] - 1, p.lc[1] + 1 + b, 'd');
      line(g, 18, 13 + b, p.rc[0] - 1, p.rc[1] + 1 + b, 'd');
      if (p.book) {
        rect(g, 17, 11 + b, 6, 5, 'B'); rect(g, 18, 11 + b, 2, 4, 'P'); rect(g, 21, 11 + b, 1, 4, 'P');
        if (p.page) rect(g, 20, 10 + b, 1, 4, 'P');
      } else {
        claw(g, p.lc[0], p.lc[1] + b, false);
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 2; x++) set(g, p.rc[0] + x, p.rc[1] + y + b, 'c');
        set(g, p.rc[0] + 1, p.rc[1] - 1 + b, p.open ? '.' : 'c'); set(g, p.rc[0] + 2, p.rc[1] - 2 + b, 'c'); set(g, p.rc[0], p.rc[1] - 2 + b, 'c');
      }
    } else {
      // hiding: just claw tips peeking out of the opening
      set(g, 13, 15, 'c'); set(g, 14, 15, 'c'); set(g, 14, 14, 'c');
    }
    const out = outline(g);
    if (p.sweat) { const d = p.sweat > 1 ? 1 : 0; set(out, 20, 4 + d, 's'); set(out, 21, 5 + d, 's'); set(out, 21, 6 + d, 's'); }
    return out;
  }

  function palette(hue) {
    return {
      o: '#1a1022', b: `hsl(${hue} 80% 66%)`, d: `hsl(${hue} 62% 44%)`, l: `hsl(${hue} 90% 82%)`,
      c: `hsl(${hue} 72% 56%)`, h: '#fff', k: '#1a1022', w: '#fff', r: 'hsl(340 90% 72%)', a: 'hsl(330 100% 70%)',
      B: `hsl(${(hue + 170) % 360} 55% 45%)`, P: '#f4ecd8', s: '#7fd4ff',
      S: `hsl(${(hue + 150) % 360} 55% 72%)`, T: `hsl(${(hue + 150) % 360} 45% 48%)`, U: '#fff8ee',
    };
  }

  function rects(grid, pal) {
    let out = '';
    for (let y = 0; y < grid.length; y++) {
      let x = 0;
      while (x < grid[y].length) {
        const c = grid[y][x];
        if (c === '.' || !pal[c]) { x++; continue; }
        let run = 1;
        while (x + run < grid[y].length && grid[y][x + run] === c) run++;
        out += `<rect x="${x}" y="${y}" width="${run + 0.02}" height="1.02" fill="${pal[c]}"/>`;
        x += run;
      }
    }
    return out;
  }

  const POSES = {
    idle: [{ lc: [19, 15], rc: [21, 8], open: true, eyes: 'up' }, { lc: [19, 15], rc: [21, 10], open: false, eyes: 'up' }],
    walk: [{ lc: [20, 15], rc: [21, 13], eyes: 'open', step: 1 }, { lc: [20, 15], rc: [21, 13], open: true, eyes: 'open', step: 2, bob: -1 }],
    type: [{ lc: [20, 16], rc: [21, 15], eyes: 'down' }, { lc: [20, 15], rc: [21, 16], eyes: 'down', bob: -1 }],
    busy: [{ lc: [20, 14], rc: [21, 10], open: true, eyes: 'open' }, { lc: [20, 15], rc: [21, 12], eyes: 'open', bob: -1 }],
    read: [{ lc: [20, 14], rc: [21, 14], eyes: 'down', book: true }, { lc: [20, 14], rc: [21, 14], eyes: 'down', book: true, page: true }],
    think: [{ lc: [19, 15], rc: [20, 11], eyes: 'up' }, { lc: [19, 15], rc: [20, 10], eyes: 'up', bob: -1 }],
    ask: [{ lc: [20, 8], rc: [21, 6], open: true, eyes: 'up' }, { lc: [20, 9], rc: [21, 7], open: true, eyes: 'up', bob: -1 }],
    nap: [{ hide: true }, { hide: true, bob: 1 }],
    full: [{ lc: [20, 16], rc: [21, 15], eyes: 'half', tight: true, sweat: 1 }, { lc: [20, 16], rc: [21, 15], eyes: 'half', tight: true, sweat: 2, bob: 1 }],
    tired: [{ lc: [19, 17], rc: [21, 17], eyes: 'half', bob: 1 }, { lc: [19, 17], rc: [21, 17], eyes: 'shut', bob: 1 }],
  };
  const SHELLS = ['spiral', 'conch', 'moon', 'tower'];

  const frameCache = new Map();
  function frames(mood, shellType) {
    const key = `${mood}|${shellType}`;
    if (!frameCache.has(key)) frameCache.set(key, (POSES[mood] || POSES.idle).map((p) => draw(p, shellType)));
    return frameCache.get(key);
  }
  // seed picks the crab's color and its shell; shellOverride forces a shell type
  function pixelCritter(mood, hue, size = 120, still = false, shellType) {
    const pal = palette(hue);
    const [a, b] = frames(mood, shellType || SHELLS[hue % SHELLS.length]);
    const head = `<svg class="px ${still ? 'still' : mood}" viewBox="0 0 ${W} ${H}" width="${size}" height="${size * H / W}" shape-rendering="crispEdges">`;
    if (still) return `${head}<g class="f1">${rects(a, pal)}</g></svg>`;
    return `${head}<g class="f1">${rects(a, pal)}</g><g class="f2">${rects(b, pal)}</g></svg>`;
  }

  // ---------- props ----------
  const PROP_PAL = {
    o: '#1a1022', w: '#6b4a3a', W: '#4e3329', x: '#8a6450', l: '#3b3550', L: '#4d4668', g: '#ff7ac6', G: 'rgba(255,122,198,.25)',
    p: '#efe6ff', q: '#c9bce0', b: '#7a5cc4', B: '#5a3f9e', r: '#ff7ac6', y: '#ffd36b', t: '#7dffb0', T: '#3f9e6a', s: '#a78bfa', S: '#2e2244',
  };
  const PROPS = {
    desk: [
      '...........oooooooo...........',
      '...........olLLLLlo...........',
      '...........oLLgLLLo...........',
      '...........oLLLLLLo...........',
      '..........oooooooooo..........',
      'oooooooooooooooooooooooooooooo',
      'oxxxxxxxxxxxxxxxxxxxxxxxxxxxxo',
      'owwwwwwwwwwwwwwwwwwwwwwwwwwwwo',
      'oooWWooooooooooooooooooooWWooo',
      '..oWWo..................oWWo..',
      '..oWWo..................oWWo..',
      '..oooo..................oooo..',
    ],
    bed: [
      '..oooooo......................',
      '.oppppppo.....................',
      'oppqqqqppooooooooooooooooooooo',
      'opqqqqqqpbbbbbbbbbbbbbbbbbbbbo',
      'oobbbbbbbbbbBbbbbbbbbbbBbbbbbo',
      'obbbbbBbbbbbbbbbbbBbbbbbbbbbbo',
      'oBBBBBBBBBBBBBBBBBBBBBBBBBBBBo',
      'oWoooooooooooooooooooooooooWWo',
      'oWo........................oWo',
      'ooo........................ooo',
    ],
    shelf: [
      'oooooooooooooooooooo',
      'oxxxxxxxxxxxxxxxxxxo',
      'ox.oo.ooo..oo.ooo.xo',
      'oxorobyyobotobgggoxo',
      'oxorobyyobotobgggoxo',
      'oxorobyyobotobgggoxo',
      'owwwwwwwwwwwwwwwwwwo',
      'ox..ooo.oo..ooo...xo',
      'ox.otttobbo.oyyo..xo',
      'ox.otttobbo.oyyooorxo',
      'ox.otttobbo.oyyoorrxo',
      'owwwwwwwwwwwwwwwwwwo',
      'oWWoooooooooooooooWWo',
      'oooo............oooo',
    ],
    ball: [
      '.oooo.',
      'orryro',
      'oryrro',
      'orrryo',
      '.oooo.',
    ],
    plant: [
      '..o..o..',
      '.oto.oto',
      'otTtototo',
      '.ottTtto',
      '..oTtto.',
      '..oooo..',
      '.oxxxxo.',
      '.owwwwo.',
      '..oooo..',
    ],
    rug: [
      '..ssssssssssssssssssss..',
      '.sSSSSSSSSSSSSSSSSSSSSs.',
      'sSSsSSSSsSSSSsSSSSsSSSSs',
      '.sSSSSSSSSSSSSSSSSSSSSs.',
      '..ssssssssssssssssssss..',
    ],
  };
  function prop(name, scale) {
    const g = PROPS[name].map((r) => r.split(''));
    const w = Math.max(...g.map((r) => r.length));
    return `<svg class="prop prop-${name}" viewBox="0 0 ${w} ${g.length}" width="${w * scale}" height="${g.length * scale}" shape-rendering="crispEdges">${rects(g, PROP_PAL)}</svg>`;
  }

  function hueFor(str) {
    let h = 0;
    for (const ch of String(str || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  // an empty shell lying around (for the shell beach)
  function emptyShell(type, hue, scale) {
    const g = blank(16, 14);
    const gg = g; // shell() draws on a W-wide grid; use a full-size grid then crop
    const big = blank();
    shell(big, type, 8, 8, 6.4);
    const out = outline(big).slice(0, 16).map((r) => r.slice(0, 18));
    const pal = palette(hue);
    return `<svg class="prop" viewBox="0 0 18 16" width="${18 * scale}" height="${16 * scale}" shape-rendering="crispEdges">${rects(out, pal)}</svg>`;
  }

  // a chat's crab look: your picked color/shell, else one derived from its folder
  function lookFor(conv) {
    const base = hueFor((conv && (conv.cwd || conv.id)) || '');
    return { hue: conv && Number.isInteger(conv.hue) ? conv.hue : base, shell: (conv && conv.shell) || SHELLS[base % SHELLS.length] };
  }
  function crab(conv, mood, size, still) { const l = lookFor(conv); return pixelCritter(mood, l.hue, size, still, l.shell); }

  // ---------- hermit crab seen from above (for the map), facing up ----------
  const topCache = new Map();
  function topGrid(shellType) {
    if (topCache.has(shellType)) return topCache.get(shellType);
    const g = blank(14, 14);
    // legs: three a side, poking out under the shell
    for (const y of [7, 9, 11]) { line(g, 3, y, 1, y + 1, 'd'); line(g, 10, y, 12, y + 1, 'd'); }
    // body + claws in front (top), big claw on the right
    ellipse(g, 7, 5, 3.2, 2.4, 'b');
    line(g, 5, 4, 3, 2, 'd'); line(g, 9, 4, 11, 2, 'd');
    rect(g, 2, 1, 2, 2, 'c'); rect(g, 10, 0, 3, 3, 'c');
    set(g, 6, 2, 'k'); set(g, 8, 2, 'k'); // eyes
    // shell on its back, seen from the top
    ellipse(g, 7, 9, 4.2, 4.2, 'S');
    if (shellType === 'moon') { for (let y = 6; y < 13; y += 2) for (let x = 4; x < 11; x++) if (g[y][x] === 'S' && (x + y) % 3) set(g, x, y, 'T'); }
    else if (shellType === 'tower') { ellipse(g, 7, 9, 2.6, 2.6, 'T'); ellipse(g, 7, 9, 1.4, 1.4, 'S'); set(g, 7, 9, 'T'); }
    else if (shellType === 'conch') { for (let y = 6; y <= 12; y += 2) line(g, 4, y, 10, y - 1, 'T'); }
    else { let px = null, py = null; for (let t = 0; t < Math.PI * 4; t += 0.15) { const rr = 3.4 * (1 - t / (Math.PI * 4.4)); const x = Math.round(7 + rr * Math.cos(t)), y = Math.round(9 + rr * Math.sin(t)); if (x !== px || y !== py) set(g, x, y, 'T'); px = x; py = y; } }
    set(g, 5, 7, 'U'); set(g, 6, 7, 'U');
    const out = outline(g);
    topCache.set(shellType, out);
    return out;
  }
  function topCritter(hue, size = 36, shellType) {
    const g = topGrid(shellType || SHELLS[hue % SHELLS.length]);
    return `<svg class="px topview" viewBox="0 0 14 14" width="${size}" height="${size}" shape-rendering="crispEdges">${rects(g, palette(hue))}</svg>`;
  }

  window.Critter = { lookFor, crab, pixelCritter, topCritter, hueFor, prop, emptyShell, SHELLS, frames, palette, rects, SPRITE_W: W, SPRITE_H: H };
})();
