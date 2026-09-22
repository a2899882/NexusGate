'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

test('store persists transactions atomically', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-store-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  const store = await new Store(file).init();
  await store.transaction((data) => data.customers.push({ id: 'cus_1', name: '测试客户' }));
  const reloaded = await new Store(file).init();
  assert.equal(reloaded.data.customers.length, 1);
  assert.equal(reloaded.data.customers[0].name, '测试客户');
  assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
});

test('store rejects an invalid replacement', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-store-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const store = await new Store(path.join(dir, 'data.json')).init();
  await assert.rejects(() => store.replace({ schemaVersion: 99 }), /Unsupported or corrupt/);
  assert.equal(store.data.schemaVersion, 1);
});
