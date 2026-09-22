'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { Store } = require('./lib/store');
const { hashSecret, verifySecret, randomToken, SessionManager } = require('./lib/auth');
const { sendJson, sendError, readJson, route, serveStatic } = require('./lib/http');
const { PROFILE_CATALOG } = require('./lib/protocols');
const { Orchestrator, audit, id, nowIso } = require('./lib/orchestrator');

const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_FILE = process.env.NG_DATA_FILE || path.join(APP_ROOT, 'data', 'nexusgate.json');
const HOST = process.env.NG_HOST || '127.0.0.1';
const PORT = Number(process.env.NG_PORT || 8787);
const COOKIE_SECURE = process.env.NG_COOKIE_SECURE !== 'false';

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

function publicDeployment(item) {
  const { credentials, clientTemplate, ...safe } = item;
  return safe;
}

function publicServer(item) {
  return { ...item };
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
  return store.data.agents.find((agent) => agent.status === 'active' && verifySecret(token, agent.keyHash)) || null;
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
        id: id('agt'), serverId: server.id, keyHash: hashSecret(agentKey), status: 'active',
        hostname: cleanText(body.hostname, 128), version: cleanText(body.version, 32),
        createdAt: nowIso(), lastSeenAt: nowIso()
      };
      data.agents.push(agent);
      server.status = 'online';
      server.lastSeenAt = nowIso();
      server.system = body.system || {};
      audit(data, `agent:${agent.id}`, 'enroll_agent', server.id);
      return { agentId: agent.id, serverId: server.id, serverName: server.name };
    });
    sendJson(res, 201, { ...result, agentKey });
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
    await store.transaction((data) => {
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
      }
    });
    sendJson(res, 200, { ok: true, serverTime: nowIso() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/agent/poll') {
    let picked = null;
    await store.transaction((data) => {
      const job = data.jobs.find((item) => item.serverId === agent.serverId && item.status === 'queued');
      if (!job) return;
      job.status = 'running';
      job.attempts += 1;
      job.startedAt = nowIso();
      job.updatedAt = nowIso();
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
    await orchestrator.recordUsage(agent.serverId, body.samples);
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
        if (!net.isIP(ip) || !data.customers.some((item) => item.id === customerId)) continue;
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
        for (const deployment of data.deployments.filter((item) => item.customerId === customer.id && item.status === 'active')) {
          const alreadyQueued = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued', 'running'].includes(job.status));
          if (!alreadyQueued) {
            data.jobs.push({
              id: id('job'), serverId: deployment.serverId, deploymentId: deployment.id,
              action: 'delete_resource', payload: { resourceId: deployment.resourceId }, status: 'queued',
              attempts: 0, createdAt: nowIso(), updatedAt: nowIso(), error: null
            });
            deployment.status = 'removing';
          }
        }
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
      activity: data.activity.slice(0, 12),
      degraded: data.deployments.filter((item) => item.status === 'failed').map(publicDeployment).slice(0, 10)
    });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/protocols') {
    sendJson(res, 200, { profiles: PROFILE_CATALOG });
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
        id: id('srv'), name: requiredText(body.name, '服务器名称'),
        role: ['relay', 'exit', 'hybrid'].includes(body.role) ? body.role : 'hybrid',
        region: cleanText(body.region, 80), publicAddress: requiredText(body.publicAddress, '公网地址', 255),
        portRangeStart: Number(body.portRangeStart || 20000), portRangeEnd: Number(body.portRangeEnd || 50000),
        labels: asIds(body.labels).slice(0, 20), status: 'pending', createdAt: nowIso(), updatedAt: nowIso()
      };
      if (next.portRangeStart < 1024 || next.portRangeEnd > 65535 || next.portRangeStart > next.portRangeEnd) {
        throw Object.assign(new Error('端口范围必须在 1024–65535 之间'), { statusCode: 400 });
      }
      data.servers.push(next);
      audit(data, actor, 'create_server', next.id, { name: next.name });
      return structuredClone(next);
    });
    sendJson(res, 201, { server });
    return true;
  }
  const serverItem = route('/api/servers/:id', pathname);
  if (serverItem && req.method === 'DELETE') {
    await store.transaction((data) => {
      const index = data.servers.findIndex((item) => item.id === serverItem.id);
      if (index < 0) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 });
      if (data.deployments.some((item) => item.serverId === serverItem.id && !['deleted', 'failed'].includes(item.status))) {
        throw Object.assign(new Error('服务器仍有活动部署，不能删除'), { statusCode: 409 });
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

  if (req.method === 'GET' && pathname === '/api/customers') {
    sendJson(res, 200, { customers: store.data.customers });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/customers') {
    const body = await readJson(req);
    const customer = await store.transaction((data) => {
      const next = {
        id: id('cus'), name: requiredText(body.name, '客户名称'), group: cleanText(body.group, 80),
        status: 'active', trafficLimitBytes: Math.max(0, Number(body.trafficLimitBytes || 0)), usedBytes: 0,
        expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null,
        ipLimit: Math.max(0, Number(body.ipLimit || 0)), deviceLimit: Math.max(0, Number(body.deviceLimit || 0)),
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
      for (const key of ['name', 'group', 'notes']) if (key in body) item[key] = cleanText(body[key], key === 'notes' ? 1000 : 120);
      for (const key of ['trafficLimitBytes', 'ipLimit', 'deviceLimit']) if (key in body) item[key] = Math.max(0, Number(body[key] || 0));
      if ('expiresAt' in body) item.expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : null;
      if ('status' in body && ['active', 'suspended'].includes(body.status)) item.status = body.status;
      item.updatedAt = nowIso();
      audit(data, actor, 'update_customer', item.id);
      return structuredClone(item);
    });
    sendJson(res, 200, { customer });
    return true;
  }
  if (customerItem && req.method === 'DELETE') {
    await store.transaction((data) => {
      const index = data.customers.findIndex((item) => item.id === customerItem.id);
      if (index < 0) throw Object.assign(new Error('客户不存在'), { statusCode: 404 });
      if (data.deployments.some((item) => item.customerId === customerItem.id && !['deleted', 'failed'].includes(item.status))) {
        throw Object.assign(new Error('客户仍有活动部署，不能删除'), { statusCode: 409 });
      }
      data.customers.splice(index, 1);
      for (const chain of data.chains) chain.customerIds = chain.customerIds.filter((value) => value !== customerItem.id);
      audit(data, actor, 'delete_customer', customerItem.id);
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/chains') {
    sendJson(res, 200, { chains: store.data.chains, deployments: store.data.deployments.map(publicDeployment) });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/chains') {
    const body = await readJson(req);
    const chain = await store.transaction((data) => {
      const next = {
        id: id('chn'), name: requiredText(body.name, '链路名称'), status: 'draft',
        relayServerIds: asIds(body.relayServerIds), exitServerId: requiredText(body.exitServerId, '落地服务器 ID'),
        customerIds: asIds(body.customerIds), relayProtocol: cleanText(body.relayProtocol, 64),
        exitProtocol: cleanText(body.exitProtocol, 64),
        relayPortMode: body.relayPortMode === 'fixed' ? 'fixed' : 'random', relayPort: body.relayPort ? Number(body.relayPort) : null,
        exitPortMode: body.exitPortMode === 'fixed' ? 'fixed' : 'random', exitPort: body.exitPort ? Number(body.exitPort) : null,
        realityServerName: cleanText(body.realityServerName || 'www.microsoft.com', 255),
        realityDestPort: Number(body.realityDestPort || 443),
        createdAt: nowIso(), updatedAt: nowIso()
      };
      if (!next.relayServerIds.length || !next.customerIds.length) throw Object.assign(new Error('请选择中转服务器和客户'), { statusCode: 400 });
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
  const chainItem = route('/api/chains/:id', pathname);
  if (chainItem && req.method === 'DELETE') {
    await store.transaction((data) => {
      const index = data.chains.findIndex((item) => item.id === chainItem.id);
      if (index < 0) throw Object.assign(new Error('链路不存在'), { statusCode: 404 });
      if (data.deployments.some((item) => item.chainId === chainItem.id && !['deleted', 'failed'].includes(item.status))) {
        throw Object.assign(new Error('链路仍在运行，请先停用'), { statusCode: 409 });
      }
      data.chains.splice(index, 1);
      audit(data, actor, 'delete_chain', chainItem.id);
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: store.data.jobs.slice(-200).reverse().map(({ payload, ...job }) => job) });
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
    sessions = new SessionManager(store.data.settings.sessionHours || 12);
    sendJson(res, 200, { ok: true, message: '备份已恢复，请重新登录' }, { 'set-cookie': 'ng_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return true;
  }
  return false;
}

async function requestHandler(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, version: '0.1.0', time: nowIso() });
      return;
    }
    if (await handleAuth(req, res, pathname)) return;
    if (await handleAgent(req, res, pathname)) return;
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
    await store.transaction((data) => {
      const now = Date.now();
      for (const server of data.servers) {
        if (server.lastSeenAt && now - new Date(server.lastSeenAt).getTime() > 120000) server.status = 'offline';
      }
      for (const customer of data.customers) {
        const expired = customer.expiresAt && new Date(customer.expiresAt).getTime() <= now;
        const exhausted = customer.trafficLimitBytes > 0 && customer.usedBytes >= customer.trafficLimitBytes;
        if ((expired || exhausted) && customer.status === 'active') {
          customer.status = 'suspended';
          customer.suspendReason = expired ? 'expired' : 'traffic_limit';
          customer.updatedAt = nowIso();
          for (const deployment of data.deployments.filter((item) => item.customerId === customer.id && item.status === 'active')) {
            const alreadyQueued = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued', 'running'].includes(job.status));
            if (!alreadyQueued) {
              data.jobs.push({
                id: id('job'), serverId: deployment.serverId, deploymentId: deployment.id,
                action: 'delete_resource', payload: { resourceId: deployment.resourceId }, status: 'queued',
                attempts: 0, createdAt: nowIso(), updatedAt: nowIso(), error: null
              });
              deployment.status = 'removing';
            }
          }
        }
      }
      const jobCutoff = now - (data.settings.completedJobRetentionDays || 7) * 86400000;
      data.jobs = data.jobs.filter((job) => !['completed', 'failed'].includes(job.status) || new Date(job.updatedAt).getTime() > jobCutoff);
      const activityCutoff = now - (data.settings.activityRetentionDays || 30) * 86400000;
      data.activity = data.activity.filter((event) => new Date(event.at).getTime() > activityCutoff).slice(0, 2000);
    });
    sessions.prune();
  } catch (error) {
    console.error('Housekeeping failed:', error);
  }
}

async function main() {
  await store.init();
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
  server.listen(PORT, HOST, () => console.log(`NexusGate v0.1.0 listening on http://${HOST}:${PORT}`));
  setInterval(housekeeping, 60000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
