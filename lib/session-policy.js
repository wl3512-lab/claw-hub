'use strict';
const fs = require('fs');
const path = require('path');
const { writeJson } = require('./write-json');

const FILE = path.join(__dirname, '..', 'data', 'session-settings.json');
const TIMERS = [0, 15, 30, 60];

function config() {
  let s; try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { s = {}; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  return { idleMinutes: TIMERS.includes(s.idleMinutes) ? s.idleMinutes : 0, aiSummaries: s.aiSummaries === true };
}
function save(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid session settings.');
  if ('idleMinutes' in patch && !TIMERS.includes(patch.idleMinutes)) throw new Error('Choose off, 15, 30 or 60 minutes.');
  if ('aiSummaries' in patch && typeof patch.aiSummaries !== 'boolean') throw new Error('AI summaries must be on or off.');
  const s = config();
  for (const k of ['idleMinutes', 'aiSummaries']) if (k in patch) s[k] = patch[k];
  writeJson(FILE, s, 2);
  return s;
}

// Only a positively completed turn can be tidied. Silence, an unknown status or
// an unanswered tool request is not evidence that the task finished.
function canClose(live, activity, helpers = [], now = Date.now(), minutes = 30) {
  if (!live || live.status !== 'idle' || live.pending || live.queued || live.stopping || live.phone) return false;
  if (!['cli', 'hub'].includes(live.entrypoint)) return false;
  if (live.entrypoint === 'cli' && live.verifiedProcess !== true) return false;
  if (!activity || !activity.completed || activity.asking || activity.limit || live.error) return false;
  if (helpers.some((h) => h.status !== 'done')) return false;
  if (!Number.isFinite(live.statusSince) || live.statusSince <= 0 || !Number.isFinite(activity.ts)) return false;
  const since = Math.max(live.statusSince, activity.ts);
  return now >= since && now - since >= minutes * 60000;
}

module.exports = { config, save, canClose };
