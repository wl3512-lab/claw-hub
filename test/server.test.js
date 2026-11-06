'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let root, app, server, session, base, sessionFile, fixtureClaude;
const id = '11111111-1111-4111-8111-111111111111';
const since = Date.now() - 3600000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(route, body) {
  const res = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
function setSession(status) {
  fs.writeFileSync(sessionFile, JSON.stringify({ pid: session.pid, sessionId: id,
    cwd: '/Users/fixture/project', status, statusUpdatedAt: since, startedAt: since - 1000, entrypoint: 'cli' }));
}
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-hub-test-'));
  app = path.join(root, 'app');
  fs.cpSync(path.join(__dirname, '..'), app, {
    recursive: true, filter: (p) => !['.git', 'data', 'test', 'node_modules'].includes(path.basename(p)),
  });
  fs.mkdirSync(path.join(root, '.local/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixture-bin'));
  fixtureClaude = path.join(root, 'fixture-bin/claude');
  fs.symlinkSync(process.execPath, fixtureClaude);
  fs.writeFileSync(path.join(root, '.local/bin/claude'),
    '#!/bin/sh\necho called >> "$HOME/claude-calls"\nexit 1\n', { mode: 0o755 });
  const project = path.join(root, '.claude/projects/fixture');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude/sessions'), { recursive: true });
  const timestamp = new Date(since - 1000).toISOString();
  fs.writeFileSync(path.join(project, id + '.jsonl'), [
    { type: 'user', cwd: '/Users/fixture/project', timestamp, message: { role: 'user', content: 'Fix the fixture' } },
    { type: 'assistant', timestamp, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Finished.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  session = spawn(fixtureClaude, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  sessionFile = path.join(root, '.claude/sessions/fixture.json');
  setSession('busy');
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(app, 'server.js')], {
    env: { ...process.env, HOME: root, CLAW_HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', (d) => { errors += d; });
  for (let n = 0; n < 100; n++) {
    try { await request('/api/settings'); return; } catch { await sleep(30); }
  }
  throw new Error('Fixture server did not start: ' + errors);
});
after(async () => {
  for (const child of [server, session]) if (child && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('viewing the dashboard does not spend Claude credits by default', async () => {
  assert.equal((await request('/api/overview')).status, 200);
  await sleep(700);
  assert.equal(fs.existsSync(path.join(root, 'claude-calls')), false,
    'Passive monitoring must not launch Claude for labels or usage polling');
});

test('automatic closure is opt in and invalid timers cannot enable it', async () => {
  const settings = (await request('/api/settings')).body;
  assert.deepEqual(settings.sessions, { idleMinutes: 0, aiSummaries: false });
  assert.equal((await request('/api/settings', { sessions: { idleMinutes: -1 } })).status, 400);
  assert.equal((await request('/api/settings')).body.sessions.idleMinutes, 0);
});

test('bulk cleanup refuses a session that resumed work after the page loaded', async () => {
  setSession('busy');
  const res = await request('/api/stop', { id, idleOnly: true, pid: session.pid, statusSince: since });
  assert.equal(res.status, 409);
  assert.equal(session.exitCode, null);
});

test('bulk cleanup refuses an outdated process snapshot', async () => {
  setSession('idle');
  const res = await request('/api/stop', { id, idleOnly: true, pid: session.pid + 100000, statusSince: since });
  assert.equal(res.status, 409);
  assert.equal(session.exitCode, null);
});

test('a stale session record cannot stop an unrelated process with that PID', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    setSession('idle');
    const record = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    record.pid = unrelated.pid;
    fs.writeFileSync(sessionFile, JSON.stringify(record));
    const res = await request('/api/stop', { id, idleOnly: true, pid: unrelated.pid, statusSince: since });
    assert.equal(res.status, 409);
    assert.equal(unrelated.exitCode, null);
  } finally {
    unrelated.kill('SIGKILL');
    setSession('idle');
  }
});

test('stopping a process that ignores SIGTERM reports failure', async () => {
  session.kill('SIGKILL');
  await new Promise((resolve) => session.once('exit', resolve));
  session = spawn(fixtureClaude, ['-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => session.stdout.once('data', resolve));
  setSession('idle');
  const res = await request('/api/stop', { id });
  assert.equal(res.status, 409);
  assert.equal(session.exitCode, null);
});

test('the opt-in timer closes a completed session and preserves its transcript', { timeout: 40000 }, async () => {
  session.kill('SIGKILL');
  await new Promise((resolve) => session.once('exit', resolve));
  session = spawn(fixtureClaude, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  setSession('idle');
  assert.equal((await request('/api/settings', { sessions: { idleMinutes: 15 } })).status, 200);
  for (let n = 0; n < 350 && session.exitCode === null && session.signalCode === null; n++) await sleep(100);
  assert.notEqual(session.exitCode ?? session.signalCode, null, 'Timer should close the idle fixture process');
  assert.equal(fs.existsSync(path.join(root, '.claude/projects/fixture', id + '.jsonl')), true);
});
