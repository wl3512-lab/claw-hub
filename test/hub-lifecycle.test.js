'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('closing a detached hub chat also stops its child processes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-lifecycle-'));
  const dir = path.join(root, 'data/hub');
  fs.mkdirSync(dir, { recursive: true });
  const parent = spawn(process.execPath, ['-e', `
    const {spawn} = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* exited */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const childPid = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const out = path.join(dir, 'fixture.out');
  fs.writeFileSync(out, '');
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({
    pid: parent.pid, sessionId, cwd: root, startedAt: Date.now(), out,
    fifo: path.join(dir, 'fixture.in'), err: path.join(dir, 'fixture.err'),
  }));
  const filename = path.join(__dirname, '../lib/hub-chats.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), __dirname: path.join(root, 'lib'), module: mod,
    process, console, Buffer, setInterval, clearInterval, setTimeout, clearTimeout,
  }, { filename });
  const stopped = mod.exports.stop(sessionId);
  assert.throws(() => mod.exports.send(sessionId, 'one more task'), /closing/);
  assert.throws(() => mod.exports.answer(sessionId, { allow: true }), /closing/);
  assert.equal(await stopped, true);
  await sleep(250);
  assert.equal(alive(childPid), false, 'A leftover child can keep doing work after its chat closes');
  assert.equal(fs.existsSync(path.join(dir, 'fixture.json')), false);
});
