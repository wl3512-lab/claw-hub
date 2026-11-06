'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activity } = require('../lib/transcripts');

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
