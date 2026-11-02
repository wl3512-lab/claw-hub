'use strict';
// iMessage pings + replies.
// Sends with AppleScript (Messages app). Reads your replies from ~/Library/Messages/chat.db,
// which needs Full Disk Access for the node binary that runs the hub.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { writeJson } = require('./write-json');

const SETTINGS = path.join(__dirname, '..', 'data', 'settings.json');
const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const TAG = '[claw]';

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; }
}
function writeSettings(s) { writeJson(SETTINGS, s, 2); }
function config() {
  const s = readSettings().imessage || {};
  return { handle: s.handle || '', enabled: !!s.enabled, onAsk: s.onAsk !== false, onDone: s.onDone !== false, onlyAway: s.onlyAway !== false, nums: s.nums || {}, last: s.last || null };
}
function saveConfig(patch) {
  const all = readSettings();
  all.imessage = { ...config(), ...patch };
  writeSettings(all);
  return all.imessage;
}

function send(text) {
  const { handle } = config();
  if (!handle) return Promise.reject(new Error('add your iMessage phone number or email first'));
  const script = 'on run argv\n tell application "Messages"\n  set svc to 1st account whose service type = iMessage\n  send (item 1 of argv) to participant (item 2 of argv) of svc\n end tell\nend run';
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, text, handle], { timeout: 15000 }, (err, _out, stderr) => {
      if (err) reject(new Error(/not allowed|-1743/.test(stderr) ? 'macOS blocked the hub from using Messages. Allow it in System Settings → Privacy & Security → Automation.' : (stderr || err.message).trim()));
      else resolve();
    });
  });
}

// how long since you last touched the keyboard or mouse
function idleSeconds() {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/"HIDIdleTime" = (\d+)/);
    return m ? Number(m[1]) / 1e9 : 0;
  } catch { return 0; }
}

// a short number per crab so replies can say "#3 ..."
function numFor(sessionId) {
  const c = config();
  if (c.nums[sessionId]) return c.nums[sessionId];
  const used = new Set(Object.values(c.nums));
  let n = 1; while (used.has(n)) n++;
  const nums = { ...c.nums, [sessionId]: n };
  // keep it small: forget the oldest beyond 30
  const keys = Object.keys(nums);
  if (keys.length > 30) delete nums[keys[0]];
  saveConfig({ nums });
  return n;
}
function sessionForNum(n) {
  const e = Object.entries(config().nums).find(([, v]) => v === n);
  return e ? e[0] : null;
}

// ---------- reading replies ----------
function canRead() {
  try { fs.closeSync(fs.openSync(DB, 'r')); return true; } catch { return false; }
}

function sql(query) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', DB, query], { encoding: 'utf8', timeout: 8000 });
  return out.trim() ? JSON.parse(out) : [];
}

// newer macOS keeps message text in an archived NSAttributedString blob
function bodyText(hex) {
  if (!hex) return '';
  const buf = Buffer.from(hex, 'hex');
  const i = buf.indexOf(Buffer.from('NSString'));
  if (i < 0) return '';
  let p = buf.indexOf(0x2b, i + 8); // '+' marks the string
  if (p < 0) return '';
  p += 1;
  let len = buf[p];
  if (len === 0x81) { len = buf.readUInt16LE(p + 1); p += 3; } else if (len === 0x82) { len = buf.readUInt32LE(p + 1); p += 5; } else p += 1;
  return buf.slice(p, p + len).toString('utf8');
}

let lastRow = null;
function newReplies() {
  const { handle } = config();
  if (!handle || !canRead()) return [];
  const h = handle.replace(/'/g, "''");
  if (lastRow == null) {
    const r = sql('select max(ROWID) as m from message');
    lastRow = (r[0] && r[0].m) || 0;
    return [];
  }
  const rows = sql(`select m.ROWID as id, m.text as text, hex(m.attributedBody) as body from message m
    join chat_message_join cmj on cmj.message_id = m.ROWID join chat c on c.ROWID = cmj.chat_id
    where m.ROWID > ${Number(lastRow)} and (c.chat_identifier = '${h}' or c.chat_identifier like '%${h.replace(/^\+/, '')}%')
    order by m.ROWID`);
  if (rows.length) lastRow = rows[rows.length - 1].id;
  const seen = new Set();
  return rows.map((r) => (r.text || bodyText(r.body) || '').trim())
    .filter((t) => t && !t.startsWith(TAG) && !seen.has(t) && seen.add(t));
}

function parseReply(text) {
  const m = text.match(/^#(\d+)\s+([\s\S]+)$/);
  if (m) return { num: Number(m[1]), text: m[2].trim() };
  return { num: null, text };
}

module.exports = { config, saveConfig, send, idleSeconds, numFor, sessionForNum, canRead, newReplies, parseReply, TAG };
