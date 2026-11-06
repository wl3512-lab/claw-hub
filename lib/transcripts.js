'use strict';
// Reads Claude Code's own files: ~/.claude/projects/*/*.jsonl (transcripts)
// and ~/.claude/sessions/<pid>.json (one per running session).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 384 * 1024;

const indexCache = new Map(); // file -> { mtimeMs, size, meta }

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function safeParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function stripNoise(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
}

// A "human" prompt: what the person actually typed (not tool results, not meta).
function humanText(d, side = false) {
  if (!d || d.type !== 'user' || d.isMeta || (d.isSidechain && !side)) return null;
  const c = d.message && d.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const parts = c.filter((p) => p.type === 'text').map((p) => p.text);
    if (parts.length && !c.some((p) => p.type === 'tool_result')) text = parts.join('\n');
  }
  if (text == null) return null;
  text = stripNoise(text);
  if (!text) return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return { text: `${cmd[1]} ${args}`.trim(), command: true };
  }
  if (/^<(local-command|bash-|task-notification)/.test(text)) return null;
  return { text, command: false };
}

// sessions started from Lucy's phone (Remote Control server in ~/phone-crabs) are real chats, not auto runs
const PHONE_DIR = path.join(os.homedir(), 'phone-crabs');
function isPhoneDir(cwd) { return !!cwd && (cwd === PHONE_DIR || cwd.startsWith(PHONE_DIR + path.sep)); }

function isBotDir(cwd) {
  return /^\/(private\/)?var\/folders\//.test(cwd || '') || /^\/(private\/)?tmp\//.test(cwd || '');
}

function scanMeta(file, stat) {
  const meta = {
    id: path.basename(file, '.jsonl'),
    file,
    size: stat.size,
    updatedAt: stat.mtimeMs,
    createdAt: null,
    cwd: null,
    firstPrompt: null,
    lastPrompt: null,
    aiTitle: null,
    customTitle: null,
    entrypoint: null,
    turns: 0,
  };

  const head = readSlice(file, 0, Math.min(HEAD_BYTES, stat.size));
  for (const line of head.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request')) continue;
    const d = safeParse(line);
    if (!d) continue;
    if (!meta.cwd && d.cwd) meta.cwd = d.cwd;
    if (!meta.entrypoint && d.entrypoint) meta.entrypoint = d.entrypoint;
    if (!meta.createdAt && d.timestamp) meta.createdAt = Date.parse(d.timestamp);
    if (!meta.firstPrompt) {
      const h = humanText(d);
      if (h) meta.firstPrompt = h.text.slice(0, 400);
    }
    if (d.type === 'custom-title') meta.customTitle = d.customTitle;
    if (d.type === 'ai-title') meta.aiTitle = d.aiTitle;
    if (meta.cwd && meta.firstPrompt && meta.createdAt) break;
  }

  if (stat.size > HEAD_BYTES) {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = readSlice(file, start, stat.size - start);
    const lines = tail.split('\n');
    if (start > 0) lines.shift(); // partial first line
    for (const line of lines) {
      if (!line || line.startsWith('{"type":"api-request')) continue;
      if (!line.includes('title"') && !line.includes('"last-prompt"')) continue;
      const d = safeParse(line);
      if (!d) continue;
      if (d.type === 'custom-title') meta.customTitle = d.customTitle;
      if (d.type === 'ai-title') meta.aiTitle = d.aiTitle;
      if (d.type === 'last-prompt') meta.lastPrompt = d.lastPrompt;
    }
  } else {
    for (const line of head.split('\n')) {
      if (!line.includes('"last-prompt"') && !line.includes('title"')) continue;
      const d = safeParse(line);
      if (!d) continue;
      if (d.type === 'last-prompt') meta.lastPrompt = d.lastPrompt;
      if (d.type === 'ai-title') meta.aiTitle = d.aiTitle;
      if (d.type === 'custom-title') meta.customTitle = d.customTitle;
    }
  }

  meta.phone = isPhoneDir(meta.cwd);
  meta.bot = !meta.phone && (isBotDir(meta.cwd) || meta.entrypoint === 'sdk-cli' || meta.entrypoint === 'sdk-ts');
  meta.empty = !meta.firstPrompt;
  return meta;
}

function listTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  const seen = new Set();
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let files = [];
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(full, f);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      seen.add(file);
      const cached = indexCache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        out.push(cached.meta);
        continue;
      }
      let meta;
      try { meta = scanMeta(file, stat); } catch { continue; }
      indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      out.push(meta);
    }
  }
  for (const k of indexCache.keys()) if (!seen.has(k)) indexCache.delete(k);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function findTranscript(id) {
  for (const { meta } of indexCache.values()) if (meta.id === id) return meta;
  return listTranscripts().find((m) => m.id === id) || null;
}

// ---------- live sessions ----------

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function processesFor(pids) {
  const map = {};
  if (!pids.length) return map;
  try {
    const out = execFileSync('ps', ['-o', 'pid=,tty=,comm=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000 });
    for (const row of out.trim().split('\n')) {
      const match = row.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, tty, command] = match;
      map[pid] = { tty: tty !== '??' && tty !== '?' ? `/dev/${tty}` : null,
        verifiedProcess: path.basename(command.trim()) === 'claude' };
    }
  } catch { /* ps exits 1 if some pids vanished */ }
  return map;
}

function listLive() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const sessions = [];
  for (const f of files) {
    // a session that just exited deletes its file between readdir and read
    let raw; try { raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'); } catch { continue; }
    const d = safeParse(raw);
    if (!d || !Number.isInteger(d.pid) || d.pid <= 1 || !alive(d.pid)) continue;
    sessions.push(d);
  }
  const processes = processesFor(sessions.map((s) => s.pid));
  return sessions.map((s) => ({
    pid: s.pid,
    sessionId: s.sessionId,
    cwd: s.cwd,
    status: s.status || 'unknown',
    statusSince: s.statusUpdatedAt || s.updatedAt || s.startedAt,
    startedAt: s.startedAt,
    entrypoint: s.entrypoint,
    kind: s.kind,
    phone: isPhoneDir(s.cwd),
    name: s.name,
    tty: processes[s.pid]?.tty || null,
    verifiedProcess: processes[s.pid]?.verifiedProcess === true,
  })).sort((a, b) => (b.statusSince || 0) - (a.statusSince || 0));
}

// What a session is doing right now, read from the end of its transcript:
// latest tool call or reply, how full its context is, whether it asked you something,
// and any "usage limit reached" notice.
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const activityCache = new Map(); // file -> { size, value }
function activity(meta, side = false) {
  let size;
  try { size = fs.statSync(meta.file).size; } catch { return null; }
  const hit = activityCache.get(meta.file);
  if (hit && hit.size === size) return hit.value;
  const start = Math.max(0, size - 256 * 1024);
  const lines = readSlice(meta.file, start, size - start).split('\n');
  let value = null;
  let ctx = null;
  let limit = null;
  let answered = new Set();
  let unansweredUser = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.startsWith('{"type":"api-request')) continue;
    if (!value && line.includes('"type":"user"') && humanText(safeParse(line), side)) unansweredUser = true;
    if (!limit && line.includes('"subtype":"informational"')) {
      const d = safeParse(line);
      if (d && /^Usage limit reset/.test(d.content || '')) limit = { reset: true };
      else if (d && /^Usage limit reached/.test(d.content || '')) {
        const at = (d.content.match(/at ([0-9:apm]+)/) || [])[1] || null;
        limit = { at, ts: Date.parse(d.timestamp) };
      }
    }
    if (!value && line.includes('"tool_result"')) {
      const d = safeParse(line);
      const c = d && d.message && Array.isArray(d.message.content) ? d.message.content : [];
      for (const p of c) if (p.type === 'tool_result') answered.add(p.tool_use_id);
    }
    if (value && ctx != null && limit) break;
    if (!line.includes('"type":"assistant"')) continue;
    const d = safeParse(line);
    if (!d || d.type !== 'assistant' || (d.isSidechain && !side)) continue;
    const m = d.message || {};
    if (ctx == null && m.usage && m.model !== '<synthetic>') {
      const u = m.usage;
      ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    if (value) continue;
    const c = m.content || [];
    for (let j = c.length - 1; j >= 0 && !value; j--) {
      const p = c[j];
      if (p.type === 'tool_use') {
        value = { kind: 'tool', tool: p.name, text: summarizeToolInput(p.name, p.input), ts: Date.parse(d.timestamp),
          asking: ASK_TOOLS.has(p.name) && !answered.has(p.id) };
      } else if (p.type === 'text' && p.text.trim()) {
        const txt = p.text.trim();
        value = { kind: 'say', text: txt.replace(/\s+/g, ' ').slice(0, 180), ts: Date.parse(d.timestamp),
          completed: m.stop_reason === 'end_turn' && !unansweredUser && !c.some((p) => p.type === 'tool_use'),
          asking: /\?\s*(\*|_|`)*\s*$/.test(txt.slice(-200)) };
      }
    }
  }
  if (value) {
    value.ctx = ctx;
    // auto-compact fires near 970k on these 1M-context models
    value.ctxPct = ctx ? Math.min(100, Math.round((ctx / 970000) * 100)) : null;
    if (limit && !limit.reset && Date.now() - limit.ts < 6 * 3600 * 1000) value.limit = limit;
  }
  activityCache.set(meta.file, { size, value });
  return value;
}

// Baby crabs: a session's subagents (foreground + background). run = working,
// stuck = quiet over 4 min without finishing, done = finished.
// Babies hatched after `since` stay on the beach until you open them (`seen`);
// older ones keep the old rule (done shows 90 s, quiet over 2 h hides) so history doesn't flood in.
function helpers(meta, { seen = new Set(), since = Infinity } = {}) {
  const dir = path.join(path.dirname(meta.file), meta.id, 'subagents');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return []; }
  const out = [];
  const now = Date.now();
  for (const f of files) {
    const full = path.join(dir, f);
    const jsonl = full.replace(/\.meta\.json$/, '.jsonl');
    let st; try { st = fs.statSync(jsonl); } catch { continue; }
    const age = now - st.mtimeMs;
    let raw; try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const m = safeParse(raw);
    if (!m) continue;
    const id = path.basename(jsonl, '.jsonl');
    const act = activity({ file: jsonl, id }, true);
    // foreground subagents never get a `finished` flag: they're done once their
    // transcript ends on a plain reply (no pending tool call) and goes quiet
    const ended = m.finished || (act && act.kind === 'say' && age > 20 * 1000);
    const sticky = st.birthtimeMs >= since;
    if (seen.has(id)) continue;
    let status;
    if (ended) { if (!sticky && age > 90 * 1000) continue; status = 'done'; }
    else if (age > 2 * 3600 * 1000 && !sticky) continue;
    else status = age > 4 * 60 * 1000 ? 'stuck' : 'run';
    out.push({ id, type: m.agentType || 'helper', description: m.description || 'helper', status, sticky, tool: act && act.kind === 'tool' ? act.tool : null, startedAt: st.birthtimeMs, lastAt: st.mtimeMs });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function subMeta(meta, agentId) {
  if (!/^agent-[a-z0-9]+$/.test(agentId)) return null;
  const file = path.join(path.dirname(meta.file), meta.id, 'subagents', `${agentId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  let m = {};
  try { m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* none */ }
  return { id: `${meta.id}/${agentId}`, file, side: true, description: m.description || agentId, finished: !!m.finished };
}

// ---------- full conversation ----------

const convoCache = new Map(); // id -> { file, offset, items, toolIndex, msgIds }

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.description || input.command || input.file_path || input.pattern ||
    input.url || input.query || input.prompt || input.skill || input.path || '';
  return String(pick).replace(/\s+/g, ' ').slice(0, 160);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n');
  }
  return '';
}

function ingestLine(state, line) {
  if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"attachment')) return;
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
  const d = safeParse(line);
  if (!d || (d.isSidechain && !state.side)) return;
  const ts = d.timestamp ? Date.parse(d.timestamp) : null;

  if (d.type === 'user' && d.isCompactSummary) {
    state.items.push({ kind: 'note', text: 'Older messages were summarized here to save space', ts });
    return;
  }

  if (d.type === 'user') {
    const c = d.message && d.message.content;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === 'tool_result') {
          const t = state.toolIndex.get(p.tool_use_id);
          if (t) {
            t.result = toolResultText(p.content).slice(0, 1500);
            t.error = !!p.is_error;
          }
        }
      }
    }
    const h = humanText(d, state.side);
    const nImg = Array.isArray(c) && !c.some((q) => q.type === 'tool_result') ? c.filter((q) => q.type === 'image').length : 0;
    if (h) state.items.push({ kind: h.command ? 'command' : 'user', text: h.text.slice(0, 20000) + (nImg ? `\n[${nImg} image${nImg > 1 ? 's' : ''}]` : ''), ts });
    return;
  }

  if (d.type === 'assistant') {
    const m = d.message || {};
    const c = Array.isArray(m.content) ? m.content : [];
    for (const p of c) {
      if (p.type === 'text' && p.text && p.text.trim()) {
        const last = state.items[state.items.length - 1];
        if (last && last.kind === 'assistant' && last.msgId === m.id) last.text += `\n\n${p.text}`;
        else state.items.push({ kind: 'assistant', text: p.text.slice(0, 40000), ts, msgId: m.id });
      } else if (p.type === 'tool_use') {
        const tool = { kind: 'tool', name: p.name, summary: summarizeToolInput(p.name, p.input), ts, id: p.id };
        state.toolIndex.set(p.id, tool);
        state.items.push(tool);
      }
    }
  }
}

function loadConvo(meta) {
  let state = convoCache.get(meta.id);
  const size = fs.statSync(meta.file).size;
  if (!state || state.file !== meta.file || size < state.offset) {
    // decoder holds back a multi-byte character split across two reads instead of garbling it
    state = { file: meta.file, offset: 0, items: [], toolIndex: new Map(), carry: '', side: !!meta.side, decoder: new StringDecoder('utf8') };
    convoCache.set(meta.id, state);
  }
  if (size > state.offset) {
    const fd = fs.openSync(meta.file, 'r');
    try {
      const CHUNK = 8 * 1024 * 1024;
      let pos = state.offset;
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, pos);
        if (n === 0) break; // file shrank under us; stop instead of looping forever
        pos += n;
        const text = state.carry + state.decoder.write(buf.subarray(0, n));
        const lines = text.split('\n');
        state.carry = lines.pop();
        for (const line of lines) ingestLine(state, line);
      }
      state.offset = pos;
    } finally {
      fs.closeSync(fd);
    }
  }
  // keep cache small
  if (convoCache.size > 12) convoCache.delete(convoCache.keys().next().value);
  return state.items;
}

module.exports = { listTranscripts, findTranscript, listLive, loadConvo, activity, helpers, subMeta, CLAUDE_DIR };
