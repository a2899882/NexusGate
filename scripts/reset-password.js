'use strict';

const fs = require('node:fs');
const { hashSecret } = require('../lib/auth');

const file = process.env.NG_DATA_FILE || '/var/lib/nexusgate/nexusgate.json';
const username = process.argv[2] || 'admin';
const password = process.env.NG_NEW_PASSWORD || '';
if (password.length < 10) {
  console.error('密码至少需要 10 个字符');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const user = data.users.find((item) => item.username === username);
if (!user) {
  console.error(`用户不存在：${username}`);
  process.exit(1);
}
user.passwordHash = hashSecret(password);
user.updatedAt = new Date().toISOString();
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, file);
fs.chmodSync(file, 0o600);
console.log(`已更新用户 ${username} 的密码`);
