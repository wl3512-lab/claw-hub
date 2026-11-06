'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('testing iMessage does not enable unsaved cleanup or AI settings', async () => {
  const elements = new Map();
  const calls = [];
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: '', checked: false, addEventListener() {} });
    return elements.get(selector);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8'), {
    $, setHtml() {}, esc: String, toast() {},
    api: async (route, body) => { calls.push({ route, body }); return { ok: true }; },
  });
  $('#idleMinutes').value = '15';
  $('#aiSummaries').checked = true;
  $('#imHandle').value = 'fixture@example.invalid';
  await $('#imTest').onclick();
  assert.equal(calls[0].route, '/api/settings');
  assert.equal(calls[0].body.sessions, undefined);
  assert.equal(calls[0].body.imessage.handle, 'fixture@example.invalid');
  assert.equal(calls[1].route, '/api/imessage/test');
});
