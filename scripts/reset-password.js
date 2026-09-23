'use strict';

const fs = require('node:fs');
const { hashSecret } = require('../lib/auth');

const file = process.env.NG_DATA_FILE || '/var/lib/nexusgate/nexusgate.json';
const username = process.argv[2] || '';
const nextUsername = String(process.env.NG_NEW_USERNAME || '').trim();
const password = process.env.NG_NEW_PASSWORD || '';
if (password && password.length < 10) {
  console.error('密码至少需要 10 个字符');
  process.exit(1);
}
if (nextUsername && (!/^[a-zA-Z0-9_.-]{3,64}$/.test(nextUsername))) {
  console.error('账号只能使用 3–64 位英文字母、数字、下划线、点或连字符');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const originalStat = fs.statSync(file);
const user = username ? data.users.find((item) => item.username === username) : data.users.find((item) => item.role === 'owner' && item.status === 'active');
if (!user) {
  console.error('管理员账号不存在');
  process.exit(1);
}
if (!nextUsername && !password) {
  console.error('账号和密码均未更改');
  process.exit(1);
}
if (nextUsername && data.users.some((item) => item.id !== user.id && item.username === nextUsername)) {
  console.error('账号已被使用');
  process.exit(1);
}
if (nextUsername) user.username = nextUsername;
if (password) user.passwordHash = hashSecret(password);
user.updatedAt = new Date().toISOString();
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.chownSync(temp, originalStat.uid, originalStat.gid);
fs.renameSync(temp, file);
fs.chmodSync(file, 0o600);
console.log(`已更新管理员账号：${user.username}`);
