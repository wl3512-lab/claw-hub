'use strict';
// Your plan's usage limits, as Claude itself reports them: every claude call emits a
// rate_limit_event with how much of the 5-hour and weekly windows is used. We keep the
// latest reading (from hub chats and the purpose call), remember where the week stood at
// the start of today, and, if nothing has reported in a while, make one tiny Haiku call.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { writeJson } = require('./write-json');

const FILE = path.join(__dirname, '..', 'data', 'limits.json');
const CLAUDE_BIN = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  .find((p) => fs.existsSync(p)) || 'claude';
const PROBE_DIR = path.join(os.tmpdir(), 'claw-hub-purpose'); // same folder the purpose call uses, so it never shows as a crab
const STALE = 20 * 60 * 1000;

let s = null;
let probing = false;
let lastProbe = 0;

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

function maybeProbe() {
  const c = load();
  if (probing || Date.now() - (c.at || 0) < STALE || Date.now() - lastProbe < STALE) return;
  probing = true; lastProbe = Date.now();
  let child;
  try {
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    child = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--output-format', 'stream-json', '--verbose'], {
      cwd: PROBE_DIR, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}` },
    });
  } catch (e) { probing = false; console.error('[limits] probe failed:', e.message); return; }
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60000);
  child.on('error', () => { clearTimeout(kill); probing = false; });
  child.on('close', () => { clearTimeout(kill); probing = false; noteFromStream(out); });
  child.stdin.on('error', () => {});
  child.stdin.end('reply with just: ok');
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

module.exports = { note, noteFromStream, maybeProbe, get };
