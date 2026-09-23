'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const VERSION = '0.5.2';
const CONTROLLER = String(process.env.NG_CONTROLLER || '').replace(/\/+$/, '');
const AGENT_KEY = process.env.NG_AGENT_KEY || '';
const XRAY_BIN = process.env.NG_XRAY_BIN || '/usr/local/bin/xray';
const ROOT = process.env.NG_CONFIG_DIR || '/etc/nexusgate/xray';
const RESOURCE_DIR = path.join(ROOT, 'resources');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const KEY_FILE = process.env.NG_KEY_FILE || '/etc/nexusgate/keys.json';
const ACCESS_LOG = process.env.NG_XRAY_ACCESS_LOG || '/var/log/nexusgate/xray-access.log';
const CURSOR_FILE = process.env.NG_ACCESS_CURSOR || '/etc/nexusgate/access-cursor.json';
const POLL_MS = Math.max(3, Number(process.env.NG_POLL_SECONDS || 8)) * 1000;
let lastEngineError = '';

function parseX25519(output) {
  const privateKey = (output.match(/\bPrivate\s*Key\s*:\s*([A-Za-z0-9_-]+)/i) || [])[1];
  const publicKey = (output.match(/\b(?:Public\s*Key|Password\s*\(\s*Public\s*Key\s*\)|Password)\s*:\s*([A-Za-z0-9_-]+)/i) || [])[1];
  if (!privateKey || !publicKey) throw new Error('Unable to parse x25519 output (keys suppressed); update the Agent and Xray');
  return { privateKey, publicKey };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function log(...args) { console.log(new Date().toISOString(), ...args); }
function safeError(value) {
  return String(value || '').replace(/\bPrivate\s*Key\s*:\s*[^\s,;]+/gi, 'PrivateKey: [REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

async function request(endpoint, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${CONTROLLER}${endpoint}`, {
      ...options,
      headers: { authorization: `Bearer ${AGENT_KEY}`, 'content-type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `Controller returned ${response.status}`);
    return body;
  } finally { clearTimeout(timeout); }
}

function ensureDirectories() {
  fs.mkdirSync(RESOURCE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync('/var/log/nexusgate', { recursive: true, mode: 0o750 });
}

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function saveKeys(keys) {
  const temp = `${KEY_FILE}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, KEY_FILE); fs.chmodSync(KEY_FILE, 0o600);
}

function realityKey(keyId) {
  const keys = loadKeys();
  if (keys[keyId]) return keys[keyId];
  const result = spawnSync(XRAY_BIN, ['x25519'], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error('xray x25519 failed; run ng-agent doctor to inspect Xray locally');
  const output = `${result.stdout}\n${result.stderr}`;
  const { privateKey, publicKey } = parseX25519(output);
  keys[keyId] = { privateKey, publicKey, createdAt: new Date().toISOString() };
  saveKeys(keys);
  return keys[keyId];
}

function materialize(value, artifacts) {
  if (Array.isArray(value)) return value.map((item) => materialize(item, artifacts));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, artifacts)]));
  if (typeof value !== 'string') return value;
  const match = value.match(/^\$\{REALITY_PRIVATE:(.+)}$/);
  if (!match) return value;
  const pair = realityKey(match[1]);
  artifacts.realityPublicKey = pair.publicKey;
  return pair.privateKey;
}

function readResources() {
  return fs.readdirSync(RESOURCE_DIR).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, name), 'utf8')));
}

function combinedConfig(resources) {
  const apiPort = Number(process.env.NG_XRAY_API_PORT || 10085);
  const config = {
    log: { loglevel: process.env.NG_XRAY_LOG_LEVEL || 'warning', access: '/var/log/nexusgate/xray-access.log', error: '/var/log/nexusgate/xray-error.log' },
    api: { tag: 'api', services: ['StatsService'] },
    stats: {},
    policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } }, system: { statsInboundUplink: true, statsInboundDownlink: true } },
    inbounds: [{ tag: 'api-in', listen: '127.0.0.1', port: apiPort, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } }],
    outbounds: [],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', inboundTag: ['api-in'], outboundTag: 'api' }] }
  };
  for (const resource of resources) {
    config.inbounds.push(...(resource.inbounds || []));
    config.outbounds.push(...(resource.outbounds || []));
    config.routing.rules.push(...(resource.routingRules || []));
  }
  return config;
}

function run(command, args, timeout = 30000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${safeError(result.stderr || result.stdout || '').slice(0, 1200)}`);
  return result.stdout;
}

function restartXray() {
  if (fs.existsSync('/run/systemd/system')) return run('systemctl', ['restart', 'nexusgate-xray.service']);
  return run('rc-service', ['nexusgate-xray', 'restart']);
}

function activateConfig() {
  // Xray detects JSON from the file extension; a .candidate suffix is rejected.
  const candidate = `${CONFIG_FILE}.candidate.json`;
  const previous = `${CONFIG_FILE}.previous`;
  const nextConfig = `${JSON.stringify(combinedConfig(readResources()), null, 2)}\n`;
  // An Agent update must not restart a healthy Xray with identical configuration:
  // its in-memory traffic counters would be discarded before the next report.
  if (fs.existsSync(CONFIG_FILE) && fs.readFileSync(CONFIG_FILE, 'utf8') === nextConfig &&
      engineHealth().status === 'ready') return;
  fs.writeFileSync(candidate, nextConfig, { mode: 0o600 });
  run(XRAY_BIN, ['run', '-test', '-config', candidate]);
  if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, previous);
  fs.renameSync(candidate, CONFIG_FILE);
  try {
    restartXray();
  } catch (error) {
    if (fs.existsSync(previous)) {
      fs.copyFileSync(previous, CONFIG_FILE);
      try { restartXray(); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

function safeResourcePath(resourceId) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(resourceId))) throw new Error('Invalid resource id');
  return path.join(RESOURCE_DIR, `${resourceId}.json`);
}

function applyResource(payload) {
  if (!payload || !payload.resource || !payload.resource.id) throw new Error('Missing resource payload');
  const artifacts = {};
  const resource = materialize(payload.resource, artifacts);
  for (const inbound of resource.inbounds || []) {
    const tls = inbound.streamSettings && inbound.streamSettings.tlsSettings;
    if (!tls) continue;
    const domain = tls.serverName;
    const expected = `/etc/nexusgate/tls/${domain}/`;
    for (const cert of tls.certificates || []) {
      if (!cert.certificateFile.startsWith(expected) || !cert.keyFile.startsWith(expected) ||
          !fs.existsSync(cert.certificateFile) || !fs.existsSync(cert.keyFile)) {
        throw new Error(`TLS certificate for ${domain} is missing; run ng-agent cert issue ${domain} EMAIL or ng-agent cert import`);
      }
      run('openssl', ['x509', '-in', cert.certificateFile, '-noout', '-checkend', '86400']);
      const nameCheck = run('openssl', ['x509', '-in', cert.certificateFile, '-noout', '-checkhost', domain]);
      if (!nameCheck.includes('does match')) throw new Error(`TLS certificate does not match ${domain}`);
    }
  }
  const target = safeResourcePath(resource.id);
  const backup = fs.existsSync(target) ? fs.readFileSync(target) : null;
  fs.writeFileSync(target, `${JSON.stringify(resource, null, 2)}\n`, { mode: 0o600 });
  try { activateConfig(); lastEngineError = ''; }
  catch (error) {
    if (backup) fs.writeFileSync(target, backup, { mode: 0o600 }); else fs.rmSync(target, { force: true });
    throw error;
  }
  return { artifacts };
}

function deleteResource(payload) {
  const target = safeResourcePath(payload.resourceId);
  if (!fs.existsSync(target)) return { alreadyAbsent: true };
  const backup = fs.readFileSync(target);
  fs.rmSync(target);
  try { activateConfig(); }
  catch (error) { fs.writeFileSync(target, backup, { mode: 0o600 }); throw error; }
  return { removed: true };
}

async function execute(job) {
  log('Executing', job.id, job.action);
  try {
    let result;
    if (job.action === 'apply_resource') result = applyResource(job.payload);
    else if (job.action === 'delete_resource') result = deleteResource(job.payload);
    else throw new Error(`Unsupported job action: ${job.action}`);
    await request(`/api/agent/jobs/${encodeURIComponent(job.id)}/complete`, { method: 'POST', body: JSON.stringify({ success: true, result }) });
    log('Completed', job.id);
  } catch (error) {
    log('Failed', job.id, safeError(error.message));
    try { await request(`/api/agent/jobs/${encodeURIComponent(job.id)}/complete`, { method: 'POST', body: JSON.stringify({ success: false, error: safeError(error.message) }) }); }
    catch (reportError) { log('Unable to report failure', reportError.message); }
  }
}

function systemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()), load1: Number(os.loadavg()[0].toFixed(2)),
    cpuCount: cpus.length, memoryTotal: os.totalmem(), memoryFree: os.freemem()
  };
}

function engineHealth() {
  const result = fs.existsSync('/run/systemd/system')
    ? spawnSync('systemctl', ['is-active', 'nexusgate-xray.service'], { encoding:'utf8', timeout:3000 })
    : spawnSync('rc-service', ['nexusgate-xray', 'status'], { encoding:'utf8', timeout:3000 });
  return { status: result.status === 0 ? 'ready' : 'error', detail: (result.status === 0 ? result.stdout : lastEngineError || result.stderr || result.stdout || '').trim().slice(0, 400) };
}

async function heartbeat() {
  await request('/api/agent/heartbeat', { method: 'POST', body: JSON.stringify({ version: VERSION, system: systemInfo(), engine: engineHealth() }) });
  try { fs.writeFileSync('/etc/nexusgate/last-heartbeat.json', `${JSON.stringify({ at:new Date().toISOString() })}\n`, { mode:0o600 }); }
  catch (error) { log('Heartbeat reached controller but readiness file failed', error.message); }
}

function parseUsageStats(output, resources) {
  const parsed = JSON.parse(output);
  if (!parsed || !Array.isArray(parsed.stat || [])) throw new Error('Xray statsquery returned invalid JSON');
  const byName = new Map();
  for (const stat of parsed.stat || []) {
    const value = Number(stat.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Xray counter: ${stat.name}`);
    byName.set(stat.name, value);
  }
  return resources.flatMap((resource) => {
    const prefix = `inbound>>>${resource.meta.metricsTag}>>>traffic>>>`;
    if (!byName.has(`${prefix}uplink`) && !byName.has(`${prefix}downlink`)) return [];
    return [{ resourceId: resource.id, uplink: byName.get(`${prefix}uplink`) || 0, downlink: byName.get(`${prefix}downlink`) || 0 }];
  });
}

function xrayEpoch() {
  let pid;
  if (fs.existsSync('/run/systemd/system')) {
    const result = spawnSync('systemctl', ['show', '-p', 'MainPID', '--value', 'nexusgate-xray.service'], { encoding:'utf8', timeout:3000 });
    if (result.status === 0) pid = Number(result.stdout.trim());
  } else {
    try { pid = Number(fs.readFileSync('/run/nexusgate-xray.pid', 'utf8').trim()); } catch { /* service is not running */ }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // PID alone can be reused; the Linux process start tick distinguishes a new Xray instance.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTick = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    return startTick ? `${pid}:${startTick}` : null;
  } catch { return null; }
}

function queryUsage() {
  // Count client ingress once; counting the exit as well doubles forwarded traffic.
  const resources = readResources().filter((resource) => resource.meta && resource.meta.metricsTag &&
    ['relay', 'direct'].includes(resource.meta.kind));
  if (!resources.length) return { samples: [], error: null, epoch: xrayEpoch() };
  const before = xrayEpoch();
  const result = spawnSync(XRAY_BIN, ['api', 'statsquery', `--server=127.0.0.1:${process.env.NG_XRAY_API_PORT || 10085}`, '-pattern', 'inbound>>>'],
    { encoding: 'utf8', timeout: 15000 });
  const after = xrayEpoch();
  if (before && after && before !== after) throw new Error('Xray restarted during statistics query; retry on next cycle');
  if (result.status !== 0) throw new Error(`Xray statsquery failed: ${safeError(result.stderr || result.error?.message || result.stdout).slice(0, 220)}`);
  const samples = parseUsageStats(result.stdout, resources);
  return { samples, epoch: before || after, error: samples.length ? null : '入口尚无 Xray 统计记录；若已实际使用，请检查节点是否连到本机 Xray' };
}

function readObservations() {
  if (!fs.existsSync(ACCESS_LOG)) return { observations: [], offset: null };
  let cursor = { offset: 0 };
  try { cursor = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); } catch { /* first read */ }
  const stat = fs.statSync(ACCESS_LOG);
  if (stat.size < cursor.offset) cursor.offset = 0;
  const start = Math.max(cursor.offset, stat.size - 2 * 1024 * 1024);
  if (start >= stat.size) return { observations: [], offset: null };
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(ACCESS_LOG, 'r');
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  const finalNewline = buffer.lastIndexOf(10);
  if (finalNewline < 0) return { observations: [], offset: null };
  const offset = start + finalNewline + 1;
  // The exit inbound sees relay server IPs, not client IPs. Never count those as customer devices.
  const tagCustomers = new Map(readResources().filter((item) => item.meta &&
    ['relay', 'direct'].includes(item.meta.kind) && item.meta.metricsTag && item.meta.customerId)
    .map((item) => [item.meta.metricsTag, item.meta.customerId]));
  const unique = new Map();
  for (const line of buffer.subarray(0, finalNewline).toString('utf8').split('\n')) {
    const source = line.match(/(?:from|accepted from)\s+(?:tcp|udp):(?:\[([^\]]+)\]|([^:\s]+)):\d+/i)
      || line.match(/\s(?:tcp:)?(?:\[([^\]]+)\]|((?:\d{1,3}\.){3}\d{1,3})):\d+\s+accepted\s/i);
    if (!source) continue;
    const ip = source[1] || source[2];
    for (const [tag, customerId] of tagCustomers) {
      if (line.includes(`[${tag} ->`) || line.includes(`[${tag}]`)) unique.set(`${customerId}|${ip}`, { customerId, ip });
    }
  }
  return { observations: [...unique.values()], offset };
}

async function usageLoop() {
  while (true) {
    await sleep(60000);
    try {
      let report;
      try { report = queryUsage(); }
      catch (error) { report = { samples: [], error: safeError(error.message) }; }
      await request('/api/agent/usage', { method: 'POST', body: JSON.stringify(report) });
    } catch (error) { log('Usage report failed', safeError(error.message)); }
    try {
      const { observations, offset } = readObservations();
      if (observations.length) await request('/api/agent/observations', { method: 'POST', body: JSON.stringify({ observations }) });
      // A failed upload must not advance the cursor; retry the same log lines next cycle.
      if (offset !== null) fs.writeFileSync(CURSOR_FILE, `${JSON.stringify({ offset })}\n`, { mode: 0o600 });
    } catch (error) { log('IP observation report failed', safeError(error.message)); }
  }
}

async function pollLoop() {
  while (true) {
    try {
      const result = await request('/api/agent/poll', { method: 'POST', body: '{}' });
      if (result.job) await execute(result.job);
      else await sleep(POLL_MS);
    } catch (error) { log('Poll failed', error.message); await sleep(Math.max(POLL_MS, 10000)); }
  }
}

async function main() {
  if (!CONTROLLER || !AGENT_KEY) throw new Error('NG_CONTROLLER and NG_AGENT_KEY are required');
  ensureDirectories();
  log(`NexusGate Agent v${VERSION} starting`);
  // Keep the control channel alive even when a stale node configuration cannot start.
  // The administrator can then see the engine error and a repair job can be claimed.
  try { activateConfig(); } catch (error) { lastEngineError = safeError(error.message); log('Initial Xray activation failed', lastEngineError); }
  try { await heartbeat(); } catch (error) { log('Initial heartbeat failed', error.message); }
  setInterval(() => heartbeat().catch((error) => log('Heartbeat failed', error.message)), 30000).unref();
  usageLoop();
  await pollLoop();
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { parseX25519, activateConfig, combinedConfig, applyResource, readObservations, parseUsageStats, queryUsage };
