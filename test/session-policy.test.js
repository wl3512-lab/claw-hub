'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canClose } = require('../lib/session-policy');

const now = 1800000000000;
const live = { status: 'idle', entrypoint: 'cli', statusSince: now - 3600000, verifiedProcess: true };
const activity = { kind: 'say', completed: true, asking: false, ts: now - 3601000 };
test('only completed, quiet sessions are eligible for cleanup', () => {
  assert.equal(canClose(live, activity, [], now), true);
  const cases = [
    [{ status: 'busy' }, {}, []],
    [{ status: 'unknown' }, {}, []],
    [{ verifiedProcess: false }, {}, []],
    [{ pending: { kind: 'perm' } }, {}, []],
    [{ queued: 1 }, {}, []],
    [{ stopping: true }, {}, []],
    [{ phone: true }, {}, []],
    [{ entrypoint: 'claude-vscode' }, {}, []],
    [{ statusSince: now - 60000 }, {}, []],
    [{ statusSince: undefined }, {}, []],
    [{}, { asking: true }, []],
    [{}, { completed: false }, []],
    [{}, { ts: now - 60000 }, []],
    [{}, {}, [{ status: 'run' }]],
    [{}, {}, [{ status: 'stuck' }]],
  ];
  for (const [session, turn, helpers] of cases) {
    assert.equal(canClose({ ...live, ...session }, { ...activity, ...turn }, helpers, now), false,
      JSON.stringify({ session, turn, helpers }));
  }
  assert.equal(canClose({ ...live, statusSince: now - 20 * 60000 }, activity, [], now, 15), true);
  assert.equal(canClose({ ...live, statusSince: now - 20 * 60000 }, activity, [], now, 30), false);
});
