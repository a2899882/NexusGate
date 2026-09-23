'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashSecret, verifySecret } = require('../lib/auth');

test('SSH account reset can rename the owner and change password without changing file ownership', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-account-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nexusgate.json');
  await fs.promises.writeFile(file, JSON.stringify({ users: [{ id:'usr_1', username:'admin', role:'owner', status:'active', passwordHash:hashSecret('old-password') }] }), { mode:0o600 });
  const original = await fs.promises.stat(file);
  const result = spawnSync(process.execPath, ['scripts/reset-password.js'], {
    cwd: path.resolve(__dirname, '..'), encoding:'utf8',
    env: { ...process.env, NG_DATA_FILE:file, NG_NEW_USERNAME:'operator_1', NG_NEW_PASSWORD:'new-password-123' }
  });
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  assert.equal(updated.users[0].username, 'operator_1');
  assert.ok(verifySecret('new-password-123', updated.users[0].passwordHash));
  assert.equal((await fs.promises.stat(file)).uid, original.uid);
  assert.equal((await fs.promises.stat(file)).gid, original.gid);
});
