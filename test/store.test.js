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

test('older backups without subscription logs remain restorable', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-store-'));
  t.after(() => fs.promises.rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'data.json');
  const store = await new Store(file).init();
  const oldBackup = store.snapshot();
  delete oldBackup.subscriptionAccess;
  delete oldBackup.subscriptionClients;
  await store.replace(oldBackup);
  assert.deepEqual(store.data.subscriptionAccess, []);
  assert.deepEqual(store.data.subscriptionClients, []);
  await fs.promises.writeFile(file, JSON.stringify(oldBackup));
  const loaded = await new Store(file).init();
  assert.deepEqual(loaded.data.subscriptionAccess, []);
  assert.deepEqual(loaded.data.subscriptionClients, []);
});

test('idle status updates and skipped transactions do not rewrite the database', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-store-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  const store = await new Store(file).init();
  const initial = await fs.promises.readFile(file, 'utf8');
  await store.transient((data) => { data.settings.lastHeartbeat = 'seen'; });
  assert.equal(store.data.settings.lastHeartbeat, 'seen');
  assert.equal(await store.transaction(() => Store.SKIP), null);
  assert.equal(await fs.promises.readFile(file, 'utf8'), initial);
  await store.transaction((data) => { data.customers.push({ id: 'cus_1' }); });
  assert.equal((await new Store(file).init()).data.settings.lastHeartbeat, 'seen');
});

test('transient updates serialize with concurrent durable transactions', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-store-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  const store = await new Store(file).init();
  const durable = store.transaction(async (data) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    data.settings.completedJobRetentionDays = 3;
  });
  const transient = store.transient((data) => { data.settings.lastHeartbeat = 'new'; });
  await Promise.all([durable, transient]);
  assert.equal(store.data.settings.lastHeartbeat, 'new');
  await store.transaction((data) => { data.settings.activityRetentionDays = 14; });
  const loaded = await new Store(file).init();
  assert.equal(loaded.data.settings.lastHeartbeat, 'new');
  assert.equal(loaded.data.settings.completedJobRetentionDays, 3);
});
