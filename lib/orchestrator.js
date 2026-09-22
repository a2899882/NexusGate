'use strict';

const crypto = require('node:crypto');
const {
  newCredentialSet, buildExitResource, buildRelayResource, buildClientUri,
  validateProtocolPair
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
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
    throw new Error(`服务器 ${server.name} 的端口范围无效`);
  }
  const used = new Set(data.deployments.filter((item) => item.serverId === server.id && item.status !== 'deleted').map((item) => item.port));
  const span = end - start + 1;
  const offset = crypto.randomInt(span);
  for (let i = 0; i < span; i += 1) {
    const candidate = start + ((offset + i) % span);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`服务器 ${server.name} 没有可用端口`);
}

function queueJob(data, serverId, deploymentId, action, payload) {
  const job = {
    id: id('job'), serverId, deploymentId, action, payload,
    status: 'queued', attempts: 0, createdAt: nowIso(), updatedAt: nowIso(), error: null
  };
  data.jobs.push(job);
  return job;
}

function audit(data, actor, action, target, detail = {}) {
  data.activity.unshift({ id: id('evt'), at: nowIso(), actor, action, target, detail });
  data.activity = data.activity.slice(0, 2000);
}

class Orchestrator {
  constructor(store) {
    this.store = store;
  }

  async deployChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '链路');
      validateProtocolPair(chain.relayProtocol, chain.exitProtocol);
      const exitServer = assertFound(data.servers.find((item) => item.id === chain.exitServerId), '落地服务器');
      const relayServers = chain.relayServerIds.map((serverId) => assertFound(data.servers.find((item) => item.id === serverId), '中转服务器'));
      const customers = chain.customerIds.map((customerId) => assertFound(data.customers.find((item) => item.id === customerId), '客户'));
      if (!relayServers.length || !customers.length) throw new Error('至少选择一台中转服务器和一个客户');
      if (customers.length > 1 && (chain.relayPortMode === 'fixed' || chain.exitPortMode === 'fixed')) {
        const error = new Error('多客户批量部署需要使用随机端口；固定端口模式当前仅支持单一客户');
        error.statusCode = 400;
        throw error;
      }

      const duplicate = data.deployments.some((item) => item.chainId === chain.id && !['deleted', 'failed'].includes(item.status));
      if (duplicate) {
        const error = new Error('该链路已有部署，请先停用或删除现有部署');
        error.statusCode = 409;
        throw error;
      }

      const created = [];
      for (const customer of customers) {
        if (customer.status !== 'active') continue;
        const credentials = newCredentialSet(chain.relayProtocol, chain.exitProtocol);
        const exitPort = chain.exitPortMode === 'fixed' && chain.exitPort ? Number(chain.exitPort) : allocatePort(data, exitServer);
        const exitDeployment = {
          id: id('dep'), chainId: chain.id, customerId: customer.id, serverId: exitServer.id,
          role: 'exit', protocol: chain.exitProtocol, port: exitPort, status: 'queued',
          resourceId: id('res'), credentials, createdAt: nowIso(), updatedAt: nowIso(), clientUri: null
        };
        const exitTag = `ng-${exitDeployment.id.replace(/[^a-zA-Z0-9]/g, '').slice(-18)}`;
        const exitResource = buildExitResource({
          resourceId: exitDeployment.resourceId, tagPrefix: exitTag, port: exitPort,
          protocol: chain.exitProtocol, credentials, customer
        });
        data.deployments.push(exitDeployment);
        queueJob(data, exitServer.id, exitDeployment.id, 'apply_resource', { resource: exitResource });
        created.push(exitDeployment);

        for (const relayServer of relayServers) {
          const relayPort = chain.relayPortMode === 'fixed' && chain.relayPort ? Number(chain.relayPort) : allocatePort(data, relayServer);
          const relayDeployment = {
            id: id('dep'), chainId: chain.id, customerId: customer.id, serverId: relayServer.id,
            role: 'relay', protocol: chain.relayProtocol, port: relayPort, status: 'queued',
            resourceId: id('res'), credentials, exitDeploymentId: exitDeployment.id,
            createdAt: nowIso(), updatedAt: nowIso(), clientUri: null
          };
          const tag = `ng-${relayDeployment.id.replace(/[^a-zA-Z0-9]/g, '').slice(-18)}`;
          const reality = {
            keyId: `reality-${relayDeployment.id}`,
            serverName: chain.realityServerName || 'www.microsoft.com',
            destPort: Number(chain.realityDestPort || 443)
          };
          const resource = buildRelayResource({
            resourceId: relayDeployment.resourceId, tagPrefix: tag, port: relayPort,
            protocol: chain.relayProtocol, exitProtocol: chain.exitProtocol,
            exitServer, exitPort, credentials, customer, reality
          });
          relayDeployment.clientTemplate = { reality };
          data.deployments.push(relayDeployment);
          queueJob(data, relayServer.id, relayDeployment.id, 'apply_resource', { resource });
          created.push(relayDeployment);
        }
      }
      chain.status = 'deploying';
      chain.updatedAt = nowIso();
      audit(data, actor, 'deploy_chain', chain.id, { deployments: created.length });
      return structuredClone(created);
    });
  }

  async removeChain(chainId, actor = 'admin') {
    return this.store.transaction((data) => {
      const chain = assertFound(data.chains.find((item) => item.id === chainId), '链路');
      const deployments = data.deployments.filter((item) => item.chainId === chainId && item.status !== 'deleted');
      for (const deployment of deployments) {
        queueJob(data, deployment.serverId, deployment.id, 'delete_resource', { resourceId: deployment.resourceId });
        deployment.status = 'removing';
        deployment.updatedAt = nowIso();
      }
      chain.status = 'removing';
      chain.updatedAt = nowIso();
      audit(data, actor, 'remove_chain', chain.id, { deployments: deployments.length });
      return deployments.length;
    });
  }

  async completeJob(jobId, success, result = {}, errorMessage = null) {
    return this.store.transaction((data) => {
      const job = assertFound(data.jobs.find((item) => item.id === jobId), '任务');
      job.status = success ? 'completed' : 'failed';
      job.updatedAt = nowIso();
      job.completedAt = nowIso();
      job.error = success ? null : String(errorMessage || 'Agent operation failed').slice(0, 1000);
      const deployment = data.deployments.find((item) => item.id === job.deploymentId);
      if (deployment) {
        if (success && job.action === 'apply_resource') {
          deployment.status = 'active';
          deployment.artifacts = result.artifacts || {};
          if (deployment.role === 'relay') {
            const relayServer = data.servers.find((item) => item.id === deployment.serverId);
            const customer = data.customers.find((item) => item.id === deployment.customerId);
            deployment.clientUri = buildClientUri({
              protocol: deployment.protocol, relayServer, relayPort: deployment.port,
              credentials: deployment.credentials,
              reality: deployment.clientTemplate && deployment.clientTemplate.reality,
              publicKey: result.artifacts && result.artifacts.realityPublicKey,
              name: `${customer ? customer.name : '客户'} · ${relayServer ? relayServer.name : '中转'}`
            });
          }
        } else if (success && job.action === 'delete_resource') {
          deployment.status = 'deleted';
        } else if (!success) {
          deployment.status = 'failed';
          deployment.error = job.error;
        }
        deployment.updatedAt = nowIso();
        const chain = data.chains.find((item) => item.id === deployment.chainId);
        if (chain) {
          const related = data.deployments.filter((item) => item.chainId === chain.id);
          if (related.every((item) => item.status === 'active')) chain.status = 'active';
          else if (related.every((item) => item.status === 'deleted')) chain.status = 'draft';
          else if (related.some((item) => item.status === 'failed')) chain.status = 'degraded';
          chain.updatedAt = nowIso();
        }
      }
      return structuredClone(job);
    });
  }

  async recordUsage(serverId, samples) {
    return this.store.transaction((data) => {
      for (const sample of samples || []) {
        const deployment = data.deployments.find((item) => item.serverId === serverId && item.resourceId === sample.resourceId);
        if (!deployment || deployment.role !== 'relay') continue;
        const customer = data.customers.find((item) => item.id === deployment.customerId);
        if (!customer) continue;
        const delta = Math.max(0, Number(sample.uplink || 0)) + Math.max(0, Number(sample.downlink || 0));
        customer.usedBytes = Math.max(0, Number(customer.usedBytes || 0)) + delta;
        customer.updatedAt = nowIso();
      }
    });
  }
}

module.exports = { Orchestrator, allocatePort, queueJob, audit, id, nowIso };
