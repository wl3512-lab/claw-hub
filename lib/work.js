'use strict';
// What each open crab has been doing lately, read incrementally from its transcript:
//  - files it edited (Edit / Write / NotebookEdit) in the last few hours
//  - a one-hour activity strip (which minutes it was producing output)
//  - output tokens written today (each streamed message counted once)
// Only new bytes are read on each call; the first read looks at the last few MB.

const fs = require('fs');

const FIRST_READ = 4 * 1024 * 1024;
const FILE_WINDOW = 3 * 3600 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const cache = new Map(); // transcript file -> { offset, rest, files: Map(path -> ts), minutes: Set(minuteKey), day, out, seenMsg: Set }

function midnight(now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

function ingest(w, line, today) {
  if (!line.includes('"type":"assistant"')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  if (!d || d.type !== 'assistant' || d.isSidechain) return;
  const ts = Date.parse(d.timestamp) || 0;
  const m = d.message || {};
  w.minutes.add(Math.floor(ts / 60000));
  if (ts >= today && m.id && m.usage && !w.seenMsg.has(m.id)) {
    w.seenMsg.add(m.id);
    w.out += m.usage.output_tokens || 0;
  }
  for (const p of Array.isArray(m.content) ? m.content : []) {
    if (p.type !== 'tool_use' || !EDIT_TOOLS.has(p.name)) continue;
    const f = p.input && (p.input.file_path || p.input.notebook_path);
    if (typeof f === 'string' && f) w.files.set(f, ts);
  }
}

function workOf(meta, now = Date.now()) {
  let size;
  try { size = fs.statSync(meta.file).size; } catch { return null; }
  const today = midnight(now);
  let w = cache.get(meta.file);
  if (!w || size < w.offset || w.day !== today) {
    w = { offset: Math.max(0, size - FIRST_READ), rest: '', files: new Map(), minutes: new Set(), day: today, out: 0, seenMsg: new Set() };
    cache.set(meta.file, w);
  }
  if (size > w.offset) {
    const fd = fs.openSync(meta.file, 'r');
    try {
      const buf = Buffer.alloc(size - w.offset);
      fs.readSync(fd, buf, 0, buf.length, w.offset);
      w.offset = size;
      const text = w.rest + buf.toString('utf8');
      const lines = text.split('\n');
      w.rest = lines.pop();
      // a first read that starts mid-file begins mid-line: that piece just fails to parse
      for (const line of lines) ingest(w, line, today);
    } finally { fs.closeSync(fd); }
  }
  // keep memory bounded
  const nowMin = Math.floor(now / 60000);
  for (const k of w.minutes) if (k < nowMin - 60) w.minutes.delete(k);
  if (w.seenMsg.size > 5000) w.seenMsg = new Set([...w.seenMsg].slice(-2000));
  const files = [...w.files].filter(([, ts]) => now - ts < FILE_WINDOW).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([path, ts]) => ({ path, ts }));
  let strip = '';
  for (let k = nowMin - 59; k <= nowMin; k++) strip += w.minutes.has(k) ? '1' : '0';
  return { files, strip, outToday: w.out };
}

// files edited by more than one open crab in the window: [{ path, ids: [..] }]
function clashes(works) {
  const by = new Map();
  for (const [id, w] of works) for (const f of (w && w.files) || []) {
    if (!by.has(f.path)) by.set(f.path, []);
    by.get(f.path).push(id);
  }
  return [...by].filter(([, ids]) => ids.length > 1).map(([path, ids]) => ({ path, ids }));
}

module.exports = { workOf, clashes };
