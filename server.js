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
const jobs = require('./lib/jobs');
const logbook = require('./lib/logbook');
const imsg = require('./lib/imessage');
const purpose = require('./lib/purpose');
const work = require('./lib/work');
const limits = require('./lib/limits');
const sessionPolicy = require('./lib/session-policy');
const { writeJson } = require('./lib/write-json');

// Node exits on any unhandled error. A background timer hiccup (a session file vanishing
// mid-read, Messages timing out) should be logged, not take the whole hub down.
process.on('unhandledRejection', (e) => console.error('[claw-hub] unhandled', e));
process.on('uncaughtException', (e) => console.error('[claw-hub] uncaught', e));

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

// Baby crabs hatched after this moment stay until you open them (see helpersOf).
let babySince = readState().babySince;
if (!babySince) { const s = readState(); babySince = s.babySince = Date.now(); writeState(s); }
function helpersOf(meta, state) {
  const seen = new Set((state.convos[meta.id] || {}).seenBabies || []);
  return t.helpers(meta, { seen, since: babySince });
}
function markBabySeen(sid, agentId) {
  const s = readState();
  const cur = s.convos[sid] || {};
  const list = cur.seenBabies || [];
  if (list.includes(agentId)) return;
  cur.seenBabies = list.concat(agentId).slice(-300);
  s.convos[sid] = cur;
  writeState(s);
}
function writeState(s) { writeJson(STATE_FILE, s, 2); }

// ---------- helpers ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
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

// ---------- hub chats + jobs ----------
const expandHome = (p) => String(p || process.env.HOME).replace(/^~(?=\/|$)/, process.env.HOME);

// start a new hub chat and record its project / labels
async function startHubChat({ cwd, prompt, group, images, label }) {
  const id = await hub.start({ cwd, prompt, images });
  const st = readState();
  const cur = { ...(st.convos[id] || {}), hub: true };
  if (group && st.groups.some((g) => g.id === group)) cur.group = group;
  if (label) cur.label = label;
  st.convos[id] = cur;
  writeState(st);
  return id;
}

async function runJob(j, scheduled) {
  const cwd = expandHome(j.cwd);
  if (!isDir(cwd)) { jobs.update(j.id, { status: 'todo', error: `folder not found: ${j.cwd}` }); return null; }
  const id = await startHubChat({ cwd, prompt: jobs.promptFor(j), group: j.group, label: `${scheduled ? '⏰ ' : ''}${j.title}` });
  jobs.markRun(j.id, id, scheduled);
  jobs.update(j.id, { error: null });
  return id;
}

const jobBusy = new Set(); // job ids being started right now
async function jobTick() {
  const list = jobs.load();
  const live = allLive();
  const state = readState();
  const now = new Date();
  for (const j of list) {
    if (jobBusy.has(j.id)) continue;
    // finished runs: the run's chat went idle (or closed) after it started
    if (j.status === 'running' && j.sessionId) {
      const l = live.find((x) => x.sessionId === j.sessionId);
      const run = (j.runs || []).slice(-1)[0] || {};
      if (!l || (l.status === 'idle' && !l.pending && (l.statusSince || 0) > (run.at || 0) + 1500)) {
        jobs.update(j.id, { status: j.schedule ? 'todo' : 'done', doneAt: Date.now() });
        if (run.scheduled && l && l.entrypoint === 'hub') hub.stop(j.sessionId); // keep the transcript, free the process
      }
      continue;
    }
    // scheduled
    if (j.schedule) {
      const due = jobs.lastDue(j.schedule, now);
      if (due && due > (j.lastDueRun || 0) && Date.now() - due < 6 * 3600 * 1000) {
        jobs.update(j.id, { lastDueRun: due });
        jobBusy.add(j.id);
        runJob(j, true).catch((e) => jobs.update(j.id, { error: e.message })).finally(() => jobBusy.delete(j.id));
        continue;
      }
    }
    // queued: start when its project has no working crab
    if (j.queue && j.status === 'todo') {
      const busyHere = live.some((l) => l.status === 'busy' && (!j.group || (state.convos[l.sessionId] || {}).group === j.group));
      if (!busyHere) {
        jobBusy.add(j.id);
        runJob(j, false).catch((e) => jobs.update(j.id, { error: e.message })).finally(() => jobBusy.delete(j.id));
      }
    }
  }
}
setInterval(() => { jobTick().catch((e) => console.error('[claw-hub] jobs', e)); }, 30000);

// logbook: today's page is cached for 2 min; the nightly copy is written at 23:30
let todayBook = null;
function logbookFor(day, fresh) {
  const today = logbook.dayKey(Date.now());
  if (day === today && !fresh && todayBook && Date.now() - todayBook.builtAt < 120000) return todayBook;
  const book = logbook.get(day, readState(), allLive(), { fresh });
  if (day === today) todayBook = book;
  return book;
}
// ---------- iMessage pings + replies ----------
function titleOf(sid) {
  const s = readState().convos[sid] || {};
  const m = t.findTranscript(sid);
  return s.label || (m && (m.customTitle || m.aiTitle || (m.firstPrompt || '').slice(0, 50))) || 'a crab';
}
const lastStatus = new Map();
setInterval(() => { pingTick().catch((e) => console.error('[claw-hub] imessage ping', e.message)); }, 4000);
async function pingTick() {
  const cfg = imsg.config();
  if (!cfg.enabled || !cfg.handle) return;
  for (const l of allLive()) {
    const before = lastStatus.get(l.sessionId);
    lastStatus.set(l.sessionId, l.status);
    if (before !== 'busy' || l.status !== 'idle') continue;
    const meta = t.findTranscript(l.sessionId);
    if (!meta || (meta.bot && !(readState().convos[l.sessionId] || {}).hub)) continue;
    const a = t.activity(meta) || {};
    const asking = !!a.asking || !!l.pending;
    if ((asking && !cfg.onAsk) || (!asking && !cfg.onDone)) continue;
    if (cfg.onlyAway && imsg.idleSeconds() < 120) continue;
    const n = imsg.numFor(l.sessionId);
    let said = String(a.text || '').replace(/\s+/g, ' ').slice(0, 140);
    const q = l.pending && l.pending.kind === 'ask' && l.pending.questions[0];
    if (q) said = `${q.question.slice(0, 140)}\n${(q.options || []).map((o, i) => `${i + 1}) ${o.label}`).join('\n')}`;
    else if (l.pending) said = l.pending.kind === 'plan' ? 'approve this plan? (yes / or say what to change)' : `ok to ${l.pending.summary}? (yes / no)`;
    try {
      await imsg.send(`${imsg.TAG} #${n} ${titleOf(l.sessionId)} ${asking ? 'asks' : 'is done'}: ${said}\n(reply here, or "#${n} …")`);
      imsg.saveConfig({ last: l.sessionId });
    } catch (e) { console.error('[claw-hub] imessage', e.message); }
  }
}

setInterval(() => { replyTick().catch((e) => console.error('[claw-hub] imessage reply', e.message)); }, 5000);
async function replyTick() {
  const cfg = imsg.config();
  if (!cfg.enabled || !cfg.handle) return;
  let replies = [];
  try { replies = imsg.newReplies(); } catch (e) { console.error('[claw-hub] imessage read', e.message); return; }
  for (const raw of replies) {
    const { num, text } = imsg.parseReply(raw);
    const sid = num ? imsg.sessionForNum(num) : cfg.last;
    const n = sid && imsg.numFor(sid);
    try {
      if (!sid) { await imsg.send(`${imsg.TAG} which crab is that for? start with #number`); continue; }
      if (hub.has(sid)) { hub.send(sid, text, [], { asAnswer: true }); await imsg.send(`${imsg.TAG} sent to #${n} ${titleOf(sid)}`); continue; }
      const live = t.listLive().find((l) => l.sessionId === sid);
      if (live) { await imsg.send(`${imsg.TAG} #${n} is open in ${live.entrypoint === 'claude-vscode' ? 'VS Code' : live.entrypoint === 'claude-desktop' ? 'the Claude app' : 'Terminal'}, answer it there`); continue; }
      const meta = t.findTranscript(sid);
      if (!meta || !isDir(meta.cwd)) { await imsg.send(`${imsg.TAG} couldn't find #${n} anymore`); continue; }
      await hub.start({ cwd: meta.cwd, prompt: text, resumeId: sid });
      { const st = readState(); st.convos[sid] = { ...(st.convos[sid] || {}), hub: true }; writeState(st); }
      await imsg.send(`${imsg.TAG} woke #${n} ${titleOf(sid)} in the hub and sent it`);
    } catch (e) { console.error('[claw-hub] imessage route', e.message); }
  }
}

let nightlyDone = '';
setInterval(() => {
  const now = new Date();
  const key = logbook.dayKey(now);
  if (now.getHours() === 23 && now.getMinutes() >= 30 && nightlyDone !== key) {
    nightlyDone = key;
    try { logbookFor(key, true); } catch (e) { console.error('[claw-hub] logbook', e); }
  }
}, 60000);
setTimeout(() => jobTick().catch(() => {}), 5000);

// ---------- API ----------
function allLive() {
  const mine = hub.list().filter((h) => h.sessionId);
  const seen = new Set(mine.map((h) => h.sessionId));
  return mine.concat(t.listLive().filter((l) => !seen.has(l.sessionId)));
}

function liveInfo(live, meta, state) {
  const info = { pid: live.pid, status: live.status, statusSince: live.statusSince, entrypoint: live.entrypoint, tty: live.tty, phone: !!live.phone };
  if (meta) {
    info.activity = t.activity(meta);
    // babies that went quiet before this process started died with an earlier one
    // (unless they're new-rule babies, which wait to be opened)
    info.helpers = helpersOf(meta, state || readState()).map((h) => (h.status === 'done' || !live.startedAt || h.lastAt >= live.startedAt - 5000
      ? h : h.sticky ? { ...h, status: 'stuck', orphan: true } : null)).filter(Boolean);
  }
  if (live.entrypoint === 'hub') {
    info.inHub = true;
    if (live.error) info.error = live.error;
    if (!info.activity || live.status === 'busy') info.activity = { kind: 'say', text: live.activity };
    if (live.pending) {
      info.pending = live.pending;
      const q = live.pending.questions && live.pending.questions[0];
      info.activity = { ...(info.activity || {}), kind: 'tool', tool: live.pending.tool, asking: true,
        text: q ? q.question : live.pending.kind === 'plan' ? 'has a plan for you' : `wants to ${live.pending.summary}` };
    }
  }
  info.cleanupEligible = !!meta && (!meta.bot || live.entrypoint === 'hub')
    && sessionPolicy.canClose(live, t.activity(meta), t.helpers(meta, { since: live.startedAt || 0 }));
  return info;
}

function convoSummary(m, state, liveBySession) {
  const s = state.convos[m.id] || {};
  const live = liveBySession.get(m.id);
  const isBot = m.bot && !s.hub;
  // babies only exist for chats touched since the new rule started
  const babies = !live && !isBot && m.updatedAt >= babySince ? helpersOf(m, state) : [];
  const recent = Date.now() - m.updatedAt < 3 * 3600 * 1000;
  return {
    id: m.id,
    title: s.label || m.customTitle || m.aiTitle || (m.firstPrompt || '').slice(0, 80) || 'Untitled',
    autoTitle: m.customTitle || m.aiTitle || null,
    label: s.label || null,
    pinned: !!s.pinned,
    archived: !!s.archived,
    note: s.note || '',
    group: s.group || null,
    hue: Number.isInteger(s.hue) ? s.hue : null,
    shell: s.shell || null,
    cwd: m.cwd,
    firstPrompt: m.firstPrompt,
    lastPrompt: m.lastPrompt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    entrypoint: m.entrypoint,
    bot: m.bot && !s.hub,
    size: m.size,
    live: live ? liveInfo(live, m, state) : null,
    // VS Code and the Claude app stop an idle chat's process and restart it on your next message:
    // show recently active chats with no process as "parked". A chat with babies you
    // haven't opened yet stays parked too, so its babies stay on the beach.
    parked: !live && !isBot && (recent || babies.some((h) => h.sticky))
      ? {
        where: s.hub ? 'hub' : m.phone ? 'phone' : m.entrypoint || 'cli', since: m.updatedAt, activity: t.activity(m),
        // its babies died with its process unless they had already finished
        helpers: (recent ? babies.length ? babies : helpersOf(m, state) : babies.filter((h) => h.sticky))
          .map((h) => (h.status === 'done' ? h : { ...h, status: 'stuck', orphan: true })),
      } : null,
  };
}

// ---------- merging two crabs that do the same job ----------
const pairKey = (a, b) => [a, b].sort().join('|');
function titleFor(meta, st) { return (st && st.label) || meta.customTitle || meta.aiTitle || (meta.firstPrompt || '').slice(0, 60) || 'a chat'; }

// the asks and the last reply of a chat, for the purpose summary and for merge handoffs
function crabDetail(id) {
  const meta = t.findTranscript(id);
  if (!meta) return {};
  const items = t.loadConvo(meta);
  const recent = items.filter((i) => i.kind === 'user').slice(-5).map((i) => i.text);
  const reply = [...items].reverse().find((i) => i.kind === 'assistant');
  return { recent, lastReply: reply ? reply.text : '' };
}

function handoffFrom(meta, st) {
  const items = t.loadConvo(meta);
  const asks = items.filter((i) => i.kind === 'user').map((i) => i.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pick = asks.length > 8 ? [asks[0], '…', ...asks.slice(-7)] : asks;
  const reply = [...items].reverse().find((i) => i.kind === 'assistant');
  const files = [...new Set(items.filter((i) => i.kind === 'tool' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(i.name) && i.summary).map((i) => i.summary.replace(process.env.HOME, '~')))].slice(-15);
  const cut = (x, n) => (x.length > n ? x.slice(0, n - 1) + '…' : x);
  return [
    `(Merged in from another chat. Lucy had two chats doing overlapping work and merged "${titleFor(meta, st)}" into this one, so that chat is now closed. `
      + `Below is what it covered. Take it on as your own context: don't redo finished work, and don't start anything new yet. `
      + `Reply with two or three short lines: what you picked up from it, and what's still open across both chats.)`,
    '',
    `Folder: ${String(meta.cwd || '').replace(process.env.HOME, '~')}`,
    purpose.get(meta.id) ? `What it was for: ${purpose.get(meta.id)}` : '',
    '',
    'What she asked there, in order:',
    ...pick.map((a) => (a === '…' ? '- …' : `- ${cut(a, 400)}`)),
    '',
    reply ? `Where it left off (its last reply):\n${cut(reply.text, 2500)}` : 'It never replied.',
    files.length ? `\nFiles it edited:\n${files.map((f) => `- ${f}`).join('\n')}` : '',
  ].filter((x) => x !== '').join('\n');
}

async function stopSession(id, guard) {
  const live = (hub.has(id) ? hub.list() : t.listLive()).find((l) => l.sessionId === id);
  if (!live) return false;
  if (guard) {
    const meta = t.findTranscript(id);
    const minutes = [15, 30, 60].includes(guard.idleMinutes) ? guard.idleMinutes : 30;
    if (guard.pid !== live.pid || guard.statusSince !== live.statusSince || !meta
      || !sessionPolicy.canClose(live, t.activity(meta), t.helpers(meta, { since: live.startedAt || 0 }), Date.now(), minutes)) {
      throw new Error('This session changed or is still needed. Refresh before tidying it.');
    }
  }
  if (hub.has(id)) return hub.stop(id);
  if (!live.verifiedProcess) throw new Error('This process could not be verified as Claude. Close it in its terminal.');
  try { process.kill(live.pid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return true; throw e; }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(live.pid, 0); } catch { return true; }
  }
  throw new Error('It did not close in time. Close it by hand and try again.');
}

let cleaning = false;
async function cleanupTick() {
  const { idleMinutes } = sessionPolicy.config();
  if (!idleMinutes || cleaning) return;
  cleaning = true;
  try {
    for (const live of allLive()) {
      if (sessionPolicy.config().idleMinutes !== idleMinutes) break;
      const meta = t.findTranscript(live.sessionId);
      if (!meta || (meta.bot && live.entrypoint !== 'hub')) continue;
      if (!sessionPolicy.canClose(live, t.activity(meta), t.helpers(meta, { since: live.startedAt || 0 }), Date.now(), idleMinutes)) continue;
      try { await stopSession(live.sessionId, { pid: live.pid, statusSince: live.statusSince, idleMinutes }); }
      catch (e) { console.error('[claw-hub] cleanup', e.message); }
    }
  } finally { cleaning = false; }
}
setInterval(() => cleanupTick().catch((e) => console.error('[claw-hub] cleanup', e.message)), 30000);

const merging = new Set(); // chat ids in a merge right now (a double click shouldn't merge twice)

async function mergeCrabs(res, keep, drop) {
  const keepMeta = t.findTranscript(keep);
  const dropMeta = t.findTranscript(drop);
  if (!keepMeta || !dropMeta) return send(res, 404, { error: 'one of those chats is gone' });
  const live = allLive();
  const liveOf = (id) => live.find((l) => l.sessionId === id);
  for (const id of [keep, drop]) if (liveOf(id) && liveOf(id).status === 'busy') return send(res, 409, { error: 'one of them is still working. merge once both are waiting for you.' });
  for (const id of [keep, drop]) if (liveOf(id) && liveOf(id).pending) return send(res, 409, { error: 'one of them asked you something. answer it first, then merge.' });
  if (!liveOf(keep) && !isDir(keepMeta.cwd)) return send(res, 400, { error: `Folder not found: ${keepMeta.cwd}` });
  const text = handoffFrom(dropMeta, readState().convos[drop]);

  // 1. hand the notes to the one we keep (moving it into the hub if it's open elsewhere)
  let keepId = keep;
  try {
    if (hub.has(keep) && liveOf(keep)) hub.send(keep, text);
    else {
      if (!isDir(keepMeta.cwd)) return send(res, 400, { error: `Folder not found: ${keepMeta.cwd}` });
      if (liveOf(keep)) await stopSession(keep);
      keepId = await hub.start({ cwd: keepMeta.cwd, prompt: text, resumeId: keep });
    }
  } catch (e) { return send(res, 500, { error: `Couldn't hand over the notes: ${e.message}. Both chats are still saved in chats.` }); }
  { const st = readState(); st.convos[keepId] = { ...(st.convos[keep] || {}), ...(st.convos[keepId] || {}), hub: true }; writeState(st); }

  // 2. close and file away the other one (only once it really closed)
  try { await stopSession(drop); } catch (e) {
    return send(res, 500, { error: `Merged, but the other chat didn't close: ${e.message}` });
  }
  const st = readState();
  st.convos[drop] = { ...(st.convos[drop] || {}), archived: true, mergedInto: keepId };
  writeState(st);
  return send(res, 200, { ok: true, id: keepId });
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
    // what each open crab is for, and which ones look like the same job
    const open = convos.filter((c) => !c.bot && !c.archived && (c.live || c.parked));
    // display name: your own rename wins, then the crab's nickname, then its title
    for (const c of convos) {
      c.purpose = purpose.get(c.id);
      const own = (state.convos[c.id] || {}).label;
      c.name = own || purpose.name(c.id) || c.title;
    }
    if (sessionPolicy.config().aiSummaries) {
      try { purpose.refresh(open.map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, firstPrompt: c.firstPrompt, lastPrompt: c.lastPrompt })), crabDetail); } catch (e) { console.error('[purpose] refresh failed:', e.message); }
    }
    // files, last-hour activity and output today for each open crab, plus files two crabs both edited
    const works = [];
    for (const c of open) {
      const meta = t.findTranscript(c.id);
      let w = null;
      try { w = meta && work.workOf(meta); } catch (e) { console.error('[work]', e.message); }
      if (!w) continue;
      // a side chat starts with a copy of its parent's history: only count its own edits
      const sideAt = (state.convos[c.id] || {}).sideAt;
      if (sideAt) w = { ...w, files: w.files.filter((f) => f.ts >= sideAt) };
      c.work = w;
      works.push([c.id, w]);
    }
    const clashes = work.clashes(works);
    const dismissed = new Set(state.mergeDismissed || []);
    const overlaps = purpose.overlaps(open.map((c) => c.id)).filter((o) => !dismissed.has(pairKey(o.a, o.b)));
    // live sessions that haven't written a transcript yet
    const orphanLive = live.filter((l) => !known.has(l.sessionId) && !purpose.isOurs(l.pid, l.cwd)).map((l) => ({
      id: l.sessionId, title: 'New session (nothing typed yet)', cwd: l.cwd, updatedAt: l.statusSince,
      live: liveInfo(l, null),
      pinned: false, archived: false, bot: false, empty: true,
    }));
    return send(res, 200, { convos: orphanLive.concat(convos), groups: state.groups, overlaps, clashes, limits: limits.get(), now: Date.now() });
  }

  const subMatch = url.pathname.match(/^\/api\/sub\/([0-9a-f-]{36})\/(agent-[a-z0-9]+)$/);
  if (req.method === 'GET' && subMatch) {
    const meta = t.findTranscript(subMatch[1]);
    const sub = meta && t.subMeta(meta, subMatch[2]);
    if (!sub) return send(res, 404, { error: 'not found' });
    const items = t.loadConvo(sub);
    // you opened a finished baby and saw its work: now it can go home
    const h = t.helpers(meta, { since: 0 }).find((x) => x.id === subMatch[2]);
    const finished = sub.finished || (h ? h.status === 'done' : items.length && items[items.length - 1].kind === 'assistant');
    if (finished) markBabySeen(meta.id, subMatch[2]);
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
    if (b.hue === null) delete cur.hue; else if (Number.isInteger(b.hue) && b.hue >= 0 && b.hue < 360) cur.hue = b.hue;
    if (b.shell === null) delete cur.shell; else if (['spiral', 'conch', 'moon', 'tower'].includes(b.shell)) cur.shell = b.shell;
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
    if (live.phone) {
      // phone sessions live on claude.ai/code; open this Mac's Remote Control environment there
      let env = null;
      try { env = (fs.readFileSync(path.join(process.env.HOME, 'Library/Logs/claw-phone.log'), 'utf8').match(/environment=(env_[A-Za-z0-9]+)/g) || []).pop(); } catch { /* no log */ }
      execFile('open', [env ? `https://claude.ai/code?${env}` : 'https://claude.ai/code']);
      return send(res, 200, { ok: true, how: 'phone' });
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

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const c = imsg.config();
    return send(res, 200, { sessions: sessionPolicy.config(), imessage: { handle: c.handle, enabled: c.enabled, onAsk: c.onAsk, onDone: c.onDone, onlyAway: c.onlyAway }, canRead: imsg.canRead(), node: process.execPath });
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const b = await readBody(req);
    if ('sessions' in b) {
      try { sessionPolicy.save(b.sessions); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    const i = b.imessage || {};
    const patch = {};
    if (typeof i.handle === 'string') patch.handle = i.handle.trim().slice(0, 120);
    for (const k of ['enabled', 'onAsk', 'onDone', 'onlyAway']) if (typeof i[k] === 'boolean') patch[k] = i[k];
    imsg.saveConfig(patch);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/imessage/test') {
    try { await imsg.send(`${imsg.TAG} hi from claw hub. crabs will text you here when they finish or ask you something.`); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/logbook') {
    return send(res, 200, { days: logbook.days() });
  }
  const logMatch = url.pathname.match(/^\/api\/logbook\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === 'GET' && logMatch) {
    return send(res, 200, logbookFor(logMatch[1], url.searchParams.get('fresh') === '1'));
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const now = new Date();
    return send(res, 200, { jobs: jobs.load().map((j) => ({ ...j, scheduleText: jobs.scheduleText(j.schedule), nextRun: j.schedule ? jobs.nextDue(j.schedule, now) : null })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const b = await readBody(req, 2e6);
    return send(res, 200, { ok: true, job: jobs.upsert(b) });
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs/delete') {
    const b = await readBody(req);
    jobs.remove(String(b.id || ''));
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs/run') {
    const b = await readBody(req);
    const j = jobs.load().find((x) => x.id === b.id);
    if (!j) return send(res, 404, { error: 'no such job' });
    if (b.target) {
      // hand the note to an existing crab
      if (!UUID.test(b.target)) return send(res, 400, { error: 'bad target' });
      const prompt = jobs.promptFor(j);
      if (hub.has(b.target)) {
        try { hub.send(b.target, prompt); } catch (e) { return send(res, 409, { error: e.message }); }
        jobs.markRun(j.id, b.target, false);
        return send(res, 200, { ok: true, id: b.target, how: 'sent' });
      }
      const live = t.listLive().find((l) => l.sessionId === b.target);
      jobs.markRun(j.id, b.target, false);
      return send(res, 200, { ok: true, id: b.target, how: 'copy', prompt, pid: live && live.pid });
    }
    try {
      jobBusy.add(j.id);
      const id = await runJob(j, false);
      if (!id) return send(res, 400, { error: `folder not found: ${j.cwd}` });
      return send(res, 200, { ok: true, id, how: 'new' });
    } catch (e) { return send(res, 500, { error: e.message }); } finally { jobBusy.delete(j.id); }
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

  // Side chat: a copy of a chat (same history, same folder, same files) that works on
  // something else at the same time. The original keeps going untouched.
  if (req.method === 'POST' && url.pathname === '/api/chat/side') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    const task = String(b.prompt || '').trim();
    if (!task) return send(res, 400, { error: 'say what the side chat should do' });
    const meta = t.findTranscript(b.id);
    if (!meta || meta.empty) return send(res, 404, { error: 'nothing to copy yet. type something in this chat first.' });
    if (!isDir(meta.cwd)) return send(res, 400, { error: `Folder not found: ${meta.cwd}` });
    const st0 = readState();
    const parent = st0.convos[b.id] || {};
    const parentTitle = parent.label || meta.customTitle || meta.aiTitle || (meta.firstPrompt || '').slice(0, 50) || 'a chat';
    const prompt = `(side chat: you're a copy of this conversation running alongside the original, which keeps working. `
      + `Same folder and files. Do only the task below. Don't touch files the original is in the middle of editing unless the task needs it.)\n\n${task}`;
    try {
      const id = await hub.start({ cwd: meta.cwd, prompt, resumeId: b.id, fork: true, images: cleanImages(b.images) });
      if (id === b.id) throw new Error('Claude reused the same session instead of copying it.');
      const st = readState();
      st.convos[id] = {
        ...(st.convos[id] || {}), hub: true, sideOf: b.id, sideAt: Date.now(),
        label: `↳ ${task.replace(/\s+/g, ' ').slice(0, 40)}`,
        group: parent.group, hue: parent.hue, shell: parent.shell,
      };
      writeState(st);
      return send(res, 200, { ok: true, id, parentTitle });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/merge/dismiss') {
    const b = await readBody(req);
    if (!UUID.test(b.a || '') || !UUID.test(b.b || '')) return send(res, 400, { error: 'bad id' });
    const st = readState();
    st.mergeDismissed = [...new Set([...(st.mergeDismissed || []), pairKey(b.a, b.b)])].slice(-200);
    writeState(st);
    return send(res, 200, { ok: true });
  }

  // Merge: "drop" hands its context (asks, last reply, files) to "keep", then closes and gets filed away.
  // keep has to be running in the hub to receive it, so a keep open in Terminal/VS Code moves here.
  if (req.method === 'POST' && url.pathname === '/api/merge') {
    const b = await readBody(req);
    if (!UUID.test(b.keep || '') || !UUID.test(b.drop || '') || b.keep === b.drop) return send(res, 400, { error: 'bad id' });
    if (merging.has(b.keep) || merging.has(b.drop)) return send(res, 409, { error: 'already merging those two.' });
    merging.add(b.keep); merging.add(b.drop);
    try { return await mergeCrabs(res, b.keep, b.drop); } finally { merging.delete(b.keep); merging.delete(b.drop); }
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    const images = cleanImages(b.images);
    if (!UUID.test(b.id || '') || (!text && !images.length)) return send(res, 400, { error: 'empty message' });
    try { hub.send(b.id, text, images, { asAnswer: !!b.asAnswer }); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/chat/answer') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    const answers = b.answers && typeof b.answers === 'object' ? b.answers : null;
    try { hub.answer(b.id, { answers, allow: !!b.allow, message: b.message }); return send(res, 200, { ok: true }); } catch (e) { return send(res, 409, { error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const b = await readBody(req);
    if (!UUID.test(b.id || '')) return send(res, 400, { error: 'bad id' });
    try {
      const stopped = await stopSession(b.id, b.idleOnly ? b : null);
      return send(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'It already stopped.' });
    } catch (e) { return send(res, 409, { error: e.message }); }
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
    // PUBLIC + sep, so a sibling folder like ../public-old can't slip through
    let isFile = false; try { isFile = fs.statSync(file).isFile(); } catch { /* missing */ }
    if (!file.startsWith(PUBLIC + path.sep) || !isFile) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error('[claw-hub]', e);
    send(res, 500, { error: e.message });
  }
});

// in-hub chats are detached and keep running; a restarted server reconnects to them
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

server.listen(PORT, '127.0.0.1', () => console.log(`[claw-hub] http://127.0.0.1:${PORT}`));
