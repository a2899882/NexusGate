'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { Store } = require('./lib/store');
const { hashSecret, verifySecret, randomToken, SessionManager } = require('./lib/auth');
const { sendJson, sendError, readJson, route, serveStatic } = require('./lib/http');
const { PROFILE_CATALOG, REALITY_PRESETS, validateEntryProtocol, validateProtocolPair, isRealityProtocol } = require('./lib/protocols');
const { Orchestrator, audit, id, nowIso, suspendCustomerResources, resumeCustomerResources } = require('./lib/orchestrator');
const { formatSubscription } = require('./lib/subscriptions');
const { redactSecrets } = require('./lib/redact');
const { clientIdentity, activeClients, observedIps, pruneAccess } = require('./lib/access');

const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_FILE = process.env.NG_DATA_FILE || path.join(APP_ROOT, 'data', 'nexusgate.json');
const HOST = process.env.NG_HOST || '127.0.0.1';
const PORT = Number(process.env.NG_PORT || 8787);
const COOKIE_SECURE = process.env.NG_COOKIE_SECURE !== 'false';
const VERSION = '0.6.8';

const store = new Store(DATA_FILE);
let sessions;
let orchestrator;
const loginAttempts = new Map();

function cleanText(value, max = 120) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function requiredText(value, label, max = 120) {
  const result = cleanText(value, max);
  if (!result) {
    const error = new Error(`${label}不能为空`);
    error.statusCode = 400;
    throw error;
  }
  return result;
}

function asIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

function tokenFingerprint(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function optionalIso(value, label = '日期') {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) { const error = new Error(`${label}格式无效`); error.statusCode = 400; throw error; }
  return date.toISOString();
}

function nonNegativeNumber(value, label, integer = false) {
  const number = Number(value == null || value === '' ? 0 : value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    const error = new Error(`${label}必须是非负${integer ? '整数' : '数字'}`); error.statusCode = 400; throw error;
  }
  return number;
}

function normalizeServer(body, current = {}) {
  const next = {
    ...current,
    name: 'name' in body ? requiredText(body.name, '服务器名称') : current.name,
    role: 'role' in body && ['relay', 'exit', 'hybrid'].includes(body.role) ? body.role : (current.role || 'hybrid'),
    region: 'region' in body ? cleanText(body.region, 80) : (current.region || ''),
    publicAddress: 'publicAddress' in body ? requiredText(body.publicAddress, '公网地址', 255) : current.publicAddress,
    publicAddressV6: 'publicAddressV6' in body ? cleanText(body.publicAddressV6, 255) : (current.publicAddressV6 || ''),
    tlsDomain: 'tlsDomain' in body ? cleanText(body.tlsDomain, 253).toLowerCase() : (current.tlsDomain || ''),
    portRangeStart: 'portRangeStart' in body ? Number(body.portRangeStart) : Number(current.portRangeStart || 20000),
    portRangeEnd: 'portRangeEnd' in body ? Number(body.portRangeEnd) : Number(current.portRangeEnd || 50000),
    labels: 'labels' in body ? asIds(body.labels).slice(0, 20) : (current.labels || [])
  };
  if (!Number.isInteger(next.portRangeStart) || !Number.isInteger(next.portRangeEnd) || next.portRangeStart < 1024 || next.portRangeEnd > 65535 || next.portRangeStart > next.portRangeEnd) {
    const error = new Error('端口范围必须是 1024–65535 之间的整数'); error.statusCode = 400; throw error;
  }
  if (next.tlsDomain && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(next.tlsDomain))) {
    const error = new Error('TLS 域名必须是有效的公网域名'); error.statusCode = 400; throw error;
  }
  return next;
}

function normalizeChain(body, current = {}) {
  const topology = 'topology' in body ? (body.topology === 'direct' ? 'direct' : 'forward') : (current.topology || 'forward');
  const next = {
    ...current,
    name: 'name' in body ? requiredText(body.name, '线路名称') : current.name,
    topology,
    relayServerIds: 'relayServerIds' in body ? asIds(body.relayServerIds) : (current.relayServerIds || []),
    exitServerId: topology === 'direct' ? null : ('exitServerId' in body ? requiredText(body.exitServerId, '出口服务器 ID') : current.exitServerId),
    customerIds: 'customerIds' in body ? asIds(body.customerIds) : (current.customerIds || []),
    relayProtocol: 'relayProtocol' in body ? cleanText(body.relayProtocol, 64) : current.relayProtocol,
    exitProtocol: topology === 'direct' ? null : ('exitProtocol' in body ? cleanText(body.exitProtocol, 64) : current.exitProtocol),
    relayPortMode: 'relayPortMode' in body ? (body.relayPortMode === 'fixed' ? 'fixed' : 'random') : (current.relayPortMode || 'random'),
    relayPort: 'relayPort' in body ? (body.relayPort ? Number(body.relayPort) : null) : (current.relayPort || null),
    exitPortMode: topology === 'direct' ? null : ('exitPortMode' in body ? (body.exitPortMode === 'fixed' ? 'fixed' : 'random') : (current.exitPortMode || 'random')),
    exitPort: topology === 'direct' ? null : ('exitPort' in body ? (body.exitPort ? Number(body.exitPort) : null) : (current.exitPort || null)),
    networkMode: 'networkMode' in body && ['ipv4', 'ipv6', 'dual'].includes(body.networkMode) ? body.networkMode : (current.networkMode || 'ipv4'),
    realityServerName: 'realityServerName' in body ? cleanText(body.realityServerName, 255) : (current.realityServerName || 'www.tesla.com'),
    realityDestPort: 'realityDestPort' in body ? Number(body.realityDestPort || 443) : Number(current.realityDestPort || 443)
  };
  if (!next.relayServerIds.length || !next.customerIds.length) { const error = new Error('请选择入口服务器和客户'); error.statusCode = 400; throw error; }
  if (next.relayPortMode === 'fixed' && (!Number.isInteger(next.relayPort) || next.relayPort < 1024 || next.relayPort > 65535)) { const error = new Error('固定入口端口无效'); error.statusCode = 400; throw error; }
  if (topology === 'forward' && next.exitPortMode === 'fixed' && (!Number.isInteger(next.exitPort) || next.exitPort < 1024 || next.exitPort > 65535)) { const error = new Error('固定出口端口无效'); error.statusCode = 400; throw error; }
  if (topology === 'direct') validateEntryProtocol(next.relayProtocol); else validateProtocolPair(next.relayProtocol, next.exitProtocol);
  if (isRealityProtocol(next.relayProtocol) && !next.realityServerName) { const error = new Error('Reality SNI 不能为空'); error.statusCode = 400; throw error; }
  if (isRealityProtocol(next.relayProtocol) && (!Number.isInteger(next.realityDestPort) || next.realityDestPort < 1 || next.realityDestPort > 65535)) { const error = new Error('Reality 目标端口无效'); error.statusCode = 400; throw error; }
  return next;
}

function publicDeployment(item) {
  const { credentials, clientTemplate, ...safe } = item;
  return { ...safe, ...(safe.error ? { error: redactSecrets(safe.error) } : {}) };
}

function publicServer(item) {
  return { ...item, ...(item.engine ? { engine: { ...item.engine, detail: redactSecrets(item.engine.detail) } } : {}),
    agentVersion: store.data.agents.find((agent) => agent.serverId === item.id && agent.status === 'active')?.version || null,
    pendingCleanup: store.data.deployments.filter((entry) => entry.serverId === item.id && entry.archived && entry.status !== 'deleted').length };
}

function publicCustomer(item) {
  return { ...item, pendingCleanup: store.data.deployments.filter((entry) => entry.customerId === item.id && entry.archived && entry.status !== 'deleted').length,
    observedIpCount: observedIps(store.data, item.id).length,
    subscriptionClientCount: activeClients(store.data, item.id).length };
}

function customerBlockReason(data, customer) {
  if (customer.expiresAt && Date.parse(customer.expiresAt) <= Date.now()) return 'expired';
  if (customer.trafficLimitBytes > 0 && customer.usedBytes >= customer.trafficLimitBytes) return 'traffic_limit';
  if (customer.ipLimit > 0 && new Set(observedIps(data, customer.id).map((item) => item.ip)).size > customer.ipLimit) return 'ip_limit';
  return null;
}

function getIp(req) {
  return cleanText((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress, 80);
}

function securityHeaders(res) {
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function currentAdmin(req) {
  const session = sessions.get(req);
  if (!session) return null;
  const user = store.data.users.find((item) => item.id === session.userId && item.status === 'active');
  return user ? { session, user } : null;
}

function requireAdmin(req, res, csrf = false) {
  const auth = currentAdmin(req);
  if (!auth) {
    sendError(res, 401, '请先登录', 'unauthorized');
    return null;
  }
  if (csrf && req.headers['x-csrf-token'] !== auth.session.csrf) {
    sendError(res, 403, '请求校验失败，请刷新页面后重试', 'csrf_failed');
    return null;
  }
  return auth;
}

function findAgentByBearer(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const fingerprint = tokenFingerprint(token);
  const fastMatch = store.data.agents.find((agent) => agent.status === 'active' && agent.keyFingerprint === fingerprint);
  if (fastMatch && verifySecret(token, fastMatch.keyHash)) return fastMatch;
  return store.data.agents.find((agent) => agent.status === 'active' && !agent.keyFingerprint && verifySecret(token, agent.keyHash)) || null;
}

async function handleAuth(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const ip = getIp(req);
    const record = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (record.blockedUntil > Date.now()) {
      sendError(res, 429, '尝试次数过多，请稍后再试', 'rate_limited');
      return true;
    }
    const body = await readJson(req);
    const username = cleanText(body.username, 64);
    const user = store.data.users.find((item) => item.username === username && item.status === 'active');
    if (!user || !verifySecret(body.password, user.passwordHash)) {
      record.count += 1;
      if (record.count >= 6) {
        record.blockedUntil = Date.now() + 15 * 60 * 1000;
        record.count = 0;
      }
      loginAttempts.set(ip, record);
      sendError(res, 401, '账号或密码不正确', 'invalid_credentials');
      return true;
    }
    loginAttempts.delete(ip);
    const session = sessions.create(user.id);
    const secure = COOKIE_SECURE ? '; Secure' : '';
    sendJson(res, 200, { user: { id: user.id, username: user.username, role: user.role }, csrf: session.csrf }, {
      'set-cookie': `ng_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessions.ttlMs / 1000)}${secure}`
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const auth = requireAdmin(req, res, true);
    if (!auth) return true;
    sessions.delete(req);
    sendJson(res, 200, { ok: true }, { 'set-cookie': 'ng_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/session') {
    const auth = currentAdmin(req);
    if (!auth) {
      sendJson(res, 200, { authenticated: false });
    } else {
      sendJson(res, 200, { authenticated: true, csrf: auth.session.csrf, user: { id: auth.user.id, username: auth.user.username, role: auth.user.role } });
    }
    return true;
  }
  return false;
}

async function handleAgent(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/agent/enroll') {
    const body = await readJson(req);
    const token = String(body.token || '');
    const enrollment = store.data.enrollmentTokens.find((item) => !item.usedAt && new Date(item.expiresAt).getTime() > Date.now() && verifySecret(token, item.tokenHash));
    if (!enrollment) {
      sendError(res, 401, '注册令牌无效或已过期', 'invalid_enrollment');
      return true;
    }
    const agentKey = randomToken(40);
    const result = await store.transaction((data) => {
      const target = data.enrollmentTokens.find((item) => item.id === enrollment.id);
      if (!target || target.usedAt) throw Object.assign(new Error('注册令牌已被使用'), { statusCode: 409 });
      target.usedAt = nowIso();
      const server = data.servers.find((item) => item.id === target.serverId);
      if (!server) throw Object.assign(new Error('目标服务器不存在'), { statusCode: 404 });
      for (const old of data.agents.filter((item) => item.serverId === server.id)) old.status = 'revoked';
      const agent = {
        id: id('agt'), serverId: server.id, keyHash: hashSecret(agentKey), keyFingerprint: tokenFingerprint(agentKey), status: 'active',
        hostname: cleanText(body.hostname, 128), version: cleanText(body.version, 32),
        createdAt: nowIso(), lastSeenAt: nowIso()
      };
      data.agents.push(agent);
      server.status = 'online';
      server.lastSeenAt = nowIso();
      server.system = body.system || {};
      server.updatedAt = nowIso();
      audit(data, `agent:${agent.id}`, 'enroll_agent', server.id);
      return { agentId: agent.id, serverId: server.id, serverName: server.name };
    });
    let reconciled = 0;
    try { reconciled = await orchestrator.reconcileServer(result.serverId, `agent:${result.agentId}`); }
    catch (error) { console.error('Agent reconciliation failed:', error); }
    sendJson(res, 201, { ...result, agentKey, reconciled });
    return true;
  }

  if (!pathname.startsWith('/api/agent/')) return false;
  const agent = findAgentByBearer(req);
  if (!agent) {
    sendError(res, 401, 'Agent 身份校验失败', 'invalid_agent');
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/agent/heartbeat') {
    const body = await readJson(req);
    await store.transient((data) => {
      const current = data.agents.find((item) => item.id === agent.id);
      const server = data.servers.find((item) => item.id === agent.serverId);
      if (current) {
        current.lastSeenAt = nowIso();
        current.version = cleanText(body.version || current.version, 32);
      }
      if (server) {
        server.status = 'online';
        server.lastSeenAt = nowIso();
        server.system = body.system || server.system || {};
        server.engine = body.engine && ['ready','error'].includes(body.engine.status)
          ? { status: body.engine.status, detail: redactSecrets(cleanText(body.engine.detail, 400)),
            singBoxInstalled: body.engine.singBoxInstalled === true,
            certificates: Array.isArray(body.engine.certificates) ? body.engine.certificates.slice(0, 50)
              .map((value) => cleanText(value, 253).toLowerCase())
              .filter((value) => /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(value)) : [],
            singBoxStatus: body.engine.singBoxStatus === 'ready' ? 'ready' : 'inactive', at: nowIso() }
          : server.engine || null;
      }
    });
    sendJson(res, 200, { ok: true, serverTime: nowIso() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/agent/tls-domain') {
    const body = await readJson(req);
    const domain = requiredText(body.domain, '节点 TLS 域名', 253).toLowerCase();
    await store.transaction((data) => {
      const server = data.servers.find((item) => item.id === agent.serverId);
      if (!server) throw Object.assign(new Error('设备不存在'), { statusCode:404 });
      normalizeServer({ tlsDomain:domain }, server);
      if (server.tlsDomain && server.tlsDomain !== domain && data.deployments.some((item) =>
        item.serverId === server.id && ['relay','direct'].includes(item.role) &&
        ['anytls','hysteria2','vless-ws-tls'].includes(item.protocol) &&
        ['active','queued','applying'].includes(item.status) && !item.archived)) {
        throw Object.assign(new Error('设备已有使用其他域名的 TLS 节点；请先处理现有线路'), { statusCode:409 });
      }
      if (server.tlsDomain !== domain) {
        server.tlsDomain = domain;
        server.updatedAt = nowIso();
        audit(data, `agent:${agent.id}`, 'set_tls_domain', server.id, { domain });
      }
      server.engine ||= {};
      server.engine.certificates = [...new Set([...(server.engine.certificates || []), domain])];
    });
    sendJson(res, 200, { ok:true, domain });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/agent/poll') {
    if (!store.data.jobs.some((item) => item.serverId === agent.serverId && item.status === 'queued')) {
      sendJson(res, 200, { job: null });
      return true;
    }
    let picked = null;
    await store.transaction((data) => {
      const job = data.jobs.find((item) => item.serverId === agent.serverId && item.status === 'queued');
      if (!job) return Store.SKIP;
      job.status = 'running';
      job.attempts += 1;
      job.startedAt = nowIso();
      job.updatedAt = nowIso();
      job.leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      picked = structuredClone(job);
    });
    sendJson(res, 200, { job: picked });
    return true;
  }

  const completed = route('/api/agent/jobs/:id/complete', pathname);
  if (req.method === 'POST' && completed) {
    const job = store.data.jobs.find((item) => item.id === completed.id && item.serverId === agent.serverId);
    if (!job) {
      sendError(res, 404, '任务不存在', 'not_found');
      return true;
    }
    const body = await readJson(req);
    const updated = await orchestrator.completeJob(job.id, Boolean(body.success), body.result || {}, body.error);
    sendJson(res, 200, { job: updated });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/agent/usage') {
    const body = await readJson(req);
    await orchestrator.recordUsage(agent.serverId, body.samples, redactSecrets(cleanText(body.error, 240)), cleanText(body.epoch, 80));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/agent/observations') {
    const body = await readJson(req);
    await store.transaction((data) => {
      const ttlMs = (data.settings.observationTtlMinutes || 10) * 60000;
      const cutoff = Date.now() - ttlMs;
      data.observations = data.observations.filter((item) => new Date(item.lastSeenAt).getTime() > cutoff);
      const affected = new Set();
      for (const sample of Array.isArray(body.observations) ? body.observations.slice(0, 1000) : []) {
        const customerId = cleanText(sample.customerId, 100);
        const ip = cleanText(sample.ip, 64).replace(/^\[|\]$/g, '');
        if (!net.isIP(ip) || !data.deployments.some((item) => item.serverId === agent.serverId &&
          item.customerId === customerId && ['relay', 'direct'].includes(item.role) && item.status === 'active' && !item.archived)) continue;
        const existing = data.observations.find((item) => item.customerId === customerId && item.ip === ip);
        if (existing) existing.lastSeenAt = nowIso();
        else data.observations.push({ id: id('obs'), customerId, ip, firstSeenAt: nowIso(), lastSeenAt: nowIso() });
        affected.add(customerId);
      }
      for (const customerId of affected) {
        const customer = data.customers.find((item) => item.id === customerId);
        if (!customer || customer.status !== 'active' || !(customer.ipLimit > 0)) continue;
        const ipCount = new Set(data.observations.filter((item) => item.customerId === customerId).map((item) => item.ip)).size;
        if (ipCount <= customer.ipLimit) continue;
        customer.status = 'suspended';
        customer.suspendReason = 'ip_limit';
        customer.updatedAt = nowIso();
        suspendCustomerResources(data, customer, `agent:${agent.id}`);
        audit(data, `agent:${agent.id}`, 'suspend_ip_limit', customer.id, { ipCount, limit: customer.ipLimit });
      }
    });
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleAdminApi(req, res, pathname) {
  if (!pathname.startsWith('/api/')) return false;
  const changing = !['GET', 'HEAD'].includes(req.method);
  const auth = requireAdmin(req, res, changing);
  if (!auth) return true;
  const actor = auth.user.username;

  if (req.method === 'GET' && pathname === '/api/overview') {
    const data = store.data;
    const online = data.servers.filter((item) => item.status === 'online' && Date.now() - new Date(item.lastSeenAt || 0).getTime() < 120000).length;
    sendJson(res, 200, {
      counts: {
        servers: data.servers.length, online, customers: data.customers.length,
        chains: data.chains.length, activeDeployments: data.deployments.filter((item) => item.status === 'active').length,
        queuedJobs: data.jobs.filter((item) => ['queued', 'running'].includes(item.status)).length
      },
      version: VERSION,
      activity: data.activity.slice(0, 12),
      degraded: data.deployments.filter((item) => !item.archived && item.status === 'failed').map(publicDeployment).slice(0, 10)
    });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/protocols') {
    sendJson(res, 200, { profiles: PROFILE_CATALOG, realityPresets: REALITY_PRESETS });
    return true;
  }
  if (req.method === 'PATCH' && pathname === '/api/account') {
    const body = await readJson(req);
    if (!verifySecret(body.currentPassword, auth.user.passwordHash)) throw Object.assign(new Error('当前密码不正确'), { statusCode: 400 });
    const username = 'username' in body ? requiredText(body.username, '登录账号', 64) : auth.user.username;
    const newPassword = body.newPassword == null ? '' : String(body.newPassword).slice(0, 256);
    if (newPassword && newPassword.length < 10) throw Object.assign(new Error('新密码至少需要 10 位'), { statusCode: 400 });
    await store.transaction((data) => {
      const item = data.users.find((entry) => entry.id === auth.user.id);
      if (!item) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
      if (data.users.some((entry) => entry.id !== item.id && entry.username === username)) throw Object.assign(new Error('该登录账号已被使用'), { statusCode: 409 });
      item.username = username;
      if (newPassword) item.passwordHash = hashSecret(newPassword);
      item.updatedAt = nowIso();
      audit(data, actor, 'update_account', item.id, { username });
    });
    sessions = new SessionManager(store.data.settings.sessionHours || 12);
    sendJson(res, 200, { ok: true, reauthenticate: true }, { 'set-cookie': 'ng_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/servers') {
    sendJson(res, 200, { servers: store.data.servers.map(publicServer) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/servers') {
    const body = await readJson(req);
    const server = await store.transaction((data) => {
      const next = {
        ...normalizeServer(body), id: id('srv'), status: 'pending', createdAt: nowIso(), updatedAt: nowIso()
      };
      data.servers.push(next);
      audit(data, actor, 'create_server', next.id, { name: next.name });
      return structuredClone(next);
    });
    sendJson(res, 201, { server });
    return true;
  }
  const serverItem = route('/api/servers/:id', pathname);
  if (serverItem && req.method === 'PATCH') {
    const body = await readJson(req);
    const server = await store.transaction((data) => {
      const item = data.servers.find((entry) => entry.id === serverItem.id);
      if (!item) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      Object.assign(item, normalizeServer(body, item), { updatedAt: nowIso() });
      audit(data, actor, 'update_server', item.id, { name: item.name });
      return structuredClone(item);
    });
    sendJson(res, 200, { server });
    return true;
  }
  if (serverItem && req.method === 'DELETE') {
    await store.transaction((data) => {
      const index = data.servers.findIndex((item) => item.id === serverItem.id);
      if (index < 0) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      if (data.deployments.some((item) => item.serverId === serverItem.id && item.status !== 'deleted')) {
        throw Object.assign(new Error('设备仍有待清理资源。先删除关联线路并等待 Agent 上线确认清理，再删除设备'), { statusCode: 409 });
      }
      if (data.chains.some((item) => item.exitServerId === serverItem.id || item.relayServerIds.includes(serverItem.id))) {
        throw Object.assign(new Error('设备仍被线路引用。请先编辑或删除关联线路'), { statusCode: 409 });
      }
      data.servers.splice(index, 1);
      for (const agent of data.agents.filter((item) => item.serverId === serverItem.id)) agent.status = 'revoked';
      audit(data, actor, 'delete_server', serverItem.id);
    });
    sendJson(res, 200, { ok: true });
    return true;
  }
  const enroll = route('/api/servers/:id/enrollment-token', pathname);
  if (enroll && req.method === 'POST') {
    const raw = randomToken(30);
    const token = await store.transaction((data) => {
      if (!data.servers.some((item) => item.id === enroll.id)) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      const next = {
        id: id('enr'), serverId: enroll.id, tokenHash: hashSecret(raw), createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), usedAt: null
      };
      data.enrollmentTokens.push(next);
      audit(data, actor, 'create_enrollment', enroll.id);
      return next;
    });
    sendJson(res, 201, { token: raw, expiresAt: token.expiresAt });
    return true;
  }
  const cleanup = route('/api/servers/:id/cleanup', pathname);
  if (cleanup && req.method === 'POST') {
    const count = await store.transaction((data) => {
      if (!data.servers.some((item) => item.id === cleanup.id)) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      let queued = 0;
      for (const deployment of data.deployments.filter((item) => item.serverId === cleanup.id && item.archived && item.status !== 'deleted')) {
        const pending = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued', 'running'].includes(job.status));
        if (pending) continue;
        data.jobs.push({ id: id('job'), serverId: cleanup.id, deploymentId: deployment.id, action: 'delete_resource',
          payload: { resourceId: deployment.resourceId }, status: 'queued', attempts: 0, createdAt: nowIso(), updatedAt: nowIso(), error: null, leaseUntil: null });
        deployment.status = 'removing'; deployment.updatedAt = nowIso(); queued += 1;
      }
      audit(data, actor, 'retry_cleanup', cleanup.id, { queued });
      return queued;
    });
    sendJson(res, 202, { queued: count }); return true;
  }
  const forget = route('/api/servers/:id/forget', pathname);
  if (forget && req.method === 'POST') {
    const body = await readJson(req);
    const result = await store.transaction((data) => {
      const index = data.servers.findIndex((item) => item.id === forget.id);
      if (index < 0) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      const server = data.servers[index];
      if (body.confirm !== 'FORGET' || body.name !== server.name) throw Object.assign(new Error('请输入准确设备名称以确认'), { statusCode: 400 });
      if (server.status === 'online') throw Object.assign(new Error('在线设备不能强制遗忘，请先正常停用并清理资源'), { statusCode: 409 });
      if (data.chains.some((item) => item.exitServerId === server.id || item.relayServerIds.includes(server.id))) {
        throw Object.assign(new Error('设备仍被线路引用，请先删除关联线路'), { statusCode: 409 });
      }
      const residual = data.deployments.filter((item) => item.serverId === server.id && item.status !== 'deleted');
      if (residual.some((item) => !item.archived)) throw Object.assign(new Error('仍有未归档部署，请先删除关联线路'), { statusCode: 409 });
      const residualIds = new Set(residual.map((item) => item.id));
      if (data.jobs.some((item) => residualIds.has(item.deploymentId) && item.status === 'running')) {
        throw Object.assign(new Error('设备任务尚在执行，不能强制遗忘'), { statusCode: 409 });
      }
      data.jobs = data.jobs.filter((item) => !residualIds.has(item.deploymentId));
      data.deployments = data.deployments.filter((item) => !residualIds.has(item.id));
      for (const agent of data.agents.filter((item) => item.serverId === server.id)) agent.status = 'revoked';
      data.servers.splice(index, 1);
      audit(data, actor, 'force_forget_server', server.id, { name: server.name, unconfirmedResources: residual.length });
      return { unconfirmedResources: residual.length };
    });
    sendJson(res, 200, { ok: true, ...result }); return true;
  }

  if (req.method === 'GET' && pathname === '/api/customers') {
    sendJson(res, 200, { customers: store.data.customers.map(publicCustomer) });
    return true;
  }
  const accessRoute = route('/api/customers/:id/access', pathname);
  if (accessRoute && req.method === 'GET') {
    const customer = store.data.customers.find((item) => item.id === accessRoute.id);
    if (!customer) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
    sendJson(res, 200, { limits: { ip: customer.ipLimit, subscriptionClients: customer.deviceLimit },
      observedIps: observedIps(store.data, customer.id).map(({ ip, firstSeenAt, lastSeenAt }) => ({ ip, firstSeenAt, lastSeenAt })),
      subscriptionClients: activeClients(store.data, customer.id).length,
      events: store.data.subscriptionAccess.filter((item) => item.customerId === customer.id).slice(-100).reverse().map(({ clientKey, ...event }) => event) });
    return true;
  }
  if (accessRoute && req.method === 'DELETE') {
    await store.transaction((data) => {
      if (!data.customers.some((item) => item.id === accessRoute.id)) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      data.subscriptionAccess = data.subscriptionAccess.filter((item) => item.customerId !== accessRoute.id);
      data.subscriptionClients = data.subscriptionClients.filter((item) => item.customerId !== accessRoute.id);
      audit(data, actor, 'reset_subscription_access', accessRoute.id);
    });
    sendJson(res, 200, { ok: true }); return true;
  }
  if (req.method === 'POST' && pathname === '/api/customers') {
    const body = await readJson(req);
    const customer = await store.transaction((data) => {
      const next = {
        id: id('cus'), subscriptionToken: randomToken(32), name: requiredText(body.name, '客户名称'), group: cleanText(body.group, 80),
        status: 'active', trafficLimitBytes: nonNegativeNumber(body.trafficLimitBytes, '流量上限'), usedBytes: 0, usedUplinkBytes: 0, usedDownlinkBytes: 0,
        expiresAt: optionalIso(body.expiresAt, '到期日期'),
        ipLimit: nonNegativeNumber(body.ipLimit, 'IP 上限', true), deviceLimit: nonNegativeNumber(body.deviceLimit, '设备上限', true),
        tags: asIds(body.tags).slice(0, 20), notes: cleanText(body.notes, 1000),
        createdAt: nowIso(), updatedAt: nowIso()
      };
      data.customers.push(next);
      audit(data, actor, 'create_customer', next.id, { name: next.name });
      return structuredClone(next);
    });
    sendJson(res, 201, { customer });
    return true;
  }
  const customerItem = route('/api/customers/:id', pathname);
  if (customerItem && req.method === 'PATCH') {
    const body = await readJson(req);
    const customer = await store.transaction((data) => {
      const item = data.customers.find((entry) => entry.id === customerItem.id);
      if (!item) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      const wasActive = item.status === 'active';
      const previousReason = item.suspendReason;
      if ('name' in body) item.name = requiredText(body.name, '客户名称');
      if ('group' in body) item.group = cleanText(body.group, 80);
      if ('notes' in body) item.notes = cleanText(body.notes, 1000);
      if ('trafficLimitBytes' in body) item.trafficLimitBytes = nonNegativeNumber(body.trafficLimitBytes, '流量上限');
      if ('ipLimit' in body) item.ipLimit = nonNegativeNumber(body.ipLimit, 'IP 上限', true);
      if ('deviceLimit' in body) item.deviceLimit = nonNegativeNumber(body.deviceLimit, '设备上限', true);
      if ('expiresAt' in body) item.expiresAt = optionalIso(body.expiresAt, '到期日期');
      if ('tags' in body) item.tags = asIds(body.tags).slice(0, 20);
      const reason = customerBlockReason(data, item);
      if (body.status === 'active' && reason) {
        const error = new Error(`客户仍受${{ expired:'到期时间', traffic_limit:'流量额度', ip_limit:'节点 IP 上限' }[reason]}限制，请先修改限制再启用`);
        error.statusCode = 409; throw error;
      }
      if (body.status === 'suspended') { item.status = 'suspended'; item.suspendReason = 'manual'; }
      else if (reason && wasActive) { item.status = 'suspended'; item.suspendReason = reason; }
      else if (body.status === 'active' || (!wasActive && !reason && ['traffic_limit','expired','ip_limit'].includes(previousReason))) {
        item.status = 'active'; item.suspendReason = null;
      }
      if (wasActive && item.status === 'suspended') suspendCustomerResources(data, item, actor);
      if (!wasActive && item.status === 'active') resumeCustomerResources(data, item, actor);
      item.updatedAt = nowIso();
      audit(data, actor, 'update_customer', item.id);
      return structuredClone(item);
    });
    sendJson(res, 200, { customer });
    return true;
  }
  const resetUsage = route('/api/customers/:id/reset-usage', pathname);
  if (resetUsage && req.method === 'POST') {
    await store.transaction((data) => {
      const item = data.customers.find((entry) => entry.id === resetUsage.id);
      if (!item) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      item.usedBytes = 0; item.usedUplinkBytes = 0; item.usedDownlinkBytes = 0;
      if (item.status === 'suspended' && item.suspendReason === 'traffic_limit' && !customerBlockReason(data, item)) {
        item.status = 'active'; item.suspendReason = null; resumeCustomerResources(data, item, actor);
      }
      item.updatedAt = nowIso(); audit(data, actor, 'reset_customer_usage', item.id);
    });
    sendJson(res, 200, { ok: true }); return true;
  }
  const rotateSubscription = route('/api/customers/:id/rotate-subscription', pathname);
  if (rotateSubscription && req.method === 'POST') {
    const customer = await store.transaction((data) => {
      const item = data.customers.find((entry) => entry.id === rotateSubscription.id);
      if (!item) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      item.subscriptionToken = randomToken(32);
      item.updatedAt = nowIso();
      audit(data, actor, 'rotate_subscription', item.id);
      return publicCustomer(item);
    });
    sendJson(res, 200, { customer }); return true;
  }
  if (customerItem && req.method === 'DELETE') {
    await store.transaction((data) => {
      const index = data.customers.findIndex((item) => item.id === customerItem.id);
      if (index < 0) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      if (data.chains.some((item) => item.customerIds.includes(customerItem.id))) {
        throw Object.assign(new Error('客户仍被线路引用。请先移除或删除关联线路'), { statusCode: 409 });
      }
      if (data.deployments.some((item) => item.customerId === customerItem.id && !item.archived && item.status !== 'deleted')) {
        throw Object.assign(new Error('客户仍有活动部署。请先停用并删除关联线路'), { statusCode: 409 });
      }
      data.customers.splice(index, 1);
      data.subscriptionAccess = data.subscriptionAccess.filter((item) => item.customerId !== customerItem.id);
      data.subscriptionClients = data.subscriptionClients.filter((item) => item.customerId !== customerItem.id);
      data.observations = data.observations.filter((item) => item.customerId !== customerItem.id);
      // Archived cleanup records contain resource IDs and can finish without a customer row.
      audit(data, actor, 'delete_customer', customerItem.id, { pendingCleanup: data.deployments.filter((item) => item.customerId === customerItem.id && item.archived && item.status !== 'deleted').length });
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/chains') {
    sendJson(res, 200, { chains: store.data.chains, deployments: store.data.deployments.filter((item) => !item.archived).map(publicDeployment) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/chains') {
    const body = await readJson(req);
    const chain = await store.transaction((data) => {
      const next = {
        ...normalizeChain(body), id: id('chn'), status: 'draft', generation: 0,
        createdAt: nowIso(), updatedAt: nowIso(), redeployPending: false
      };
      data.chains.push(next);
      audit(data, actor, 'create_chain', next.id, { name: next.name });
      return structuredClone(next);
    });
    sendJson(res, 201, { chain });
    return true;
  }
  const deploy = route('/api/chains/:id/deploy', pathname);
  if (deploy && req.method === 'POST') {
    const deployments = await orchestrator.deployChain(deploy.id, actor);
    sendJson(res, 202, { deployments: deployments.map(publicDeployment) });
    return true;
  }
  const remove = route('/api/chains/:id/remove', pathname);
  if (remove && req.method === 'POST') {
    const count = await orchestrator.removeChain(remove.id, actor);
    sendJson(res, 202, { jobs: count });
    return true;
  }
  const redeploy = route('/api/chains/:id/redeploy', pathname);
  if (redeploy && req.method === 'POST') { const count = await orchestrator.removeChain(redeploy.id, actor, true); sendJson(res, 202, { jobs: count }); return true; }
  const repair = route('/api/chains/:id/repair', pathname);
  if (repair && req.method === 'POST') { const count = await orchestrator.repairChain(repair.id, actor); sendJson(res, 202, { jobs: count }); return true; }
  const restoreChain = route('/api/chains/:id/restore', pathname);
  if (restoreChain && req.method === 'POST') { const count = await orchestrator.restoreChain(restoreChain.id, actor); sendJson(res, 202, { jobs: count }); return true; }
  const chainItem = route('/api/chains/:id', pathname);
  if (chainItem && req.method === 'PATCH') {
    const body = await readJson(req);
    const chain = await store.transaction((data) => {
      const item = data.chains.find((entry) => entry.id === chainItem.id);
      if (!item) throw Object.assign(new Error('线路不存在'), { statusCode: 404 });
      const hasActive = data.deployments.some((entry) => entry.chainId === item.id && !['deleted', 'failed'].includes(entry.status));
      Object.assign(item, normalizeChain(body, item), { updatedAt: nowIso() });
      item.status = hasActive ? 'changes_pending' : 'draft';
      audit(data, actor, 'update_route', item.id, { requiresRedeploy: hasActive });
      return { item: structuredClone(item), requiresRedeploy: hasActive };
    });
    sendJson(res, 200, { chain: chain.item, requiresRedeploy: chain.requiresRedeploy }); return true;
  }
  if (chainItem && req.method === 'DELETE') {
    const cleanupPending = await store.transaction((data) => {
      const index = data.chains.findIndex((item) => item.id === chainItem.id);
      if (index < 0) throw Object.assign(new Error('链路不存在'), { statusCode: 404 });
      const deployments = data.deployments.filter((item) => item.chainId === chainItem.id && item.status !== 'deleted');
      if (deployments.some((item) => item.status === 'active')) {
        throw Object.assign(new Error('线路仍有运行中的资源。请先停用并等待 Agent 确认'), { statusCode: 409 });
      }
      if (data.jobs.some((job) => deployments.some((item) => item.id === job.deploymentId) && job.status === 'running')) {
        throw Object.assign(new Error('部署任务正在设备上执行，请稍后刷新再删除'), { statusCode: 409 });
      }
      // Retain hidden deployment tombstones until the agent confirms deletion. This prevents
      // reusing occupied ports or silently leaving orphaned Xray resources on offline machines.
      for (const deployment of deployments) {
        for (const job of data.jobs.filter((entry) => entry.deploymentId === deployment.id && entry.status === 'queued')) {
          job.status = 'failed'; job.error = '线路已删除，原任务取消'; job.updatedAt = nowIso();
        }
        data.jobs.push({ id: id('job'), serverId: deployment.serverId, deploymentId: deployment.id,
          action: 'delete_resource', payload: { resourceId: deployment.resourceId }, status: 'queued', attempts: 0,
          createdAt: nowIso(), updatedAt: nowIso(), error: null, leaseUntil: null });
        deployment.status = 'removing'; deployment.archived = true; deployment.clientUri = null; deployment.updatedAt = nowIso();
      }
      data.chains.splice(index, 1);
      audit(data, actor, 'delete_chain', chainItem.id, { cleanupPending: deployments.length });
      return deployments.length;
    });
    sendJson(res, 200, { ok: true, cleanupPending });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: store.data.jobs.slice(-200).reverse().map(({ payload, ...job }) => ({ ...job, ...(job.error ? { error: redactSecrets(job.error) } : {}) })) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/backup') {
    const body = JSON.stringify(store.snapshot(), null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="nexusgate-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'content-length': Buffer.byteLength(body)
    });
    res.end(body);
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/restore') {
    const body = await readJson(req, 20 * 1024 * 1024);
    if (body.confirm !== 'RESTORE' || !body.data) throw Object.assign(new Error('恢复确认信息不正确'), { statusCode: 400 });
    await store.replace(body.data);
    if (store.data.customers.some((item) => !item.subscriptionToken)) {
      await store.transaction((data) => { for (const customer of data.customers) if (!customer.subscriptionToken) customer.subscriptionToken = randomToken(32); });
    }
    sessions = new SessionManager(store.data.settings.sessionHours || 12);
    sendJson(res, 200, { ok: true, message: '备份已恢复，请重新登录' }, { 'set-cookie': 'ng_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return true;
  }
  return false;
}

async function handleSubscription(req, res, pathname) {
  const match = /^\/s\/([A-Za-z0-9_-]{32,100})\/(auto|raw|base64|v2ray|shadowrocket|clash|clash-smart|mihomo|singbox|surge)$/.exec(pathname);
  if (!match) return false;
  const headers = { 'cache-control':'no-store, private', 'x-robots-tag':'noindex, nofollow', 'vary':'User-Agent' };
  if (req.method !== 'GET') { sendError(res, 405, '只支持 GET 请求'); return true; }
  // Store only one random secret per customer; never accept a numeric ID as a subscription credential.
  const token = Buffer.from(match[1]);
  const customer = store.data.customers.find((item) => item.subscriptionToken && Buffer.byteLength(item.subscriptionToken) === token.length &&
    crypto.timingSafeEqual(Buffer.from(item.subscriptionToken), token));
  if (!customer) { sendJson(res, 404, { message:'订阅链接不存在或已重置' }, headers); return true; }
  const identity = clientIdentity(req.headers, store.data.createdAt);
  const access = { id: id('acc'), customerId: customer.id, at: nowIso(), ip: getIp(req),
    userAgent: identity.userAgent, identityType: identity.kind, clientKey: identity.key,
    format: match[2], status: 0, reason: '', bytes: 0 };
  if (customer.status !== 'active' || (customer.expiresAt && Date.parse(customer.expiresAt) <= Date.now()) ||
    (customer.trafficLimitBytes > 0 && customer.usedBytes >= customer.trafficLimitBytes)) {
    access.status = 403; access.reason = '客户停用、到期或流量用尽';
    await store.transaction((data) => { data.subscriptionAccess.push(access); pruneAccess(data); });
    sendJson(res, 403, { message:'客户已停用、到期或流量用尽' }, headers); return true;
  }
  const format = ({ v2ray:'base64', shadowrocket:'base64', mihomo:'clash-smart' })[match[2]] || match[2];
  const result = formatSubscription(store.data, customer, format, String(req.headers['user-agent'] || ''));
  if (!result) {
    const restoring = store.data.deployments.some((item) => item.customerId === customer.id && !item.archived &&
      ['relay','direct'].includes(item.role) && ['queued','removing'].includes(item.status) &&
      store.data.jobs.some((job) => job.deploymentId === item.id && ['queued','running'].includes(job.status)));
    access.status = 503; access.reason = restoring ? '入口节点恢复中' : '没有已部署的入口节点';
    await store.transaction((data) => { data.subscriptionAccess.push(access); pruneAccess(data); });
    sendJson(res, 503, { message:restoring ? '节点正在恢复，请稍后更新订阅' : '当前没有部署成功的入口节点，请在“转发与节点”恢复原节点或部署线路' },
      { ...headers, ...(restoring ? { 'retry-after':'15' } : {}) }); return true;
  }
  const body = Buffer.from(result.body);
  const allowed = await store.transaction((data) => {
    const current = data.customers.find((item) => item.id === customer.id);
    // Serialize the check with the write so concurrent refreshes cannot take extra slots.
    const clients = activeClients(data, customer.id);
    const permitted = current && current.subscriptionToken === match[1] && current.status === 'active' &&
      (!current.expiresAt || Date.parse(current.expiresAt) > Date.now()) &&
      (!(current.trafficLimitBytes > 0) || current.usedBytes < current.trafficLimitBytes) &&
      (!current.deviceLimit || clients.includes(identity.key) || clients.length < current.deviceLimit);
    access.status = permitted ? 200 : 429;
    access.reason = permitted ? '已返回' : '订阅客户端估计数超限';
    access.bytes = permitted ? body.length : 0;
    if (permitted) {
      const session = data.subscriptionClients.find((item) => item.customerId === customer.id && item.clientKey === identity.key);
      if (session) session.lastSeenAt = access.at;
      else data.subscriptionClients.push({ customerId: customer.id, clientKey: identity.key, identityType: identity.kind,
        firstSeenAt: access.at, lastSeenAt: access.at });
    }
    data.subscriptionAccess.push(access);
    pruneAccess(data);
    return permitted;
  });
  if (!allowed) { sendJson(res, 429, { message:'订阅客户端数达到上限。可在客户访问记录中检查并重置观察窗口。' }, headers); return true; }
  const historical = Math.max(0, (customer.usedBytes || 0) - (customer.usedUplinkBytes || 0) - (customer.usedDownlinkBytes || 0));
  res.writeHead(200, { ...headers, 'content-type':result.contentType, 'content-length':body.length,
    'subscription-userinfo':`upload=${Math.floor((customer.usedUplinkBytes || 0) + historical)}; download=${Math.floor(customer.usedDownlinkBytes || 0)}; total=${Math.max(0, Math.floor(customer.trafficLimitBytes || 0))}; expire=${customer.expiresAt ? Math.floor(Date.parse(customer.expiresAt) / 1000) : 0}` });
  res.end(body);
  return true;
}

async function requestHandler(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, version: VERSION, time: nowIso() });
      return;
    }
    if (await handleAuth(req, res, pathname)) return;
    if (await handleAgent(req, res, pathname)) return;
    if (await handleSubscription(req, res, pathname)) return;
    if (await handleAdminApi(req, res, pathname)) return;
    if (req.method === 'GET' && await serveStatic(PUBLIC_DIR, pathname, res)) return;
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      await serveStatic(PUBLIC_DIR, '/', res);
      return;
    }
    sendError(res, 404, '接口不存在', 'not_found');
  } catch (error) {
    console.error(`[${nowIso()}]`, error);
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.statusCode ? error.message : '服务器内部错误', error.statusCode ? 'request_error' : 'internal_error');
    else res.end();
  }
}

async function housekeeping() {
  try {
    const redeployIds = await store.transaction((data) => {
      const now = Date.now();
      for (const server of data.servers) {
        if (server.lastSeenAt && now - new Date(server.lastSeenAt).getTime() > 180000) server.status = 'offline';
      }
      for (const job of data.jobs.filter((item) => item.status === 'running' && item.leaseUntil && new Date(item.leaseUntil).getTime() <= now)) {
        job.leaseUntil = null; job.updatedAt = nowIso();
        if (Number(job.attempts || 0) < 3) { job.status = 'queued'; job.error = 'Agent 未在租约内确认，任务已自动重试'; }
        else {
          job.status = 'failed'; job.error = 'Agent 连续 3 次未在租约内确认';
          const deployment = data.deployments.find((item) => item.id === job.deploymentId);
          if (deployment) {
            deployment.status = 'failed'; deployment.error = job.error; deployment.updatedAt = nowIso();
            const chain = data.chains.find((item) => item.id === deployment.chainId);
            if (chain) { chain.status = 'degraded'; chain.updatedAt = nowIso(); }
          }
        }
      }
      for (const customer of data.customers) {
        const expired = customer.expiresAt && new Date(customer.expiresAt).getTime() <= now;
        const exhausted = customer.trafficLimitBytes > 0 && customer.usedBytes >= customer.trafficLimitBytes;
        if ((expired || exhausted) && customer.status === 'active') {
          customer.status = 'suspended';
          customer.suspendReason = expired ? 'expired' : 'traffic_limit';
          customer.updatedAt = nowIso();
          suspendCustomerResources(data, customer, 'system:quota');
        } else if (customer.status === 'suspended' && customer.suspendReason === 'ip_limit' && !customerBlockReason(data, customer)) {
          customer.status = 'active'; customer.suspendReason = null; customer.updatedAt = nowIso();
          resumeCustomerResources(data, customer, 'system:ip_window');
        }
      }
      const jobCutoff = now - (data.settings.completedJobRetentionDays || 7) * 86400000;
      data.jobs = data.jobs.filter((job) => !['completed', 'failed'].includes(job.status) || new Date(job.updatedAt).getTime() > jobCutoff);
      const activityCutoff = now - (data.settings.activityRetentionDays || 30) * 86400000;
      data.activity = data.activity.filter((event) => new Date(event.at).getTime() > activityCutoff).slice(0, 2000);
      pruneAccess(data, now);
      return data.chains.filter((item) => item.status === 'redeploy_pending').map((item) => item.id);
    });
    for (const chainId of redeployIds) {
      try { await orchestrator.deployChain(chainId, 'system:redeploy'); }
      catch (error) {
        console.error(`Automatic redeploy failed for ${chainId}:`, error);
        await store.transaction((data) => {
          const chain = data.chains.find((item) => item.id === chainId);
          if (chain) { chain.status = 'degraded'; chain.lastError = String(error.message || error); chain.updatedAt = nowIso(); }
        });
      }
    }
    sessions.prune();
  } catch (error) {
    console.error('Housekeeping failed:', error);
  }
}

async function main() {
  await store.init();
  // Earlier Agents reported the full x25519 output on parse failures.
  // Remove any private key from persisted job/deployment history on upgrade.
  if ([...store.data.jobs, ...store.data.deployments, ...store.data.chains, ...store.data.servers].some((item) =>
    item.error && item.error !== redactSecrets(item.error) || item.lastError && item.lastError !== redactSecrets(item.lastError) ||
    item.engine?.detail && item.engine.detail !== redactSecrets(item.engine.detail))) {
    await store.transaction((data) => {
      for (const item of [...data.jobs, ...data.deployments, ...data.chains, ...data.servers]) {
        if (item.error) item.error = redactSecrets(item.error);
        if (item.lastError) item.lastError = redactSecrets(item.lastError);
        if (item.engine?.detail) item.engine.detail = redactSecrets(item.engine.detail);
      }
    });
  }
  if (store.data.customers.some((item) => !item.subscriptionToken)) {
    await store.transaction((data) => { for (const customer of data.customers) if (!customer.subscriptionToken) customer.subscriptionToken = randomToken(32); });
  }
  if (!store.data.users.length) {
    const password = process.env.NG_ADMIN_PASSWORD || randomToken(15);
    await store.transaction((data) => {
      data.users.push({
        id: id('usr'), username: process.env.NG_ADMIN_USERNAME || 'admin',
        passwordHash: hashSecret(password), role: 'owner', status: 'active', createdAt: nowIso()
      });
    });
    if (!process.env.NG_ADMIN_PASSWORD) console.log(`BOOTSTRAP_PASSWORD=${password}`);
  }
  sessions = new SessionManager(store.data.settings.sessionHours || 12);
  orchestrator = new Orchestrator(store);
  const server = http.createServer(requestHandler);
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(PORT, HOST, () => console.log(`NexusGate v${VERSION} listening on http://${HOST}:${PORT}`));
  setInterval(housekeeping, 60000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
