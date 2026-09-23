'use strict';

const crypto = require('node:crypto');
const {
  newCredentialSet, buildExitResource, buildRelayResource, buildDirectResource, buildClientUri,
  validateEntryProtocol, validateProtocolPair, isRealityProtocol
} = require('./protocols');

const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function assertFound(value, label) {
  if (!value) {
    const error = new Error(`${label}不存在`);
    error.statusCode = 404;
    throw error;
  }
  return value;
}

function allocatePort(data, server) {
  const start = Number(server.portRangeStart || 20000);
  const end = Number(server.portRangeEnd || 50000);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) throw new Error(`服务器 ${server.name} 的端口范围无效`);
  const used = new Set(data.deployments.filter((item) => item.serverId === server.id && item.status !== 'deleted').map((item) => item.port));
  const span = end - start + 1;
  const offset = crypto.randomInt(span);
  for (let i = 0; i < span; i += 1) {
    const candidate = start + ((offset + i) % span);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`服务器 ${server.name} 没有可用端口`);
}

function selectPort(data, server, mode, requested) {
  if (mode !== 'fixed' || !requested) return allocatePort(data, server);
  const port = Number(requested);
  const conflict = data.deployments.some((item) => item.serverId === server.id && item.status !== 'deleted' && Number(item.port) === port);
  if (conflict) { const error = new Error(`服务器 ${server.name} 的端口 ${port} 已被占用`); error.statusCode = 409; throw error; }
  return port;
}

function queueJob(data, serverId, deploymentId, action, payload) {
  const job = {
    id: id('job'), serverId, deploymentId, action, payload, status: 'queued', attempts: 0,
    createdAt: nowIso(), updatedAt: nowIso(), error: null, leaseUntil: null
  };
  data.jobs.push(job);
  return job;
}

function audit(data, actor, action, target, detail = {}) {
  data.activity.unshift({ id: id('evt'), at: nowIso(), actor, action, target, detail });
  data.activity = data.activity.slice(0, 2000);
}

function tagFor(deployment) {
  return `ng-${deployment.id.replace(/[^a-zA-Z0-9]/g, '').slice(-18)}`;
}

function currentDeployments(data, chain) {
  const all = data.deployments.filter((item) => item.chainId === chain.id);
  if (!chain.generation) return all;
  return all.filter((item) => Number(item.generation || 0) === Number(chain.generation));
}

function resourceForDeployment(data, deployment) {
  const chain = assertFound(data.chains.find((item) => item.id === deployment.chainId), '线路');
  const customer = assertFound(data.customers.find((item) => item.id === deployment.customerId), '客户');
  const server = assertFound(data.servers.find((item) => item.id === deployment.serverId), '服务器');
  const common = {
    resourceId: deployment.resourceId, tagPrefix: tagFor(deployment), port: deployment.port,
    credentials: deployment.credentials, customer, networkMode: chain.networkMode || 'ipv4'
  };
  if (deployment.role === 'exit') return buildExitResource({ ...common, protocol: deployment.protocol });
  const reality = deployment.clientTemplate && deployment.clientTemplate.reality;
  if (deployment.role === 'direct') return buildDirectResource({ ...common, protocol: deployment.protocol, reality });
  const exitDeployment = assertFound(data.deployments.find((item) => item.id === deployment.exitDeploymentId), '出口部署');
  const exitServer = assertFound(data.servers.find((item) => item.id === exitDeployment.serverId), '出口服务器');
  return buildRelayResource({
    ...common, protocol: deployment.protocol, exitProtocol: exitDeployment.protocol,
    exitServer, exitPort: exitDeployment.port, reality
  });
}

function createEntryDeployment(data, chain, customer, entryServer, credentials, exitDeployment) {
  const port = selectPort(data, entryServer, chain.relayPortMode, chain.relayPort);
  const direct = (chain.topology || 'forward') === 'direct';
  const deployment = {
    id: id('dep'), chainId: chain.id, generation: chain.generation, customerId: customer.id,
    serverId: entryServer.id, role: direct ? 'direct' : 'relay', protocol: chain.relayProtocol,
    port, status: 'queued', resourceId: id('res'), credentials,
    ...(exitDeployment ? { exitDeploymentId: exitDeployment.id } : {}),
    createdAt: nowIso(), updatedAt: nowIso(), clientUri: null
  };
  if (isRealityProtocol(chain.relayProtocol)) {
    deployment.clientTemplate = { reality: {
      keyId: `reality-${deployment.id}`, serverName: chain.realityServerName || 'www.tesla.com',
      destPort: Number(chain.realityDestPort || 443)
    } };
  }
  data.deployments.push(deployment);
  queueJob(data, entryServer.id, deployment.id, 'apply_resource', { resource: resourceForDeployment(data, deployment) });
  return deployment;
}

class Orchestrator {
  constructor(store) { this.store = store; }

  async deployChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '线路');
      const direct = (chain.topology || 'forward') === 'direct';
      if (direct) validateEntryProtocol(chain.relayProtocol);
      else validateProtocolPair(chain.relayProtocol, chain.exitProtocol);
      const entryServers = chain.relayServerIds.map((serverId) => assertFound(data.servers.find((item) => item.id === serverId), '入口服务器'));
      const exitServer = direct ? null : assertFound(data.servers.find((item) => item.id === chain.exitServerId), '出口服务器');
      const customers = chain.customerIds.map((customerId) => assertFound(data.customers.find((item) => item.id === customerId), '客户'));
      if (!entryServers.length || !customers.length) throw new Error('至少选择一台入口服务器和一个客户');
      if (!customers.some((customer) => customer.status === 'active')) { const error = new Error('所选客户均已停用，无法部署'); error.statusCode = 409; throw error; }
      if ((chain.networkMode || 'ipv4') === 'ipv6') {
        const missing = [...entryServers, ...(exitServer ? [exitServer] : [])].filter((server) => !server.publicAddressV6);
        if (missing.length) { const error = new Error(`IPv6 模式需要先为这些服务器填写 IPv6 地址：${missing.map((item) => item.name).join('、')}`); error.statusCode = 400; throw error; }
      }
      if (customers.length > 1 && (chain.relayPortMode === 'fixed' || (!direct && chain.exitPortMode === 'fixed'))) {
        const error = new Error('多客户批量部署需要使用随机端口；固定端口仅支持单一客户'); error.statusCode = 400; throw error;
      }
      const duplicate = data.deployments.some((item) => item.chainId === chain.id && !['deleted', 'failed'].includes(item.status));
      if (duplicate) { const error = new Error('该线路已有部署，请使用“重新部署”或先停用'); error.statusCode = 409; throw error; }

      chain.generation = Number(chain.generation || 0) + 1;
      chain.redeployPending = false;
      const created = [];
      for (const customer of customers) {
        if (customer.status !== 'active') continue;
        const credentials = newCredentialSet(chain.relayProtocol, chain.exitProtocol);
        let exitDeployment = null;
        if (!direct) {
          const exitPort = selectPort(data, exitServer, chain.exitPortMode, chain.exitPort);
          exitDeployment = {
            id: id('dep'), chainId: chain.id, generation: chain.generation, customerId: customer.id, serverId: exitServer.id,
            role: 'exit', protocol: chain.exitProtocol, port: exitPort, status: 'queued', resourceId: id('res'), credentials,
            createdAt: nowIso(), updatedAt: nowIso(), clientUri: null
          };
          data.deployments.push(exitDeployment);
          queueJob(data, exitServer.id, exitDeployment.id, 'apply_resource', { resource: resourceForDeployment(data, exitDeployment) });
          created.push(exitDeployment);
        }
        for (const entryServer of entryServers) created.push(createEntryDeployment(data, chain, customer, entryServer, credentials, exitDeployment));
      }
      chain.status = 'deploying'; chain.updatedAt = nowIso();
      audit(data, actor, 'deploy_route', chain.id, { deployments: created.length, topology: direct ? 'direct' : 'forward' });
      return structuredClone(created);
    });
  }

  async removeChain(chainId, actor = 'admin', redeploy = false) {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '线路');
      const deployments = data.deployments.filter((item) => item.chainId === chainId && item.status !== 'deleted');
      for (const deployment of deployments) {
        const existing = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued', 'running'].includes(job.status));
        if (!existing) queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
        deployment.status = 'removing'; deployment.updatedAt = nowIso();
      }
      chain.redeployPending = Boolean(redeploy);
      chain.status = redeploy ? (deployments.length ? 'redeploying' : 'redeploy_pending') : (deployments.length ? 'removing' : 'draft'); chain.updatedAt = nowIso();
      audit(data, actor, redeploy ? 'redeploy_route' : 'remove_route', chain.id, { deployments: deployments.length });
      return deployments.length;
    });
  }

  async repairChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '线路');
      const failed = currentDeployments(data, chain).filter((item) => item.status === 'failed');
      if (!failed.length) { const error = new Error('当前线路没有可修复的失败部署'); error.statusCode = 409; throw error; }
      for (const deployment of failed) {
        queueJob(data, deployment.serverId, deployment.id, 'apply_resource', { resource: resourceForDeployment(data, deployment) });
        deployment.status = 'queued'; deployment.error = null; deployment.updatedAt = nowIso();
      }
      chain.status = 'deploying'; chain.updatedAt = nowIso();
      audit(data, actor, 'repair_route', chain.id, { deployments: failed.length });
      return failed.length;
    });
  }

  async reconcileServer(serverId, actor = 'system') {
    return this.store.transaction((data) => {
      const server = assertFound(data.servers.find((item) => item.id === serverId), '服务器');
      for (const job of data.jobs.filter((item) => item.serverId === serverId && ['queued', 'running'].includes(item.status))) {
        job.status = 'failed'; job.error = 'Agent 重新注册，旧任务已由对账任务替代'; job.updatedAt = nowIso();
      }
      let count = 0;
      for (const deployment of data.deployments.filter((item) => item.serverId === serverId && item.status !== 'deleted')) {
        const removing = deployment.archived || deployment.status === 'removing';
        if (removing) queueJob(data, serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
        else queueJob(data, serverId, deployment.id, 'apply_resource', { resource: resourceForDeployment(data, deployment) });
        deployment.status = removing ? 'removing' : 'queued'; deployment.updatedAt = nowIso(); count += 1;
      }
      audit(data, actor, 'reconcile_server', server.id, { deployments: count });
      return count;
    });
  }

  async completeJob(jobId, success, result = {}, errorMessage = null) {
    return this.store.transaction((data) => {
      const job = assertFound(data.jobs.find((item) => item.id === jobId), '任务');
      job.status = success ? 'completed' : 'failed'; job.updatedAt = nowIso(); job.completedAt = nowIso(); job.leaseUntil = null;
      job.error = success ? null : String(errorMessage || 'Agent operation failed').slice(0, 1800);
      const deployment = data.deployments.find((item) => item.id === job.deploymentId);
      if (!deployment) return structuredClone(job);
      const chain = data.chains.find((item) => item.id === deployment.chainId);
      if (success && job.action === 'apply_resource' && (deployment.archived || !chain)) {
        const cleanupQueued = data.jobs.some((item) => item.deploymentId === deployment.id && item.action === 'delete_resource' && ['queued', 'running'].includes(item.status));
        if (!cleanupQueued) queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
        deployment.status = 'removing'; deployment.clientUri = null;
      } else if (success && job.action === 'apply_resource') {
        deployment.status = 'active'; deployment.error = null; deployment.artifacts = result.artifacts || {};
        if (deployment.role === 'relay' || deployment.role === 'direct') {
          const server = data.servers.find((item) => item.id === deployment.serverId);
          const customer = data.customers.find((item) => item.id === deployment.customerId);
          deployment.clientUri = buildClientUri({
            protocol: deployment.protocol, relayServer: server, relayPort: deployment.port, credentials: deployment.credentials,
            reality: deployment.clientTemplate && deployment.clientTemplate.reality,
            publicKey: result.artifacts && result.artifacts.realityPublicKey,
            name: `${customer ? customer.name : '客户'} · ${server ? server.name : '入口'}`,
            networkMode: chain.networkMode || 'ipv4'
          });
        }
        const customer = data.customers.find((item) => item.id === deployment.customerId);
        if (customer && customer.status !== 'active') {
          queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
          deployment.status = 'removing'; deployment.clientUri = null;
        }
      } else if (success && job.action === 'delete_resource') deployment.status = 'deleted';
      else if (!success) { deployment.status = 'failed'; deployment.error = job.error; }
      deployment.updatedAt = nowIso();
      if (chain) {
        const related = currentDeployments(data, chain);
        if (related.length && related.every((item) => item.status === 'active')) chain.status = 'active';
        else if (related.length && related.every((item) => item.status === 'deleted')) chain.status = chain.redeployPending ? 'redeploy_pending' : 'draft';
        else if (related.some((item) => item.status === 'failed')) chain.status = 'degraded';
        chain.updatedAt = nowIso();
      }
      return structuredClone(job);
    });
  }

  async recordUsage(serverId, samples) {
    return this.store.transaction((data) => {
      for (const sample of samples || []) {
        const deployment = data.deployments.find((item) => item.serverId === serverId && item.resourceId === sample.resourceId);
        if (!deployment || !['relay', 'direct'].includes(deployment.role)) continue;
        const customer = data.customers.find((item) => item.id === deployment.customerId);
        if (!customer) continue;
        const delta = Math.max(0, Number(sample.uplink || 0)) + Math.max(0, Number(sample.downlink || 0));
        customer.usedBytes = Math.max(0, Number(customer.usedBytes || 0)) + delta; customer.updatedAt = nowIso();
      }
    });
  }
}

module.exports = { Orchestrator, allocatePort, selectPort, queueJob, audit, id, nowIso, resourceForDeployment };
