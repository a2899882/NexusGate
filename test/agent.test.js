'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { parseX25519, parseUsageStats, combinedConfig, udpPortsForPid, systemInfo } = require('../agent/agent');
const { redactSecrets } = require('../lib/redact');

test('Agent reports usable memory and system disk without reading per-connection state', () => {
  const info = systemInfo();
  assert.ok(info.memoryTotal >= info.memoryAvailable && info.memoryAvailable >= 0);
  assert.ok(info.cpuCount >= 1);
  if (info.diskTotal !== null) assert.ok(info.diskTotal >= info.diskAvailable && info.diskAvailable >= 0);
});

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

test('old Hysteria 2 resources are repaired without rotating authentication or changing saved resources', () => {
  const legacy = { id:'hy2-entry', inbounds:[{ tag:'hy2-in', protocol:'hysteria', port:34537,
    settings:{ version:2, users:[{ auth:'unchanged-password', email:'ng:customer' }] },
    streamSettings:{ method:'hysteria', security:'tls', hysteriaSettings:{ version:2 } } }] };
  const before = JSON.stringify(legacy);
  const inbound = combinedConfig([legacy]).inbounds[1];
  assert.equal(inbound.streamSettings.network, 'hysteria');
  assert.equal(inbound.settings.clients[0].auth, 'unchanged-password');
  assert.deepEqual(inbound.settings.clients, inbound.settings.users);
  assert.equal(JSON.stringify(legacy), before);
  assert.throws(() => combinedConfig([{ inbounds:[{ protocol:'hysteria', settings:{ version:2 } }] }]), /认证账户/);
});

test('UDP readiness inspection finds only ports owned by the target process', async () => {
  const socket = dgram.createSocket('udp4');
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore' });
  try {
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    assert.ok(udpPortsForPid(process.pid).has(socket.address().port));
    assert.equal(udpPortsForPid(other.pid).has(socket.address().port), false);
  } finally { socket.close(); other.kill(); }
});

test('Agent restart preserves a healthy Xray process when configuration is unchanged', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-no-restart-'));
  try {
    const configDir = path.join(temp, 'xray');
    const binDir = path.join(temp, 'bin');
    fs.mkdirSync(path.join(configDir, 'resources'), { recursive:true });
    fs.mkdirSync(binDir);
    const resource = { id:'entry-resource', meta:{ kind:'direct', metricsTag:'entry-in' },
      inbounds:[], outbounds:[], routingRules:[] };
    fs.writeFileSync(path.join(configDir, 'resources', 'entry.json'), JSON.stringify(resource));
    const agentFile = path.join(__dirname, '../agent/agent.js');
    const script = `const agent=require(${JSON.stringify(agentFile)});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(configDir,'config.json'))}, JSON.stringify(agent.combinedConfig([${JSON.stringify(resource)}]), null, 2)+'\\n');agent.activateConfig()`;
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
  assert.deepEqual(parseUsageStats('{}', resources), []);
  assert.deepEqual(parseUsageStats(JSON.stringify({ stat:[
    { name:'inbound>>>unrelated>>>traffic>>>uplink', value:'bad' },
    { name:'inbound>>>ng-in>>>traffic>>>uplink', value:'42' }
  ] }), resources), [{ resourceId:'resource-1', uplink:42, downlink:0 }]);
  assert.deepEqual(parseUsageStats(JSON.stringify({ stat:[
    { name:'inbound>>>ng-in>>>traffic>>>uplink' },
    { name:'inbound>>>ng-in>>>traffic>>>downlink', value:'1024' }
  ] }), resources), [{ resourceId:'resource-1', uplink:0, downlink:1024 }]);
  assert.throws(() => parseUsageStats(JSON.stringify({ stat:[
    { name:'inbound>>>ng-in>>>traffic>>>uplink', value:'undefined' }
  ] }), resources), /入口计数异常/);
  assert.throws(() => parseUsageStats(JSON.stringify({ stat:[
    { name:'inbound>>>ng-in>>>traffic>>>uplink', value:'-1' }
  ] }), resources), /入口计数异常（负数）/);
  assert.throws(() => parseUsageStats('not json', resources));
});

test('Agent does not advertise an untrusted self-signed node certificate as ready', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-certs-'));
  try {
    const domain = 'entry.example.com';
    const dir = path.join(temp, domain);
    fs.mkdirSync(dir);
    const result = require('node:child_process').spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-days', '2', '-keyout', path.join(dir, 'privkey.pem'), '-out', path.join(dir, 'fullchain.pem'),
      '-subj', `/CN=${domain}`, '-addext', `subjectAltName=DNS:${domain}`], { encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).installedCertificates()))`;
    const read = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, NG_TLS_DIR:temp }, encoding:'utf8'
    });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), []);
    const trusted = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, NG_TLS_DIR:temp, SSL_CERT_FILE:path.join(dir, 'fullchain.pem') }, encoding:'utf8'
    });
    assert.equal(trusted.status, 0, trusted.stderr);
    assert.deepEqual(JSON.parse(trusted.stdout), [domain]);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), 'not a private key');
    const mismatch = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, NG_TLS_DIR:temp, SSL_CERT_FILE:path.join(dir, 'fullchain.pem') }, encoding:'utf8'
    });
    assert.deepEqual(JSON.parse(mismatch.stdout), []);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
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
    assert.deepEqual(JSON.parse(run.stdout).samples, [{ resourceId:'entry', uplink:12, downlink:34, epoch:'xray:unknown' }]);
    assert.doesNotMatch(fs.readFileSync(argumentsFile, 'utf8'), /reset/);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('adding an Xray resource submits old ingress counters before restarting the engine', async () => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-flush-'));
  const dir = path.join(temp, 'xray');
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(path.join(dir, 'resources'), { recursive:true });
  fs.mkdirSync(bin);
  const old = { id:'old-resource', meta:{ kind:'direct', metricsTag:'old-in' }, inbounds:[], outbounds:[], routingRules:[] };
  fs.writeFileSync(path.join(dir, 'resources', 'old-resource.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(bin, 'xray'), '#!/bin/sh\nif [ "$1" = api ]; then printf \'{"stat":[{"name":"inbound>>>old-in>>>traffic>>>uplink","value":"123"},{"name":"inbound>>>old-in>>>traffic>>>downlink","value":"456"}]}\'; fi\n', { mode:0o755 });
  const manager = fs.existsSync('/run/systemd/system') ? 'systemctl' : 'rc-service';
  fs.writeFileSync(path.join(bin, manager), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(path.join(temp, 'service-commands'))}\nexit 0\n`, { mode:0o755 });
  const seen = [];
  const controller = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path:req.url, body:JSON.parse(Buffer.concat(chunks).toString('utf8')),
      newResourceAlreadyWritten:fs.existsSync(path.join(dir, 'resources', 'new-resource.json')) });
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  try {
    await new Promise((resolve) => controller.listen(0, '127.0.0.1', resolve));
    const script = `require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).applyResource({resource:${JSON.stringify({ id:'new-resource', meta:{ kind:'direct', metricsTag:'new-in' }, inbounds:[], outbounds:[], routingRules:[] })}}).catch(error=>{console.error(error);process.exitCode=1})`;
    const child = spawn(process.execPath, ['-e', script], { env:{ ...process.env,
      NG_CONFIG_DIR:dir, NG_XRAY_BIN:path.join(bin, 'xray'), NG_CONTROLLER:`http://127.0.0.1:${controller.address().port}`,
      NG_AGENT_KEY:'test-agent-key', PATH:`${bin}:${process.env.PATH}` }, stdio:['ignore','pipe','pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(exit, 0, stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/api/agent/usage');
    assert.deepEqual(seen[0].body.samples.map(({ resourceId, uplink, downlink }) => ({ resourceId, uplink, downlink })),
      [{ resourceId:'old-resource', uplink:123, downlink:456 }]);
    assert.equal(seen[0].newResourceAlreadyWritten, false);
    assert.match(fs.readFileSync(path.join(temp, 'service-commands'), 'utf8'), /restart/);
    const flush = spawn(process.execPath, [path.join(__dirname, '../agent/agent.js'), 'flush-usage'], { env:{ ...process.env,
      NG_CONFIG_DIR:dir, NG_XRAY_BIN:path.join(bin, 'xray'), NG_CONTROLLER:`http://127.0.0.1:${controller.address().port}`,
      NG_AGENT_KEY:'test-agent-key', PATH:`${bin}:${process.env.PATH}` }, stdio:'ignore' });
    assert.equal(await new Promise((resolve) => flush.on('exit', resolve)), 0);
    assert.equal(seen[1].path, '/api/agent/usage');
    fs.writeFileSync(path.join(bin, 'xray'), '#!/bin/sh\nif [ "$1" = api ]; then printf \'{"stat":[{"name":"inbound>>>old-in>>>traffic>>>uplink","value":"invalid"}]}\'; fi\n', { mode:0o755 });
    const badScript = `require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).applyResource({resource:${JSON.stringify({ id:'third-resource', meta:{ kind:'direct', metricsTag:'third-in' }, inbounds:[], outbounds:[], routingRules:[] })}}).catch(error=>{console.error(error);process.exitCode=1})`;
    const broken = spawn(process.execPath, ['-e', badScript], { env:{ ...process.env,
      NG_CONFIG_DIR:dir, NG_XRAY_BIN:path.join(bin, 'xray'), NG_CONTROLLER:`http://127.0.0.1:${controller.address().port}`,
      NG_AGENT_KEY:'test-agent-key', PATH:`${bin}:${process.env.PATH}` }, stdio:'ignore' });
    assert.equal(await new Promise((resolve) => broken.on('exit', resolve)), 1);
    assert.equal(fs.existsSync(path.join(dir, 'resources', 'third-resource.json')), false);
    assert.equal(seen.length, 2, 'invalid counters must block the restart before publishing a partial report');
  } finally {
    controller.close(); fs.rmSync(temp, { recursive:true, force:true });
  }
});

test('sing-box config isolates AnyTLS from Xray and meters each entry once', () => {
  const { combinedConfig, combinedSingBoxConfig } = require('../agent/agent');
  const entry = { id:'entry', engine:'sing-box', meta:{ kind:'direct', customerId:'customer-a', metricsTag:'any-in' },
    inbounds:[{ type:'anytls', tag:'any-in', listen:'0.0.0.0', listen_port:23000,
      users:[{ name:'ng:customer-a', password:'secret' }], tls:{ enabled:true, server_name:'entry.example.com',
        certificate_path:'/etc/nexusgate/tls/entry.example.com/fullchain.pem', key_path:'/etc/nexusgate/tls/entry.example.com/privkey.pem' } }],
    outbounds:[{ type:'direct', tag:'any-direct' }], routingRules:[{ inbound:['any-in'], action:'route', outbound:'any-direct' }] };
  const xray = combinedConfig([entry]);
  assert.equal(xray.inbounds.length, 1);
  const sing = combinedSingBoxConfig([entry]);
  assert.equal(sing.inbounds[0].tag, 'any-in');
  assert.deepEqual(sing.experimental.v2ray_api.stats.inbounds, ['any-in']);
  assert.equal(sing.route.rules[0].outbound, 'any-direct');
  assert.deepEqual(parseUsageStats(JSON.stringify({ stat:[
    { name:'inbound>>>any-in>>>traffic>>>uplink', value:'10' },
    { name:'inbound>>>any-in>>>traffic>>>downlink', value:'90' } ] }), [entry]),
  [{ resourceId:'entry', uplink:10, downlink:90 }]);
});

test('Agent queries sing-box counters with its own helper and never resets them', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-singbox-usage-'));
  try {
    const dir = path.join(temp, 'xray');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive:true });
    fs.writeFileSync(path.join(dir, 'resources', 'anytls.json'), JSON.stringify({
      id:'anytls', engine:'sing-box', meta:{ kind:'direct', metricsTag:'any-in' }
    }));
    const helper = path.join(temp, 'stats');
    const argumentsFile = path.join(temp, 'args');
    fs.writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\nprintf '{"stat":[{"name":"inbound>>>any-in>>>traffic>>>uplink","value":"1024"},{"name":"inbound>>>any-in>>>traffic>>>downlink","value":"4096"}]}'\n`, { mode:0o755 });
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).queryUsage()))`;
    const run = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
      env:{ ...process.env, NG_CONFIG_DIR:dir, NG_SINGBOX_STATS_BIN:helper, NG_XRAY_BIN:'/nonexistent/xray' }, encoding:'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).samples, [{ resourceId:'anytls', uplink:1024, downlink:4096, epoch:'sing-box:unknown' }]);
    assert.deepEqual(fs.readFileSync(argumentsFile, 'utf8').trim().split('\n'), ['--server=127.0.0.1:10086']);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});

test('AnyTLS IP observations require matching authenticated session and preserve partial lines', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-anytls-ip-'));
  try {
    const dir = path.join(temp, 'config');
    fs.mkdirSync(path.join(dir, 'resources'), { recursive:true });
    fs.writeFileSync(path.join(dir, 'resources', 'entry.json'), JSON.stringify({ id:'entry', engine:'sing-box',
      meta:{ kind:'relay', metricsTag:'any-in', customerId:'customer-a' } }));
    const file = path.join(temp, 'sing-box.log');
    const source = '+0000 2026-09-23 18:00:00 INFO [31200 0ms] inbound/anytls[any-in]: inbound connection from 198.51.100.12:50000';
    const authenticated = '+0000 2026-09-23 18:00:01 INFO [31200 1ms] inbound/anytls[any-in]: [ng:customer-a] inbound connection to example.com:443';
    const wrongUser = '+0000 2026-09-23 18:00:02 INFO [31201 1ms] inbound/anytls[any-in]: [ng:other] inbound connection to example.com:443';
    fs.writeFileSync(file, `${source}\n${authenticated}\n${wrongUser}\n${source.slice(0, 35)}`);
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).readSingBoxObservations()))`;
    const run = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding:'utf8',
      env:{ ...process.env, NG_CONFIG_DIR:dir, NG_SINGBOX_LOG:file, NG_SINGBOX_CURSOR:path.join(temp, 'cursor.json') } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { observations:[{ customerId:'customer-a', ip:'198.51.100.12' }],
      offset:Buffer.byteLength(`${source}\n${authenticated}\n${wrongUser}\n`) });
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});
