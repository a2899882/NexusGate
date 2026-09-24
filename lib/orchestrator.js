'use strict';

const crypto = require('node:crypto');
const { redactSecrets } = require('./redact');
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

function suspendCustomerResources(data, customer, actor = 'system') {
  let count = 0;
  for (const deployment of data.deployments.filter((item) => item.customerId === customer.id && !item.archived &&
    item.status !== 'deleted' && (item.status !== 'removing' || item.suspendedByCustomer))) {
    if (deployment.status === 'active') {
      const pending = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued','running'].includes(job.status));
      if (!pending) queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId:deployment.resourceId });
      deployment.status = 'removing'; deployment.updatedAt = nowIso(); count += 1;
    }
    deployment.suspendedByCustomer = true;
  }
  for (const chain of data.chains.filter((item) => item.customerIds.includes(customer.id))) {
    if (['active','deploying','degraded','changes_pending'].includes(chain.status)) {
      if (chain.status === 'changes_pending') chain.pausedChangesPending = true;
      chain.status = 'suspending'; chain.updatedAt = nowIso();
    }
  }
  audit(data, actor, 'suspend_customer_resources', customer.id, { count });
  return count;
}

function resumeCustomerResources(data, customer, actor = 'admin', includeLegacy = false, onlyChainId = null) {
  let count = 0;
  for (const chain of data.chains.filter((item) => item.customerIds.includes(customer.id) && (!onlyChainId || item.id === onlyChainId))) {
    if (chain.pausedChangesPending || ['removing','redeploying','redeploy_pending','changes_pending'].includes(chain.status)) continue;
    const deployments = currentDeployments(data, chain).filter((item) => item.customerId === customer.id && !item.archived &&
      (item.suspendedByCustomer || (includeLegacy && ['deleted','suspended'].includes(item.status))));
    // A previously released port may now belong to another route. Never overwrite it.
    for (const deployment of deployments) {
      const occupied = data.deployments.some((item) => item.id !== deployment.id && item.serverId === deployment.serverId &&
        item.status !== 'deleted' && Number(item.port) === Number(deployment.port));
      if (occupied) { const error = new Error(`原端口 ${deployment.port} 已被其他线路使用，请编辑线路并重新部署`); error.statusCode = 409; throw error; }
    }
    for (const deployment of deployments) {
      for (const job of data.jobs.filter((item) => item.deploymentId === deployment.id && item.action === 'delete_resource' && item.status === 'queued')) {
        job.status = 'failed'; job.error = '客户恢复，清理任务已取消'; job.updatedAt = nowIso();
      }
      const removing = data.jobs.some((item) => item.deploymentId === deployment.id && item.action === 'delete_resource' && item.status === 'running');
      deployment.suspendedByCustomer = false;
      if (deployment.status === 'removing' && !removing) deployment.status = 'active';
      else if (['deleted','suspended','removing','failed'].includes(deployment.status)) {
        queueJob(data, deployment.serverId, deployment.id, 'apply_resource', { resource:resourceForDeployment(data, deployment) });
        deployment.status = 'queued'; deployment.error = null; count += 1;
      }
      deployment.updatedAt = nowIso();
    }
    if (deployments.length) {
      const related = currentDeployments(data, chain);
      chain.status = related.every((item) => item.status === 'active') ? 'active' : 'deploying';
      chain.updatedAt = nowIso();
    }
  }
  if (count) audit(data, actor, 'resume_customer_resources', customer.id, { count });
  return count;
}

function resourceForDeployment(data, deployment) {
  const chain = assertFound(data.chains.find((item) => item.id === deployment.chainId), '线路');
  const customer = assertFound(data.customers.find((item) => item.id === deployment.customerId), '客户');
  const server = assertFound(data.servers.find((item) => item.id === deployment.serverId), '服务器');
  const common = {
    resourceId: deployment.resourceId, tagPrefix: tagFor(deployment), port: deployment.port,
    credentials: deployment.credentials, customer, networkMode: chain.networkMode || 'ipv4', tlsDomain: server.tlsDomain
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

  async restoreChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '线路');
      const old = currentDeployments(data, chain).filter((item) => !item.archived);
      if (!old.length || !old.every((item) => ['deleted','suspended'].includes(item.status))) {
        const error = new Error('没有可恢复的原节点，请使用部署或等待当前任务完成'); error.statusCode = 409; throw error;
      }
      let count = 0;
      for (const customerId of chain.customerIds) {
        const customer = data.customers.find((item) => item.id === customerId);
        if (customer && customer.status === 'active' &&
          (!customer.expiresAt || Date.parse(customer.expiresAt) > Date.now()) &&
          (!(customer.trafficLimitBytes > 0) || customer.usedBytes < customer.trafficLimitBytes)) {
          count += resumeCustomerResources(data, customer, actor, true, chain.id);
        }
      }
      if (!count) { const error = new Error('客户仍受使用限制，或线路没有可恢复的部署'); error.statusCode = 409; throw error; }
      audit(data, actor, 'restore_route_resources', chain.id, { count });
      return count;
    });
  }

  async deployChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '线路');
      const direct = (chain.topology || 'forward') === 'direct';
      if (direct) validateEntryProtocol(chain.relayProtocol);
      else validateProtocolPair(chain.relayProtocol, chain.exitProtocol);
      const entryServers = chain.relayServerIds.map((serverId) => assertFound(data.servers.find((item) => item.id === serverId), '入口服务器'));
      if (['vless-ws-tls', 'hysteria2', 'anytls'].includes(chain.relayProtocol)) {
        const missing = entryServers.filter((server) => !server.tlsDomain);
        if (missing.length) { const error = new Error(`${chain.relayProtocol} 需要先填写设备 TLS 域名并在节点上安装证书：${missing.map((server) => server.name).join('、')}`); error.statusCode = 400; throw error; }
        const unready = entryServers.filter((server) => !server.engine?.certificates?.includes(server.tlsDomain));
        if (unready.length) {
          const error = new Error(`入口证书未由 Agent 确认：${unready.map((server) => server.name).join('、')}。在入口机运行 ng-agent update && ng-agent cert，证书申请成功后刷新设备状态`);
          error.statusCode = 409; throw error;
        }
      }
      const exitServer = direct ? null : assertFound(data.servers.find((item) => item.id === chain.exitServerId), '出口服务器');
      if (chain.relayProtocol === 'anytls') {
        const outdated = entryServers.filter((server) => {
          const agent = data.agents.find((item) => item.serverId === server.id && item.status === 'active');
          const parts = String(agent?.version || '').split('.').map(Number);
          return !agent || !(parts[0] > 0 || (parts[0] === 0 && (parts[1] > 6 || (parts[1] === 6 && parts[2] >= 1))));
        });
        if (outdated.length) {
          const error = new Error(`AnyTLS 入口需要新版 Agent：请在 ${outdated.map((server) => server.name).join('、')} 运行 ng-agent update`);
          error.statusCode = 409; throw error;
        }
        const missing = entryServers.filter((server) => !server.engine?.singBoxInstalled);
        if (missing.length) {
          const error = new Error(`AnyTLS 入口缺少 sing-box 及统计组件：请在 ${missing.map((server) => server.name).join('、')} 运行 ng-agent engine install，完成后等待 Agent 心跳并刷新页面`);
          error.statusCode = 409; throw error;
        }
      }
      const unavailable = [...new Map([...entryServers, ...(exitServer ? [exitServer] : [])].map((server) => [server.id, server])).values()]
        .filter((server) => server.status !== 'online' || Date.now() - Date.parse(server.lastSeenAt || 0) > 120000);
      if (unavailable.length) {
        const detail = unavailable.map((server) => `${server.name}（Agent 离线；请在该机器运行 ng-agent doctor）`).join('、');
        const error = new Error(`目标设备尚未就绪：${detail}`); error.statusCode = 409; throw error;
      }
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
      chain.pausedChangesPending = false;
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
        deployment.suspendedByCustomer = false;
        const existing = data.jobs.some((job) => job.deploymentId === deployment.id && job.action === 'delete_resource' && ['queued', 'running'].includes(job.status));
        if (!existing) queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
        deployment.status = 'removing'; deployment.updatedAt = nowIso();
      }
      chain.redeployPending = Boolean(redeploy);
      chain.pausedChangesPending = false;
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
      if (job.status !== 'running') {
        if (job.status === 'completed' && success) return structuredClone(job);
        const stale = new Error('任务已被重试或取消，请等待当前任务完成'); stale.statusCode = 409; throw stale;
      }
      job.status = success ? 'completed' : 'failed'; job.updatedAt = nowIso(); job.completedAt = nowIso(); job.leaseUntil = null;
      job.error = success ? null : redactSecrets(errorMessage || 'Agent operation failed').slice(0, 1800);
      const deployment = data.deployments.find((item) => item.id === job.deploymentId);
      if (!deployment) return structuredClone(job);
      const chain = data.chains.find((item) => item.id === deployment.chainId);
      if (success && job.action === 'apply_resource' && (deployment.archived || !chain ||
        ['removing','redeploying'].includes(chain.status) || (deployment.status === 'removing' && !deployment.suspendedByCustomer))) {
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
            name: chain.name,
            tlsDomain: server && server.tlsDomain,
            networkMode: chain.networkMode || 'ipv4'
          });
        }
        const customer = data.customers.find((item) => item.id === deployment.customerId);
        if (customer && (customer.status !== 'active' || (customer.expiresAt && Date.parse(customer.expiresAt) <= Date.now()) ||
          (customer.trafficLimitBytes > 0 && customer.usedBytes >= customer.trafficLimitBytes))) {
          queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
          deployment.status = 'removing'; deployment.suspendedByCustomer = true;
        }
      } else if (success && job.action === 'delete_resource') {
        const restoring = data.jobs.some((item) => item.deploymentId === deployment.id && item.action === 'apply_resource' && item.status === 'queued');
        deployment.status = restoring ? 'queued' : deployment.suspendedByCustomer && chain && !deployment.archived ? 'suspended' : 'deleted';
      }
      else if (!success) { deployment.status = 'failed'; deployment.error = job.error; }
      deployment.updatedAt = nowIso();
      if (chain) {
        const related = currentDeployments(data, chain);
        if (related.length && related.every((item) => item.status === 'active')) chain.status = chain.pausedChangesPending ? 'changes_pending' : 'active';
        else if (related.length && related.every((item) => item.status === 'deleted')) chain.status = chain.redeployPending ? 'redeploy_pending' : 'draft';
        else if (related.length && related.every((item) => ['suspended','deleted'].includes(item.status))) chain.status = chain.pausedChangesPending ? 'changes_pending' : 'suspended';
        else if (related.some((item) => item.status === 'active') && related.some((item) => item.status === 'suspended')) chain.status = 'partially_suspended';
        else if (related.some((item) => item.status === 'failed')) chain.status = 'degraded';
        chain.updatedAt = nowIso();
      }
      return structuredClone(job);
    });
  }

  async recordUsage(serverId, samples, error = null, epoch = null) {
    // Empty reports carry diagnostic status, not billable counters. Keep them
    // visible without rewriting the full database on every idle Agent tick.
    if (!Array.isArray(samples) || samples.length === 0) {
      return this.store.transient((data) => {
        const server = data.servers.find((item) => item.id === serverId);
        if (server) server.usage = { lastReportAt: nowIso(), sampleCount: 0,
          error: error ? String(error).slice(0, 240) : null };
      });
    }
    return this.store.transaction((data) => {
      const reportedAt = nowIso();
      const server = data.servers.find((item) => item.id === serverId);
      if (server) server.usage = { lastReportAt: reportedAt, sampleCount: Array.isArray(samples) ? samples.length : 0,
        error: error ? String(error).slice(0, 240) : null };
      for (const sample of Array.isArray(samples) ? samples.slice(0, 1000) : []) {
        const deployment = data.deployments.find((item) => item.serverId === serverId && item.resourceId === sample.resourceId &&
          !item.archived && ['relay', 'direct'].includes(item.role));
        if (!deployment) continue;
        const customer = data.customers.find((item) => item.id === deployment.customerId);
        if (!customer) continue;
        const uplink = Number(sample.uplink);
        const downlink = Number(sample.downlink);
        if (![uplink, downlink].every((value) => Number.isSafeInteger(value) && value >= 0)) continue;
        const previous = deployment.usageCounters || { uplink: 0, downlink: 0 };
        const sampleEpoch = typeof sample.epoch === 'string' ? sample.epoch.slice(0, 80) : epoch;
        // A periodic report may finish after a resource job has flushed the old
        // process and started a new one. Never charge an already retired epoch
        // a second time if its HTTP response arrives out of order.
        const retiredEpochs = Array.isArray(deployment.retiredUsageEpochs) ? deployment.retiredUsageEpochs : [];
        if (sampleEpoch && retiredEpochs.includes(sampleEpoch)) continue;
        const restarted = Boolean(sampleEpoch && previous.epoch && sampleEpoch !== previous.epoch);
        if (!restarted && sampleEpoch && previous.epoch && !sampleEpoch.endsWith(':unknown') &&
            (uplink < previous.uplink || downlink < previous.downlink)) continue;
        // Counters reset when Xray restarts. Replayed reports have zero delta.
        const upDelta = !restarted && uplink >= previous.uplink ? uplink - previous.uplink : uplink;
        const downDelta = !restarted && downlink >= previous.downlink ? downlink - previous.downlink : downlink;
        if (restarted && previous.epoch) {
          deployment.retiredUsageEpochs = [...retiredEpochs, previous.epoch].slice(-8);
        }
        deployment.usageCounters = { uplink, downlink, epoch: sampleEpoch || null };
        const metered = deployment.meteredTraffic || { uplink: 0, downlink: 0 };
        deployment.meteredTraffic = { uplink: metered.uplink + upDelta, downlink: metered.downlink + downDelta };
        deployment.lastUsageAt = reportedAt;
        customer.usedUplinkBytes = (customer.usedUplinkBytes || 0) + upDelta;
        customer.usedDownlinkBytes = (customer.usedDownlinkBytes || 0) + downDelta;
        customer.usedBytes = (customer.usedBytes || 0) + upDelta + downDelta;
        customer.lastUsageAt = reportedAt;
        customer.updatedAt = reportedAt;
      }
    });
  }
}

module.exports = { Orchestrator, allocatePort, selectPort, queueJob, audit, id, nowIso, resourceForDeployment,
  suspendCustomerResources, resumeCustomerResources };
