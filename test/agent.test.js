'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseX25519, parseUsageStats } = require('../agent/agent');
const { redactSecrets } = require('../lib/redact');

test('parses both current and older Xray x25519 output without including private keys in errors', () => {
  const current = parseX25519('PrivateKey: current_private\nPassword (PublicKey): current_public\nHash32: ignored');
  assert.deepEqual(current, { privateKey:'current_private', publicKey:'current_public' });
  const older = parseX25519('Private key: older_private\nPublic key: older_public');
  assert.equal(older.publicKey, 'older_public');
  assert.throws(() => parseX25519('PrivateKey: very_secret\nUnknown: broken'), (error) => !error.message.includes('very_secret'));
  assert.equal(redactSecrets('Unable to parse: PrivateKey: very_secret Password (PublicKey): public'),
    'Unable to parse: PrivateKey: [REDACTED] Password (PublicKey): public');
});

test('Xray candidate configuration has a JSON extension at validation time', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-agent-test-'));
  try {
    const fakeXray = path.join(temp, 'fake-xray');
    const configDir = path.join(temp, 'xray');
    fs.mkdirSync(path.join(configDir, 'resources'), { recursive:true });
    fs.writeFileSync(fakeXray, '#!/bin/sh\nprintf "%s\\n" "$4" > "' + path.join(temp, 'argument') + '"\nexit 41\n', { mode:0o755 });
    // Module paths are read at import time; test the real activation logic in a child.
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).activateConfig()`], {
      env:{ ...process.env, NG_CONFIG_DIR:configDir, NG_XRAY_BIN:fakeXray }, encoding:'utf8'
    });
    assert.notEqual(result.status, 0);
    const candidate = fs.readFileSync(path.join(temp, 'argument'), 'utf8').trim();
    assert.equal(candidate, path.join(configDir, 'config.json.candidate.json'));
    assert.equal(JSON.parse(fs.readFileSync(candidate, 'utf8')).inbounds[0].tag, 'api-in');
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('Agent restart preserves a healthy Xray process when configuration is unchanged', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-no-restart-'));
  try {
    const configDir = path.join(temp, 'xray');
    const binDir = path.join(temp, 'bin');
    fs.mkdirSync(path.join(configDir, 'resources'), { recursive:true });
    fs.mkdirSync(binDir);
    const agentFile = path.join(__dirname, '../agent/agent.js');
    const script = `const agent=require(${JSON.stringify(agentFile)});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(configDir,'config.json'))}, JSON.stringify(agent.combinedConfig([]), null, 2)+'\\n');agent.activateConfig()`;
    const { spawnSync } = require('node:child_process');
    const serviceCommand = fs.existsSync('/run/systemd/system') ? 'systemctl' : 'rc-service';
    fs.writeFileSync(path.join(binDir, serviceCommand), '#!/bin/sh\nexit 0\n', { mode:0o755 });
    const fakeXray = path.join(binDir, 'xray');
    fs.writeFileSync(fakeXray, '#!/bin/sh\nexit 91\n', { mode:0o755 });
    const result = spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, PATH:`${binDir}:${process.env.PATH}`, NG_CONFIG_DIR:configDir, NG_XRAY_BIN:fakeXray }, encoding:'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(configDir, 'config.json.candidate.json')), false);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('IP observations exclude exit hop addresses and leave partial log lines unread', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-observations-'));
  try {
    const dir = path.join(temp, 'config');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive:true });
    fs.writeFileSync(path.join(dir, 'resources', 'relay.json'), JSON.stringify({ id:'relay', meta:{ kind:'relay', metricsTag:'entry-tag', customerId:'customer-a' } }));
    fs.writeFileSync(path.join(dir, 'resources', 'exit.json'), JSON.stringify({ id:'exit', meta:{ kind:'exit', metricsTag:'exit-tag', customerId:'customer-a' } }));
    const accessLog = path.join(temp, 'access.log');
    const cursorFile = path.join(temp, 'cursor.json');
    const entry = '2026/09/23 from tcp:198.51.100.40:1234 accepted tcp:example.com:443 [entry-tag -> direct]';
    const exit = '2026/09/23 from tcp:192.0.2.20:3344 accepted tcp:example.com:443 [exit-tag -> direct]';
    fs.writeFileSync(accessLog, `${entry}\n${exit}\n${entry.slice(0, 28)}`);
    const { spawnSync } = require('node:child_process');
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).readObservations()))`;
    const run = spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, NG_CONFIG_DIR:dir, NG_XRAY_ACCESS_LOG:accessLog, NG_ACCESS_CURSOR:cursorFile }, encoding:'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.observations, [{ customerId:'customer-a', ip:'198.51.100.40' }]);
    assert.equal(result.offset, Buffer.byteLength(`${entry}\n${exit}\n`));
    assert.equal(fs.existsSync(cursorFile), false);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('Xray JSON counters are matched by name, including quoted values in either order', () => {
  const resources = [{ id:'resource-1', meta:{ kind:'direct', metricsTag:'ng-in' } }];
  const output = JSON.stringify({ stat:[
    { name:'inbound>>>other>>>traffic>>>downlink', value:'8000' },
    { name:'inbound>>>ng-in>>>traffic>>>downlink', value:'2048' },
    { name:'inbound>>>ng-in>>>traffic>>>uplink', value:'128' }
  ] });
  assert.deepEqual(parseUsageStats(output, resources), [{ resourceId:'resource-1', uplink:128, downlink:2048 }]);
  assert.deepEqual(parseUsageStats('{"stat":[]}', resources), []);
  assert.throws(() => parseUsageStats('not json', resources));
});

test('Agent reads cumulative counters without resetting Xray', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-usage-'));
  try {
    const dir = path.join(temp, 'xray');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive:true });
    fs.writeFileSync(path.join(dir, 'resources', 'entry.json'), JSON.stringify({ id:'entry', meta:{ kind:'direct', metricsTag:'entry-in' } }));
    const fakeXray = path.join(temp, 'xray-bin');
    const argumentsFile = path.join(temp, 'args');
    fs.writeFileSync(fakeXray, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\nprintf '{"stat":[{"name":"inbound>>>entry-in>>>traffic>>>uplink","value":"12"},{"name":"inbound>>>entry-in>>>traffic>>>downlink","value":"34"}]}'\n`, { mode:0o755 });
    const { spawnSync } = require('node:child_process');
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).queryUsage()))`;
    const run = spawnSync(process.execPath, ['-e', script], { env:{ ...process.env, NG_CONFIG_DIR:dir, NG_XRAY_BIN:fakeXray }, encoding:'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).samples, [{ resourceId:'entry', uplink:12, downlink:34 }]);
    assert.doesNotMatch(fs.readFileSync(argumentsFile, 'utf8'), /reset/);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});
