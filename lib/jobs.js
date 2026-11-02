'use strict';
// Job board + scheduled crabs. Jobs are sticky notes; running one hatches a hub crab.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(__dirname, '..', 'data', 'jobs.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(jobs) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(jobs, null, 2));
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// schedule: { days: [0-6], time: 'HH:MM' } or null
function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') ? s.time : null;
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
  if (!time || !days.length) return null;
  return { time, days };
}

function scheduleText(s) {
  if (!s) return '';
  const d = s.days.join(',');
  const label = d === '0,1,2,3,4,5,6' ? 'every day' : d === '1,2,3,4,5' ? 'weekdays' : s.days.map((x) => DAYS[x]).join(' ');
  return `${label} ${s.time}`;
}

// most recent scheduled moment at or before `now`
function lastDue(s, now = new Date()) {
  const [hh, mm] = s.time.split(':').map(Number);
  for (let back = 0; back < 8; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hh, mm, 0, 0);
    if (d <= now && s.days.includes(d.getDay())) return d.getTime();
  }
  return 0;
}
function nextDue(s, now = new Date()) {
  const [hh, mm] = s.time.split(':').map(Number);
  for (let fwd = 0; fwd < 8; fwd++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + fwd, hh, mm, 0, 0);
    if (d > now && s.days.includes(d.getDay())) return d.getTime();
  }
  return 0;
}

function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) : s; }

function upsert(input) {
  const jobs = load();
  let j = input.id ? jobs.find((x) => x.id === input.id) : null;
  if (!j) {
    j = { id: Math.random().toString(36).slice(2, 10), status: 'todo', runs: [], createdAt: Date.now() };
    jobs.push(j);
  }
  if ('title' in input) j.title = clip(input.title, 80) || 'untitled job';
  if ('prompt' in input) j.prompt = clip(input.prompt, 4000);
  if ('group' in input) j.group = input.group || null;
  if ('cwd' in input) j.cwd = clip(input.cwd, 400) || '~';
  if ('skill' in input) j.skill = clip(String(input.skill || '').replace(/^\//, ''), 80) || null;
  if ('queue' in input) j.queue = !!input.queue;
  if ('schedule' in input) j.schedule = cleanSchedule(input.schedule);
  if ('status' in input && ['todo', 'done'].includes(input.status)) j.status = input.status;
  if (j.schedule && !j.lastDueRun) j.lastDueRun = lastDue(j.schedule); // don't fire for times already past
  save(jobs);
  return j;
}

function remove(id) { save(load().filter((j) => j.id !== id)); }

// terse prompt: skill + task + folder
function promptFor(j) {
  const home = os.homedir();
  const body = [`task: ${j.prompt || j.title}`];
  if (j.title && j.prompt && j.title !== j.prompt) body.unshift(`job: ${j.title}`);
  if (j.schedule) body.push(`repeats: ${scheduleText(j.schedule)}; keep the reply short`);
  const text = body.join('\n').replace(home, '~');
  return j.skill ? `/${j.skill} ${text}` : text;
}

function markRun(id, sessionId, scheduled) {
  const jobs = load();
  const j = jobs.find((x) => x.id === id);
  if (!j) return null;
  j.status = 'running';
  j.sessionId = sessionId;
  j.queue = scheduled ? j.queue : false;
  j.runs = (j.runs || []).concat({ sessionId, at: Date.now(), scheduled: !!scheduled }).slice(-30);
  save(jobs);
  return j;
}

function update(id, patch) {
  const jobs = load();
  const j = jobs.find((x) => x.id === id);
  if (!j) return null;
  Object.assign(j, patch);
  save(jobs);
  return j;
}

module.exports = { load, save, upsert, remove, promptFor, markRun, update, lastDue, nextDue, scheduleText };
