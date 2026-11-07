'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activity, helpers } = require('../lib/transcripts');

test('a new user message invalidates the previous completed turn for cleanup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  const reply = { type: 'assistant', timestamp: '2026-11-01T12:00:00Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Finished.' }] } };
  fs.writeFileSync(file, JSON.stringify(reply) + '\n');
  assert.equal(activity({ file }).completed, true);
  fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'One more thing' } }) + '\n');
  assert.equal(activity({ file }).completed, false);
});

test('text accompanying a tool call is not a completed turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T12:00:00Z',
    message: { stop_reason: 'tool_use', content: [
      { type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'work' } },
      { type: 'text', text: 'Working on it.' },
    ] } }) + '\n');
  assert.equal(activity({ file }).completed, false);
});

test('a chat keeps every baby for its container, while the pen drops opened ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-brood-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const subs = path.join(dir, 'mom', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const write = (id, description, tail) => {
    fs.writeFileSync(path.join(subs, `${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description, finished: true }));
    fs.writeFileSync(path.join(subs, `${id}.jsonl`), tail.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const say = (text) => ({ type: 'assistant', isSidechain: true, timestamp: '2026-11-01T12:00:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  write('agent-a1', 'find the bug', [say('first look'), say('Found it in  the\nparser.')]);
  write('agent-b2', 'read the docs', [say('All read.')]);
  const meta = { id: 'mom', file: path.join(dir, 'mom.jsonl') };
  const seen = new Set(['agent-a1']);

  assert.deepEqual(helpers(meta, { seen, since: 0 }).map((h) => h.id), ['agent-b2']);
  const all = helpers(meta, { seen, since: 0, all: true });
  assert.equal(all.length, 2);
  const a = all.find((h) => h.id === 'agent-a1');
  assert.equal(a.opened, true);
  assert.equal(a.said, 'Found it in the parser.');
});
