'use strict';
// Daily logbook, built locally from transcripts (no tokens spent):
// every chat active that day, what you asked, how it ended, and how much work it did.

const fs = require('fs');
const path = require('path');
const t = require('./transcripts');

const DIR = path.join(__dirname, '..', 'data', 'logbook');

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function bounds(key) {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, start + 86400000];
}
function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function build(key, state, live) {
  const [from, to] = bounds(key);
  const liveIds = new Map(live.map((l) => [l.sessionId, l]));
  const entries = [];
  for (const meta of t.listTranscripts()) {
    if (meta.bot || meta.empty) continue;
    if (meta.updatedAt < from) continue; // untouched since before this day
    if ((meta.createdAt || 0) >= to) continue;
    let items;
    try { items = t.loadConvo(meta); } catch { continue; }
    const today = items.filter((i) => i.ts && i.ts >= from && i.ts < to);
    if (!today.length) continue;
    const asks = today.filter((i) => i.kind === 'user').map((i) => clip(i.text, 140));
    const replies = today.filter((i) => i.kind === 'assistant');
    const steps = today.filter((i) => i.kind === 'tool').length;
    const babies = today.filter((i) => i.kind === 'tool' && /^(Agent|Task)$/.test(i.name)).length;
    const last = replies.length ? replies[replies.length - 1].text : '';
    const s = state.convos[meta.id] || {};
    const l = liveIds.get(meta.id);
    const lastItem = today[today.length - 1];
    let ending = 'closed';
    if (l) ending = l.status === 'busy' ? 'working' : 'waiting on you';
    else if (lastItem && lastItem.kind === 'user') ending = 'stopped before replying';
    else if (/\?\s*$/.test(String(last).slice(-200))) ending = 'asked you something';
    entries.push({
      id: meta.id, title: s.label || meta.customTitle || meta.aiTitle || clip(meta.firstPrompt, 70) || 'untitled',
      cwd: meta.cwd, group: s.group || null, hue: s.hue, shell: s.shell,
      asks, steps, babies, last: clip(last, 320), ending,
      first: today[0].ts, lastAt: lastItem.ts,
    });
  }
  entries.sort((a, b) => b.lastAt - a.lastAt);
  const summary = {
    chats: entries.length,
    asks: entries.reduce((n, e) => n + e.asks.length, 0),
    steps: entries.reduce((n, e) => n + e.steps, 0),
    waiting: entries.filter((e) => e.ending === 'waiting on you' || e.ending === 'asked you something').length,
  };
  return { day: key, builtAt: Date.now(), summary, entries };
}

function save(book) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${book.day}.json`), JSON.stringify(book));
}

function get(key, state, live, { fresh = false } = {}) {
  const f = path.join(DIR, `${key}.json`);
  const isToday = key === dayKey(Date.now());
  if (!fresh && !isToday) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* build it */ } }
  const book = build(key, state, live);
  save(book);
  return book;
}

function days() {
  let saved = [];
  try { saved = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { /* none yet */ }
  const recent = [];
  for (let i = 0; i < 14; i++) recent.push(dayKey(Date.now() - i * 86400000));
  return [...new Set([...recent, ...saved])].sort().reverse();
}

module.exports = { get, days, dayKey };
