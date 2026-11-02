'use strict';
// Claw Hub: a local dashboard for every Claude Code session on this Mac.
// Only listens on 127.0.0.1. No dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const t = require('./lib/transcripts');
const hub = require('./lib/hub-chats');
const skills = require('./lib/skills');

const PORT = Number(process.env.CLAW_HUB_PORT || 4777);
const PUBLIC = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const UPLOADS = path.join(__dirname, 'data', 'uploads');
// only files we saved ourselves can be attached
function cleanImages(list) {
  return (Array.isArray(list) ? list : []).map(String).filter((p) => path.dirname(p) === UPLOADS && fs.existsSync(p)).slice(0, 10);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- local state (your labels, pins, archive) ----------
function readState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { s = {}; }
  s.convos = s.convos || {};
  s.groups = s.groups || [];
  return s;
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ---------- helpers ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function osa(script, args = []) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 8000 }, (err, out) => resolve({ ok: !err, out: (out || '').trim(), err: err && err.message }));
  });
}
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function runInNewTerminal(cmd) {
  return osa(
    'on run argv\n tell application "Terminal"\n activate\n do script (item 1 of argv)\n end tell\nend run',
    [cmd],
  );
}

function focusTty(tty) {
  return osa(
    'on run argv\n set target to item 1 of argv\n tell application "Terminal"\n repeat with w in windows\n repeat with tb in tabs of w\n if tty of tb is target then\n set selected of tb to true\n set index of w to 1\n activate\n return "ok"\n end if\n end repeat\n end repeat\n end tell\n return "missing"\nend run',
    [tty],
  );
}

// ---------- API ----------
function allLive() {
  const mine = hub.list().filter((h) => h.sessionId);
  const seen = new Set(mine.map((h) => h.sessionId));
  return mine.concat(t.listLive().filter((l) => !seen.has(l.sessionId)));
}

function liveInfo(live, meta) {
  const info = { pid: live.pid, status: live.status, statusSince: live.statusSince, entrypoint: live.entrypoint, tty: live.tty };
  if (meta) {
    info.activity = t.activity(meta);
    info.helpers = t.helpers(meta);
  }
  if (live.entrypoint === 'hub') {
    info.inHub = true;
    if (live.error) info.error = live.error;
    if (!info.activity || live.status === 'busy') info.activity = { kind: 'say', text: live.activity };
  }
  return info;
}

function convoSummary(m, state, liveBySession) {
  const s = state.convos[m.id] || {};
  const live = liveBySession.get(m.id);
  return {
    id: m.id,
    title: s.label || m.customTitle || m.aiTitle || (m.firstPrompt || '').slice(0, 80) || 'Untitled',
    autoTitle: m.customTitle || m.aiTitle || null,
    label: s.label || null,
    pinned: !!s.pinned,
    archived: !!s.archived,
    note: s.note || '',
    group: s.group || null,
    cwd: m.cwd,
    firstPrompt: m.firstPrompt,
    lastPrompt: m.lastPrompt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    entrypoint: m.entrypoint,
    bot: m.bot && !s.hub,
    size: m.size,
    live: live ? liveInfo(live, m) : null,
  };
}

async function handleApi(req, res, url) {
  // Block cross-site requests: only our own page may call the API.
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
    return send(res, 403, { error: 'forbidden' });
  }
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'forbidden' });

  if (req.method === 'GET' && url.pathname === '/api/overview') {
    const live = allLive();
    const liveBySession = new Map(live.map((l) => [l.sessionId, l]));
    const state = readState();
    const all = t.listTranscripts();
    const convos = all
      .filter((m) => !m.empty || liveBySession.has(m.id))
      .map((m) => convoSummary(m, state, liveBySession));
    const known = new Set(convos.map((c) => c.id));
    // live sessions that haven't written a transcript yet
    const orphanLive = live.filter((l) => !known.has(l.sessionId)).map((l) => ({
      id: l.sessionId, title: 'New session (nothing typed yet)', cwd: l.cwd, updatedAt: l.statusSince,
      live: liveInfo(l, null),
      pinned: false, archived: false, bot: false, empty: true,
    }));
    return send(res, 200, { convos: orphanLive.concat(convos), groups: state.groups, now: Date.now() });
  }

  const subMatch = url.pathname.match(/^\/api\/sub\/([0-9a-f-]{36})\/(agent-[a-z0-9]+)$/);
  if (req.method === 'GET' && subMatch) {
    const meta = t.findTranscript(subMatch[1]);
    const sub = meta && t.subMeta(meta, subMatch[2]);
    if (!sub) return send(res, 404, { error: 'not found' });
    const items = t.loadConvo(sub);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 250, 2000);
    const start = Math.max(0, items.length - limit);
    return send(res, 200, { total: items.length, start, description: sub.description, finished: sub.finished, items: items.slice(start).map(({ msgId, id, ...rest }) => rest) });
  }

  const convoMatch = url.pathname.match(/^\/api\/convo\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && convoMatch) {
    const meta = t.findTranscript(convoMatch[1]);
    if (!meta) return send(res, 404, { error: 'not found' });
    const items = t.loadConvo(meta);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 250, 2000);
    const start = Math.max(0, items.length - limit);
    return send(res, 200, {
      total: items.length,
      start,
      items: items.slice(start).map(({ msgId, id, ...rest }) => rest),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/state') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    const state = readState();
    const cur = state.convos[b.id] || {};
    for (const k of ['label', 'note']) if (typeof b[k] === 'string') cur[k] = b[k].slice(0, 500) || undefined;
    for (const k of ['pinned', 'archived']) if (typeof b[k] === 'boolean') cur[k] = b[k];
    if (typeof b.group === 'string') cur.group = state.groups.some((g) => g.id === b.group) ? b.group : undefined;
    state.convos[b.id] = cur;
    writeState(state);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/focus') {
    const b = await readBody(req);
    const live = t.listLive().find((l) => l.pid === Number(b.pid));
    if (!live) return send(res, 404, { error: 'That session is not running anymore.' });
    if (live.tty) {
      const r = await focusTty(live.tty);
      if (r.out === 'ok') return send(res, 200, { ok: true, how: 'terminal' });
      return send(res, 200, { ok: false, error: `It's running in ${live.tty}, but not in a Terminal.app tab I can find (maybe another terminal app).` });
    }
    if (live.entrypoint === 'claude-vscode') {
      execFile('open', ['-a', 'Visual Studio Code', live.cwd]);
      return send(res, 200, { ok: true, how: 'vscode' });
    }
    if (live.entrypoint === 'claude-desktop') {
      execFile('open', ['-a', 'Claude']);
      return send(res, 200, { ok: true, how: 'desktop' });
    }
    return send(res, 200, { ok: false, error: 'Not sure where this one lives.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const b = await readBody(req, 20e6);
    const m = String(b.dataUrl || '').match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
    if (!m) return send(res, 400, { error: 'only png, jpg, gif or webp images' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10e6) return send(res, 413, { error: 'image is over 10 MB' });
    fs.mkdirSync(UPLOADS, { recursive: true });
    const safe = String(b.name || 'image').replace(/\.[^.]*$/, '').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 40) || 'image';
    const file = path.join(UPLOADS, `${Date.now()}-${safe}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, buf);
    return send(res, 200, { ok: true, path: file });
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return send(res, 200, { skills: skills.listSkills() });
  }

  const briefMatch = url.pathname.match(/^\/api\/brief\/([0-9a-f-]{36})$/);
  if (req.method === 'GET' && briefMatch) {
    const meta = t.findTranscript(briefMatch[1]);
    if (!meta) return send(res, 404, { error: 'not found' });
    const s = readState().convos[meta.id] || {};
    return send(res, 200, { brief: skills.brief(meta, t.loadConvo(meta), { title: s.label, note: s.note }), cwd: meta.cwd });
  }

  if (req.method === 'POST' && url.pathname === '/api/groups') {
    const b = await readBody(req);
    const state = readState();
    const name = String(b.name || '').trim().slice(0, 40);
    if (b.action === 'create' && name) {
      const g = { id: Math.random().toString(36).slice(2, 10), name, color: b.color || null };
      state.groups.push(g);
      writeState(state);
      return send(res, 200, { ok: true, group: g });
    }
    const g = state.groups.find((x) => x.id === b.id);
    if (!g) return send(res, 404, { error: 'no such group' });
    if (b.action === 'rename' && name) g.name = name;
    if (b.action === 'delete') {
      state.groups = state.groups.filter((x) => x.id !== b.id);
      for (const c of Object.values(state.convos)) if (c.group === b.id) delete c.group;
    }
    writeState(state);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/start') {
    const b = await readBody(req);
    let cwd = String(b.cwd || process.env.HOME).replace(/^~(?=\/|$)/, process.env.HOME);
    let resumeId = null;
    if (b.resumeId) {
      if (!UUID.test(b.resumeId)) return send(res, 400, { error: 'bad id' });
      if (allLive().some((l) => l.sessionId === b.resumeId)) return send(res, 409, { error: 'This chat is still open somewhere else. Close it there first (or use Close session).' });
      const meta = t.findTranscript(b.resumeId);
      if (!meta) return send(res, 404, { error: 'not found' });
      resumeId = b.resumeId;
      cwd = meta.cwd;
    }
    if (!isDir(cwd)) return send(res, 400, { error: `Folder not found: ${cwd}` });
    try {
      const id = await hub.start({ cwd, prompt: String(b.prompt || '').trim(), resumeId, images: cleanImages(b.images) });
      { const st = readState(); st.convos[id] = { ...(st.convos[id] || {}), hub: true }; writeState(st); }
      if (b.group) {
        const state = readState();
        if (state.groups.some((g) => g.id === b.group)) { state.convos[id] = { ...(state.convos[id] || {}), group: b.group }; writeState(state); }
      }
      if (resumeId && resumeId !== id) {
        const state = readState();
        if (state.convos[resumeId]) { state.convos[id] = { ...state.convos[resumeId], ...state.convos[id] }; writeState(state); }
      }
      return send(res, 200, { ok: true, id });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    const images = cleanImages(b.images);
    if (!UUID.test(b.id || '') || (!text && !images.length)) return send(res, 400, { error: 'empty message' });
    try { hub.send(b.id, text, images); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    if (await hub.stop(b.id)) return send(res, 200, { ok: true });
    const live = t.listLive().find((l) => l.sessionId === b.id);
    if (!live) return send(res, 404, { error: 'It already stopped.' });
    try { process.kill(live.pid, 'SIGTERM'); } catch (e) { return send(res, 500, { error: e.message }); }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(live.pid, 0); } catch { return send(res, 200, { ok: true }); }
    }
    return send(res, 200, { ok: true, slow: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/resume') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    const meta = t.findTranscript(b.id);
    if (!meta) return send(res, 404, { error: 'not found' });
    if (allLive().some((l) => l.sessionId === b.id)) {
      return send(res, 409, { error: 'This one is already open somewhere. Use "Jump to it" instead.' });
    }
    const cwd = isDir(meta.cwd) ? meta.cwd : process.env.HOME;
    const r = await runInNewTerminal(`cd ${shq(cwd)} && claude --resume ${b.id}`);
    return send(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
  }

  if (req.method === 'POST' && url.pathname === '/api/new') {
    const b = await readBody(req);
    const cwd = String(b.cwd || process.env.HOME).replace(/^~(?=\/|$)/, process.env.HOME);
    if (!isDir(cwd)) return send(res, 400, { error: `Folder not found: ${cwd}` });
    const imgs = cleanImages(b.images);
    // terminal chats get image paths; Claude opens them with its Read tool
    const prompt = (String(b.prompt || '').trim() + (imgs.length ? `\nimgs: ${imgs.join(' ')}` : '')).trim();
    let arg = '';
    if (prompt) {
      // long / multi-line prompts go through a file so Terminal doesn't split them
      const dir = path.join(__dirname, 'data', 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${Date.now()}.txt`);
      fs.writeFileSync(f, prompt);
      arg = ` "$(cat ${shq(f)})"`;
    }
    const cmd = `cd ${shq(cwd)} && claude${arg}`;
    const r = await runInNewTerminal(cmd);
    return send(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
  }

  return send(res, 404, { error: 'no such endpoint' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error('[claw-hub]', e);
    send(res, 500, { error: e.message });
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { hub.stopAll(); process.exit(0); });

server.listen(PORT, '127.0.0.1', () => console.log(`[claw-hub] http://127.0.0.1:${PORT}`));
