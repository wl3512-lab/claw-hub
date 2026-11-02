'use strict';
// Chats that run *inside* Claw Hub. Each one is its own detached `claude -p` process
// reading stream-json from a named pipe and writing events to a file, so it keeps
// running when the hub server restarts; the server just reconnects to it.
// Claude writes the transcript itself, so the normal viewer shows the replies.

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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

function writeTo(chat, line) {
  // O_RDWR on a FIFO never blocks; claude holds the read end open
  const fd = fs.openSync(chat.fifo, fs.constants.O_RDWR);
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
}

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
  }
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
  fs.writeFileSync(path.join(DIR, `${chat.key}.json`), JSON.stringify({
    pid: chat.pid, cwd: chat.cwd, fifo: chat.fifo, out: chat.out, err: chat.err, startedAt: chat.startedAt, sessionId: chat.sessionId,
  }));
}

function cleanup(chat) {
  for (const f of [chat.fifo, chat.out, chat.err, path.join(DIR, `${chat.key}.json`)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

// Starts a chat (new, or continuing an old transcript). Resolves with the session id.
function start({ cwd, prompt, resumeId, images }) {
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
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (resumeId) args.push('--resume', resumeId);
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
          try { writeTo(chat, userLine(prompt, images)); } catch (e) { finish(e); }
        }
      }
      pump(chat);
      if (sent && chat.readyId) finish(null, chat.readyId);
      if (!alive(chat.pid)) {
        let tail = ''; try { tail = fs.readFileSync(chat.err, 'utf8').slice(-300); } catch { /* none */ }
        cleanup(chat);
        finish(new Error(`Claude stopped before starting. ${tail}`));
      } else if (Date.now() - began > 45000) finish(new Error('Claude took too long to start.'));
    }, 250);
    function finish(err, id) { if (done) return; done = true; clearInterval(watch); chat.onReady = null; err ? reject(err) : resolve(id); }
    chat.onReady = (id) => { if (sent) finish(null, id); else chat.readyId = id; };
  });
}

function send(sessionId, text, images) {
  const chat = chats.get(sessionId);
  if (!chat) throw new Error('That chat is not running in Claw Hub.');
  writeTo(chat, userLine(text, images));
  chat.status = 'busy'; chat.statusSince = Date.now(); chat.activity = 'thinking…'; chat.error = null;
}

// Resolves true once the process has really exited (false if we don't own it).
function stop(sessionId) {
  const chat = chats.get(sessionId);
  if (!chat) return Promise.resolve(false);
  chats.delete(sessionId);
  try { process.kill(chat.pid, 'SIGTERM'); } catch { /* already gone */ }
  return new Promise((resolve) => {
    let n = 0;
    const t = setInterval(() => {
      if (!alive(chat.pid) || ++n > 40) {
        clearInterval(t);
        if (alive(chat.pid)) { try { process.kill(chat.pid, 'SIGKILL'); } catch { /* gone */ } }
        cleanup(chat);
        resolve(true);
      }
    }, 100);
  });
}

function list() {
  return [...chats.values()].filter((c) => c.sessionId).map((c) => ({
    pid: c.pid, sessionId: c.sessionId, cwd: c.cwd, status: c.status, statusSince: c.statusSince,
    startedAt: c.startedAt, entrypoint: 'hub', activity: c.activity, error: c.error, tty: null,
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
    if (!r.sessionId || !alive(r.pid)) { cleanup(chat); continue; }
    chats.set(r.sessionId, chat);
    pump(chat); // replay its events to get the current status
  }
}

// keep every chat's status fresh; drop chats whose process died
setInterval(() => {
  for (const [id, chat] of chats) {
    pump(chat);
    if (!alive(chat.pid)) { chats.delete(id); cleanup(chat); }
  }
}, 700).unref();

recover();

module.exports = { start, send, stop, list, has: (id) => chats.has(id) };
