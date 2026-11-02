'use strict';
// Chats that run *inside* Claw Hub: we start `claude -p` in stream-json mode
// and keep its stdin open, so each message you type is one more turn.
// Claude writes the transcript itself, so the normal viewer shows the replies.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLAUDE_BIN = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  .find((p) => fs.existsSync(p)) || 'claude';

const chats = new Map(); // sessionId -> chat

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

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

// Starts a chat (new, or continuing an old transcript). Resolves with the session id.
function start({ cwd, prompt, resumeId, images }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (resumeId) args.push('--resume', resumeId);
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chat = {
      pid: child.pid, child, cwd, sessionId: null, status: 'busy', startedAt: Date.now(),
      statusSince: Date.now(), activity: 'starting up…', error: null, buf: '', stderr: '',
    };
    let settled = false;
    const done = (err, id) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(id); };
    const timer = setTimeout(() => done(new Error('Claude took too long to start.')), 45000);

    child.stdout.on('data', (d) => {
      chat.buf += d.toString('utf8');
      const lines = chat.buf.split('\n');
      chat.buf = lines.pop();
      for (const line of lines) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id && !chat.sessionId) {
          chat.sessionId = ev.session_id;
          chats.set(chat.sessionId, chat);
          done(null, chat.sessionId);
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          const last = ev.message.content.map(summarize).filter(Boolean).pop();
          if (last) chat.activity = last;
        } else if (ev.type === 'result') {
          chat.status = 'idle'; chat.statusSince = Date.now();
          chat.error = ev.is_error ? (ev.result || 'Something went wrong') : null;
        }
      }
    });
    child.stderr.on('data', (d) => { chat.stderr = (chat.stderr + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => done(e));
    child.on('exit', (code) => {
      if (chat.sessionId) chats.delete(chat.sessionId);
      done(new Error(`Claude stopped before starting (code ${code}). ${chat.stderr.slice(-300)}`));
    });

    if (prompt || (images && images.length)) child.stdin.write(userLine(prompt, images));
    else chat.status = 'idle';
  });
}

function send(sessionId, text, images) {
  const chat = chats.get(sessionId);
  if (!chat) throw new Error('That chat is not running in Claw Hub.');
  chat.child.stdin.write(userLine(text, images));
  chat.status = 'busy'; chat.statusSince = Date.now(); chat.activity = 'thinking…'; chat.error = null;
}

// Resolves true once the process has really exited (false if we don't own it).
function stop(sessionId) {
  const chat = chats.get(sessionId);
  if (!chat) return Promise.resolve(false);
  chats.delete(sessionId);
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { chat.child.kill('SIGKILL'); } catch { /* gone */ } resolve(true); }, 4000);
    chat.child.once('exit', () => { clearTimeout(t); resolve(true); });
    chat.child.stdin.end();
    chat.child.kill('SIGTERM');
  });
}

function list() {
  return [...chats.values()].map((c) => ({
    pid: c.pid, sessionId: c.sessionId, cwd: c.cwd, status: c.status, statusSince: c.statusSince,
    startedAt: c.startedAt, entrypoint: 'hub', activity: c.activity, error: c.error, tty: null,
  }));
}

function stopAll() { for (const id of [...chats.keys()]) stop(id); }

module.exports = { start, send, stop, list, stopAll, has: (id) => chats.has(id) };
