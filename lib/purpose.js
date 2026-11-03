'use strict';
// What each crab is for, in one plain sentence, plus which crabs look like they're doing
// the same job. One small Haiku call (no tools, no saved session) over the open crabs,
// only when something changed, at most once every couple of minutes. Cached in data/.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { writeJson } = require('./write-json');

const CLAUDE_BIN = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  .find((p) => fs.existsSync(p)) || 'claude';
const FILE = path.join(__dirname, '..', 'data', 'purpose.json');
const WORK_DIR = path.join(os.tmpdir(), 'claw-hub-purpose'); // a temp folder, so it's never shown as a crab
const MIN_GAP = 2 * 60 * 1000;
const TIMEOUT = 90 * 1000;

let cache = null;
let running = null; // pid of the call in flight
let lastRun = 0;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  if (!cache.purposes) cache.purposes = {};
  if (!Array.isArray(cache.overlaps)) cache.overlaps = [];
  return cache;
}
function save() { try { writeJson(FILE, cache, 2); } catch (e) { console.error('[purpose] save failed:', e.message); } }

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const keyOf = (c) => crypto.createHash('sha1').update([c.title, c.firstPrompt, c.lastPrompt, c.cwd].join('\u0000')).digest('hex').slice(0, 16);

function get(id) { const p = load().purposes[id]; return p ? p.text : null; }

// open crabs whose overlap was computed against the same set of crabs
function overlaps(openIds) {
  const open = new Set(openIds);
  return load().overlaps.filter((o) => open.has(o.a) && open.has(o.b));
}

function isOurs(pid, cwd) { return (running && pid === running) || (cwd && cwd.startsWith(WORK_DIR)); }

// crabs: [{ id, title, cwd, firstPrompt, lastPrompt }]; detail(id) -> { recent: [user prompts], lastReply },
// only called when a call is actually going to run
function refresh(crabs, detail) {
  const c = load();
  if (running || Date.now() - lastRun < MIN_GAP || crabs.length === 0) return;
  const stale = crabs.filter((x) => !c.purposes[x.id] || c.purposes[x.id].key !== keyOf(x));
  const setKey = crabs.map((x) => x.id).sort().join(',');
  if (!stale.length && c.overlapSet === setKey) return;
  lastRun = Date.now();
  const staleIds = new Set(stale.map((x) => x.id));
  crabs = crabs.map((x) => {
    if (!staleIds.has(x.id)) return { ...x, known: c.purposes[x.id].text };
    try { return { ...x, ...detail(x.id) }; } catch { return x; }
  });

  const listing = crabs.map((x, i) => [
    `### crab ${i + 1}`,
    `id: ${x.id}`,
    `title: ${clip(x.title, 100)}`,
    `folder: ${String(x.cwd || '').replace(os.homedir(), '~')}`,
    `first ask: ${clip(x.firstPrompt, 500)}`,
    x.known ? `already known purpose (reuse it unless clearly wrong): ${x.known}` : '',
    x.recent && x.recent.length ? `recent asks:\n${x.recent.map((r) => `- ${clip(r, 220)}`).join('\n')}` : '',
    x.lastReply ? `last reply (start): ${clip(x.lastReply, 300)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');

  const prompt = `Below are Claude Code chat sessions ("crabs") that are open on Lucy's Mac. For each one, say what it is for.

Rules for "purpose": one plain sentence, at most 16 words, lowercase is fine, says the actual job (the project and the task), not "helping the user". If the chat moved on from its first ask, describe what it is working on now. If there's too little to tell (like just "hi"), say "no job yet, just said hi" or similar.

Then find pairs of crabs doing the SAME or heavily overlapping job (same project and same task, so one chat could take over the other's work). Different tasks in the same folder do NOT count. Be strict: when unsure, leave it out.

Reply with only JSON, no code fence:
{"purposes":{"<id>":"<purpose>"},"overlaps":[{"a":"<id>","b":"<id>","why":"<at most 14 words: what they both do>"}]}

${listing}`;

  let child;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    child = spawn(CLAUDE_BIN, ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json'], {
    cwd: WORK_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}` },
    });
  } catch (e) { console.error('[purpose] could not start claude:', e.message); return; }
  running = child.pid || null;
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  child.on('error', (e) => { console.error('[purpose] could not run claude:', e.message); running = null; });
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT);
  child.on('close', () => {
    clearTimeout(kill);
    running = null;
    if (!out.trim()) { console.error('[purpose] claude gave no reply'); return; }
    try {
      const res = JSON.parse(out);
      if (res.is_error) throw new Error(String(res.result || 'error reply').slice(0, 200));
      const text = String(res.result || '').replace(/^```(json)?\s*|\s*```$/g, '');
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const ids = new Set(crabs.map((x) => x.id));
      for (const x of crabs) {
        const p = j.purposes && j.purposes[x.id];
        if (typeof p === 'string' && p.trim()) c.purposes[x.id] = { key: keyOf(x), text: clip(p, 140), at: Date.now() };
      }
      c.overlaps = (Array.isArray(j.overlaps) ? j.overlaps : [])
        .filter((o) => o && ids.has(o.a) && ids.has(o.b) && o.a !== o.b)
        .map((o) => ({ a: o.a, b: o.b, why: clip(o.why, 120) }));
      c.overlapSet = setKey;
      // forget crabs gone for a week
      for (const [id, p] of Object.entries(c.purposes)) if (!ids.has(id) && Date.now() - p.at > 7 * 86400000) delete c.purposes[id];
      save();
    } catch (e) {
      console.error('[purpose] bad reply:', e.message, out.slice(0, 200));
    }
  });
  child.stdin.on('error', () => {}); // claude died before reading: 'close' logs it
  child.stdin.end(prompt);
}

module.exports = { get, overlaps, refresh, isOurs };
