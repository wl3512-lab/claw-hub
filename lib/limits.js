'use strict';
// Your plan's usage limits, as Claude itself reports them: every claude call emits a
// rate_limit_event with how much of the 5-hour and weekly windows is used. We keep the
// latest reading from hub chats or opted-in AI summaries, and remember where the
// week stood at the start of today. Reading the meter never starts a Claude call.

const path = require('path');
const fs = require('fs');
const { writeJson } = require('./write-json');

const FILE = path.join(__dirname, '..', 'data', 'limits.json');
let s = null;

function load() {
  if (s) return s;
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { s = {}; }
  return s;
}
function dayKey(t = Date.now()) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

// info = rate_limit_event.rate_limit_info
function note(info) {
  if (!info || typeof info !== 'object') return;
  const w = info.unifiedWindows || {};
  const pick = (k) => {
    const x = w[k] || (info.rateLimitType === k ? info : null);
    return x && typeof x.utilization === 'number' ? { pct: Math.round(x.utilization * 1000) / 10, resetsAt: (x.resetsAt || 0) * 1000 } : null;
  };
  const week = pick('seven_day');
  const five = pick('five_hour');
  if (!week && !five) return;
  const c = load();
  const today = dayKey();
  if (week) {
    const newWeek = c.week && c.week.resetsAt && week.resetsAt !== c.week.resetsAt;
    if (!c.dayStart || c.dayStart.day !== today) c.dayStart = { day: today, weekPct: newWeek ? 0 : (c.week ? c.week.pct : week.pct) };
    else if (newWeek) c.dayStart.weekPct = 0;
    c.week = week;
  }
  if (five) c.five = five;
  c.at = Date.now();
  try { writeJson(FILE, c, 2); } catch (e) { console.error('[limits] save failed:', e.message); }
}

// pull rate_limit_event lines out of stream-json output
function noteFromStream(text) {
  for (const line of String(text).split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try { const d = JSON.parse(line); if (d.type === 'rate_limit_event') note(d.rate_limit_info); } catch { /* partial line */ }
  }
}

// what the hub shows: where the week and the 5-hour window stand, today's share, and the pace left
function get() {
  const c = load();
  if (!c.week && !c.five) return null;
  const out = { at: c.at, week: c.week || null, five: c.five || null };
  if (c.week) {
    const today = c.dayStart && c.dayStart.day === dayKey() ? c.dayStart.weekPct : c.week.pct;
    out.todayPct = Math.max(0, Math.round((c.week.pct - today) * 10) / 10);
    const daysLeft = Math.max(0.25, (c.week.resetsAt - Date.now()) / 86400000);
    out.daysLeft = Math.round(daysLeft * 10) / 10;
    // what's left, spread evenly over the days until it resets (today counts as a whole day)
    out.perDay = Math.round(((100 - c.week.pct + out.todayPct) / Math.max(1, Math.ceil(daysLeft))) * 10) / 10;
  }
  return out;
}

module.exports = { note, noteFromStream, get };
