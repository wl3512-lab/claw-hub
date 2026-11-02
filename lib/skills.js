'use strict';
// Saved skills (~/.claude/skills/*/SKILL.md) and commands (~/.claude/commands/**/*.md),
// plus a compact, token-cheap brief of an in-progress chat to feed into one.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

function frontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return {}; }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

let cache = null;
let cacheAt = 0;

function listSkills() {
  if (cache && Date.now() - cacheAt < 60000) return cache;
  const out = [];
  try {
    for (const d of fs.readdirSync(SKILLS_DIR)) {
      const f = path.join(SKILLS_DIR, d, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const fm = frontmatter(f);
      out.push({ name: fm.name || d, kind: 'skill', description: (fm.description || '').slice(0, 220), mtime: fs.statSync(f).mtimeMs });
    }
  } catch { /* no skills dir */ }
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, prefix ? `${prefix}:${e.name}` : e.name);
      else if (e.name.endsWith('.md') && e.name !== 'README.md') {
        const base = e.name.replace(/\.md$/, '');
        const fm = frontmatter(full);
        out.push({ name: prefix ? `${prefix}:${base}` : base, kind: 'command', description: (fm.description || '').slice(0, 220), mtime: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(COMMANDS_DIR, '');
  const seen = new Set();
  cache = out.filter((s) => (seen.has(s.name) ? false : seen.add(s.name))).sort((a, b) => b.mtime - a.mtime);
  cacheAt = Date.now();
  return cache;
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Terse key: value brief. Plain short English is the cheapest form for Claude.
function brief(meta, items, extra) {
  const home = os.homedir();
  const asks = [];
  for (let i = items.length - 1; i >= 0 && asks.length < 5; i--) {
    const it = items[i];
    if (it.kind === 'user' && it.text && !asks.includes(clip(it.text, 160))) asks.unshift(clip(it.text, 160));
  }
  let last = '';
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'assistant') { last = items[i].text; break; }
  const lines = [
    'ctx: resume earlier work',
    `proj: ${clip(extra.title || meta.aiTitle || meta.firstPrompt, 90)}`,
    `dir: ${String(meta.cwd || '').replace(home, '~')}`,
  ];
  if (extra.note) lines.push(`note: ${clip(extra.note, 160)}`);
  if (meta.firstPrompt) lines.push(`goal: ${clip(meta.firstPrompt, 300)}`);
  if (asks.length) lines.push('recent asks:', ...asks.map((a) => `- ${a}`));
  if (last) lines.push(`last state: ${clip(last, 600)}`);
  lines.push(`log: ${meta.file.replace(home, '~')} (big jsonl; grep, don't read whole)`);
  return lines.join('\n');
}

module.exports = { listSkills, brief };
