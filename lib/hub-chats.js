'use strict';
// Chats that run *inside* Claw Hub. Each one is its own detached `claude -p` process
// reading stream-json from a named pipe and writing events to a file, so it keeps
// running when the hub server restarts; the server just reconnects to it.
// Claude writes the transcript itself, so the normal viewer shows the replies.

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { writeJson } = require('./write-json');
const limits = require('./limits');

const CLAUDE_BIN = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  .find((p) => fs.existsSync(p)) || 'claude';
const DIR = path.join(__dirname, '..', 'data', 'hub');
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const chats = new Map(); // sessionId -> chat

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// images: absolute paths of files saved by /api/upload
function userLine(text, images = []) {
  const blocks = [];
  for (const p of images) {
    const media = MEDIA[path.extname(p).toLowerCase()];
    if (!media) continue;
    try { blocks.push({ type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(p).toString('base64') } }); } catch { /* skip missing */ }
  }
  const content = blocks.length ? [...blocks, { type: 'text', text: text || 'see image' }] : text;
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function summarize(block) {
  if (block.type === 'tool_use') {
    const i = block.input || {};
    const what = i.description || i.command || i.file_path || i.pattern || i.url || i.prompt || '';
    return `${block.name}${what ? ': ' + String(what).replace(/\s+/g, ' ').slice(0, 120) : ''}`;
  }
  if (block.type === 'text') return block.text.replace(/\s+/g, ' ').slice(0, 160);
  return null;
}

// Messages go out through a per-chat queue, written with non-blocking writes from timers.
// Two rules learned the hard way:
//  - never block the server waiting on a pipe (a blocking write froze every request), and
//  - never give up halfway through a line. A long-running chat with a huge history can
//    take well over 5 s to drain a big image message; abandoning it mid-line left half a
//    JSON line inside claude, which then crashed on (or swallowed) the next message.
// So a started line is always finished; slow chats just show "still delivering".
const SLOW_MS = 15000;
function enqueue(chat, line) {
  (chat.queue = chat.queue || []).push({ buf: Buffer.from(line), off: 0, since: Date.now() });
  flush(chat);
}
function flush(chat) {
  clearTimeout(chat.flushT); chat.flushT = null;
  const q = chat.queue || [];
  if (!q.length) return;
  if (chat.fd == null) {
    try {
      chat.fd = fs.openSync(chat.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      // ENXIO = nobody has the read end open: still starting up, or gone
      if (e.code === 'ENXIO' && alive(chat.pid)) { chat.flushT = setTimeout(() => flush(chat), 100); return; }
      chat.queue = [];
      chat.error = 'That chat is no longer running. Start a new one or resume it.';
      return;
    }
  }
  while (q.length) {
    const m = q[0];
    try {
      m.off += fs.writeSync(chat.fd, m.buf, m.off, m.buf.length - m.off);
    } catch (e) {
      if (e.code !== 'EAGAIN') { closeFd(chat); chat.queue = []; chat.error = `Could not deliver message: ${e.message}`; return; }
      if (Date.now() - m.since > SLOW_MS) chat.activity = 'still delivering your message (this chat is slow to read)…';
      chat.flushT = setTimeout(() => flush(chat), 25); // pipe full: let claude drain it
      return;
    }
    if (m.off >= m.buf.length) { q.shift(); chat.error = null; }
  }
  closeFd(chat);
}
function closeFd(chat) { if (chat.fd != null) { try { fs.closeSync(chat.fd); } catch { /* closed */ } chat.fd = null; } }

function handleEvent(chat, ev) {
  if (ev.session_id && !chat.sessionId) {
    chat.sessionId = ev.session_id;
    chats.set(chat.sessionId, chat);
    saveRegistry(chat);
    if (chat.onReady) chat.onReady(chat.sessionId);
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const last = ev.message.content.map(summarize).filter(Boolean).pop();
    if (last) chat.activity = last;
    chat.status = 'busy';
  } else if (ev.type === 'result') {
    chat.status = 'idle'; chat.statusSince = Date.now();
    chat.error = ev.is_error ? (ev.result || 'Something went wrong') : null;
    chat.asks = [];
  } else if (ev.type === 'rate_limit_event') {
    if (!chat.replaying) limits.note(ev.rate_limit_info); // old events replayed after a restart aren't news
  } else if (ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool') {
    // claude is waiting on us: a multiple-choice question, a plan, or a permission.
    // Several can arrive at once (parallel tool calls); they're answered in order.
    const r = ev.request;
    (chat.asks = chat.asks || []).push({ requestId: ev.request_id, tool: r.tool_name, input: r.input || {}, toolUseId: r.tool_use_id, at: Date.now() });
  } else if (ev.type === 'control_cancel_request' && chat.asks) {
    chat.asks = chat.asks.filter((a) => a.requestId !== ev.request_id);
  } else if (ev.type === 'user' && chat.asks && chat.asks.length && ev.message && Array.isArray(ev.message.content)) {
    // answered (shows up again when replaying after a restart)
    const done = new Set(ev.message.content.filter((p) => p.type === 'tool_result').map((p) => p.tool_use_id));
    chat.asks = chat.asks.filter((a) => !done.has(a.toolUseId));
  }
}
function pendingOf(chat) { return (chat.asks && chat.asks[0]) || null; }

// What the hub shows for a waiting request (kept small: a Write's file body isn't needed)
function pendingView(p) {
  if (!p) return null;
  const kind = p.tool === 'AskUserQuestion' ? 'ask' : p.tool === 'ExitPlanMode' ? 'plan' : 'perm';
  const v = { kind, tool: p.tool, at: p.at };
  if (kind === 'ask') v.questions = (p.input.questions || []).slice(0, 4);
  else if (kind === 'plan') v.plan = String(p.input.plan || '').slice(0, 20000);
  else v.summary = summarize({ type: 'tool_use', name: p.tool, input: p.input });
  return v;
}

// Answer the waiting request. ask: { answers: { [question]: label } }; plan/perm: { allow, message }
function answer(sessionId, a = {}) {
  const chat = chats.get(sessionId);
  if (!chat) throw new Error('That chat is not running in Claw Hub.');
  if (chat.stopping) throw new Error('This chat is closing. Wait for it to finish before resuming it.');
  const p = pendingOf(chat);
  if (!p) throw new Error('It already moved on. Nothing is waiting for an answer.');
  let response;
  if (p.tool === 'AskUserQuestion') {
    const answers = {};
    for (const q of p.input.questions || []) {
      const v = a.answers && a.answers[q.question];
      if (v == null || String(v).trim() === '') throw new Error('Pick an answer for every question.');
      answers[q.question] = String(v).slice(0, 4000);
    }
    response = { behavior: 'allow', updatedInput: { ...p.input, answers } };
  } else if (a.allow) {
    response = { behavior: 'allow', updatedInput: p.input };
  } else {
    response = { behavior: 'deny', message: String(a.message || 'The user said no.').slice(0, 4000) };
  }
  enqueue(chat, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response } }) + '\n');
  chat.asks.shift();
  if (!chat.asks.length) { chat.status = 'busy'; chat.statusSince = Date.now(); chat.activity = 'thinking…'; }
  chat.error = null;
}

// Typed text while a question is open answers it: "2" picks the 2nd option, anything else is a free answer
function textAnswer(p, text) {
  if (p.tool !== 'AskUserQuestion') {
    if (/^\s*(y|yes|yep|yeah|ok|okay|sure|go|approve|allow|do it)\b[\s.!]*$/i.test(text)) return { allow: true };
    return { allow: false, message: text };
  }
  const answers = {};
  for (const q of p.input.questions || []) {
    const opts = q.options || [];
    const n = /^\s*(\d+)\s*$/.exec(text);
    answers[q.question] = n && opts[+n[1] - 1] ? opts[+n[1] - 1].label : text;
  }
  return { answers };
}

// read new lines from the chat's event file
function pump(chat) {
  let size;
  try { size = fs.statSync(chat.out).size; } catch { return; }
  if (size <= chat.offset) return;
  const fd = fs.openSync(chat.out, 'r');
  try {
    const buf = Buffer.alloc(size - chat.offset);
    fs.readSync(fd, buf, 0, buf.length, chat.offset);
    chat.offset = size;
    chat.buf += buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  const lines = chat.buf.split('\n');
  chat.buf = lines.pop();
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(chat, ev);
  }
}

function saveRegistry(chat) {
  writeJson(path.join(DIR, `${chat.key}.json`), {
    pid: chat.pid, cwd: chat.cwd, fifo: chat.fifo, out: chat.out, err: chat.err, startedAt: chat.startedAt, sessionId: chat.sessionId,
  });
}

function cleanup(chat) {
  for (const f of [chat.fifo, chat.out, chat.err, path.join(DIR, `${chat.key}.json`)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

// Starts a chat (new, or continuing an old transcript). Resolves with the session id.
function start({ cwd, prompt, resumeId, fork, images }) {
  fs.mkdirSync(DIR, { recursive: true });
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const first = prompt || (images && images.length);
  const chat = {
    key, cwd, sessionId: null, status: first ? 'busy' : 'idle', startedAt: Date.now(), statusSince: Date.now(),
    activity: 'starting up…', error: null, buf: '', offset: 0,
    fifo: path.join(DIR, `${key}.in`), out: path.join(DIR, `${key}.out`), err: path.join(DIR, `${key}.err`),
  };
  execFileSync('mkfifo', [chat.fifo]);
  fs.writeFileSync(chat.out, '');
  // stdio permission prompts make claude ask the hub (AskUserQuestion is switched off in -p without it)
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
  if (resumeId) args.push('--resume', resumeId);
  if (resumeId && fork) args.push('--fork-session'); // new session id, same history
  // fd 3 opened read-write keeps the pipe from hitting EOF between messages
  const child = spawn('/bin/sh', ['-c', 'exec 3<>"$CH_FIFO"; exec "$CH_BIN" "$@" <&3 >>"$CH_OUT" 2>>"$CH_ERR"', 'sh', ...args], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
      CH_FIFO: chat.fifo, CH_OUT: chat.out, CH_ERR: chat.err, CH_BIN: CLAUDE_BIN,
    },
  });
  child.unref();
  chat.pid = child.pid;
  saveRegistry(chat);

  return new Promise((resolve, reject) => {
    let done = false;
    const began = Date.now();
    let sent = !first;
    const watch = setInterval(() => {
      // the shell has opened the pipe once claude prints anything; only then is it safe to write
      if (!sent) {
        let size = 0; try { size = fs.statSync(chat.out).size; } catch { /* not yet */ }
        if (size > 0 || Date.now() - began > 8000) {
          sent = true;
          enqueue(chat, userLine(prompt, images));
        }
      }
      pump(chat);
      if (sent && chat.readyId) finish(null, chat.readyId);
      if (!alive(chat.pid)) {
        let tail = ''; try { tail = fs.readFileSync(chat.err, 'utf8').slice(-300); } catch { /* none */ }
        cleanup(chat);
        finish(new Error(`Claude stopped before starting. ${tail}`));
      } else if (Date.now() - began > 45000) {
        if (!chat.sessionId) { try { process.kill(chat.pid, 'SIGTERM'); } catch { /* gone */ } cleanup(chat); }
        finish(new Error('Claude took too long to start.'));
      }
    }, 250);
    function finish(err, id) { if (done) return; done = true; clearInterval(watch); chat.onReady = null; err ? reject(err) : resolve(id); }
    chat.onReady = (id) => { if (sent) finish(null, id); else chat.readyId = id; };
  });
}

// opts.asAnswer: text typed while a question is open answers it (chat box, iMessage).
// Anything else (merge notes, job notes, /compact) must not be swallowed as an answer.
function send(sessionId, text, images, opts = {}) {
  const chat = chats.get(sessionId);
  if (!chat) throw new Error('That chat is not running in Claw Hub.');
  if (chat.stopping) throw new Error('This chat is closing. Wait for it to finish before resuming it.');
  if (!alive(chat.pid)) throw new Error('That chat is no longer running. Start a new one or resume it.');
  const p = pendingOf(chat);
  if (p) {
    if (opts.asAnswer && text) return answer(sessionId, textAnswer(p, text));
    throw new Error('It is waiting on your answer to its question. Answer that first.');
  }
  enqueue(chat, userLine(text, images));
  chat.status = 'busy'; chat.statusSince = Date.now(); chat.activity = 'thinking…'; chat.error = null;
}

// Resolves true once the process has really exited (false if we don't own it).
function stop(sessionId) {
  const chat = chats.get(sessionId);
  if (!chat) return Promise.resolve(false);
  if (chat.stopPromise) return chat.stopPromise;
  chat.stopping = true;
  clearTimeout(chat.flushT); chat.queue = []; closeFd(chat);
  // start() creates a detached process group. Signal that group so tools and
  // helper processes cannot keep working after their parent Claude exits.
  try { process.kill(-chat.pid, 'SIGTERM'); } catch (e) {
    if (e.code !== 'ESRCH') { chat.stopping = false; return Promise.reject(e); }
  }
  chat.stopPromise = new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (!alive(-chat.pid)) {
        clearInterval(t);
        chats.delete(sessionId);
        cleanup(chat);
        resolve(true);
      } else if (n === 40) {
        try { process.kill(-chat.pid, 'SIGKILL'); } catch { /* check again before claiming success */ }
      } else if (n >= 50) {
        clearInterval(t);
        chat.stopping = false; chat.stopPromise = null;
        reject(new Error('The chat still has running processes. Try closing it again.'));
      }
    }, 100);
  });
  return chat.stopPromise;
}

function list() {
  for (const chat of chats.values()) pump(chat);
  return [...chats.values()].filter((c) => c.sessionId).map((c) => ({
    // waiting on an answer counts as your turn, not busy
    pid: c.pid, sessionId: c.sessionId, cwd: c.cwd, status: c.stopping ? 'busy' : pendingOf(c) ? 'idle' : c.status, statusSince: pendingOf(c) ? pendingOf(c).at : c.statusSince,
    startedAt: c.startedAt, entrypoint: 'hub', activity: c.activity, error: c.error, tty: null, pending: pendingView(pendingOf(c)), queued: (c.queue || []).length, stopping: !!c.stopping,
  }));
}

// After a server restart: reconnect to chats that are still running.
function recover() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    const chat = { ...r, key: f.replace(/\.json$/, ''), buf: '', offset: 0, status: 'idle', statusSince: Date.now(), activity: '', error: null };
    if (!alive(r.pid)) { cleanup(chat); continue; }
    chat.replaying = true;
    pump(chat); // replay its events to get the current status (and its id, if it got one after the last save)
    chat.replaying = false;
    if (!chat.sessionId) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } cleanup(chat); continue; }
    chats.set(chat.sessionId, chat);
  }
}

// keep every chat's status fresh; drop chats whose process died
setInterval(() => {
  for (const [id, chat] of chats) {
    if (chat.stopping) continue;
    try { pump(chat); } catch (e) { console.error('[claw-hub] pump', e.message); }
    if (!alive(chat.pid)) { chats.delete(id); clearTimeout(chat.flushT); closeFd(chat); cleanup(chat); }
  }
}, 700).unref();

recover();

module.exports = { start, send, answer, stop, list, has: (id) => chats.has(id), _enqueue: enqueue };
