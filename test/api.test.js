'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitFor(url) {
  for (let i = 0; i < 60; i += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start');
}

test('admin can create resources and queue a mixed-protocol chain', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nexusgate-api-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NG_HOST: '127.0.0.1', NG_PORT: String(port), NG_DATA_FILE: path.join(dir, 'data.json'), NG_ADMIN_PASSWORD: 'test-password', NG_COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { child.kill('SIGTERM'); await fs.promises.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/healthz`);
  const frontend = await fetch(`${base}/app.js`);
  assert.equal(frontend.headers.get('cache-control'), 'no-store');

  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (pathname, method = 'GET', body) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: { cookie, 'x-csrf-token': session.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json();
    assert.ok(response.ok, JSON.stringify(json));
    return json;
  };

  const relay = (await request('/api/servers', 'POST', { name: '中转 01', role: 'relay', region: 'SG', publicAddress: 'relay.example.com' })).server;
  const exit = (await request('/api/servers', 'POST', { name: '落地 01', role: 'exit', region: 'JP', publicAddress: 'exit.example.com' })).server;
  const customer = (await request('/api/customers', 'POST', { name: '客户 A', ipLimit: 2, trafficLimitBytes: 1073741824 })).customer;
  const editedRelay = (await request(`/api/servers/${relay.id}`, 'PATCH', { name: '新加坡入口 01', publicAddressV6: '2001:db8::10' })).server;
  assert.equal(editedRelay.name, '新加坡入口 01');
  const editedCustomer = (await request(`/api/customers/${customer.id}`, 'PATCH', { expiresAt: '2030-12-31T23:59:00+08:00', tags: ['VIP'] })).customer;
  assert.equal(editedCustomer.expiresAt, '2030-12-31T15:59:00.000Z');
  const chain = (await request('/api/chains', 'POST', { name: 'SG → JP', relayServerIds: [relay.id], exitServerId: exit.id, customerIds: [customer.id], relayProtocol: 'vless-reality-vision', exitProtocol: 'shadowsocks-2022-aes128' })).chain;
  const premature = await fetch(`${base}/api/chains/${chain.id}/deploy`, { method:'POST', headers:{ cookie, 'x-csrf-token':session.csrf, 'content-type':'application/json' }, body:'{}' });
  assert.equal(premature.status, 409);
  const agentKeys = {};
  for (const server of [relay, exit]) {
    const ticket = await request(`/api/servers/${server.id}/enrollment-token`, 'POST', {});
    const response = await fetch(`${base}/api/agent/enroll`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:ticket.token, hostname:'test-agent' }) });
    assert.equal(response.status, 201);
    agentKeys[server.id] = (await response.json()).agentKey;
  }
  await fetch(`${base}/api/agent/heartbeat`, { method:'POST', headers:{ authorization:`Bearer ${agentKeys[relay.id]}`, 'content-type':'application/json' },
    body:JSON.stringify({ version:'0.4.0', engine:{ status:'error', detail:'Xray config validation failed' } }) });
  const engineBlocked = await fetch(`${base}/api/chains/${chain.id}/deploy`, { method:'POST', headers:{ cookie, 'x-csrf-token':session.csrf, 'content-type':'application/json' }, body:'{}' });
  assert.equal(engineBlocked.status, 409);
  await fetch(`${base}/api/agent/heartbeat`, { method:'POST', headers:{ authorization:`Bearer ${agentKeys[relay.id]}`, 'content-type':'application/json' },
    body:JSON.stringify({ version:'0.4.0', engine:{ status:'ready', detail:'active' } }) });
  const deployed = await request(`/api/chains/${chain.id}/deploy`, 'POST', {});
  assert.equal(deployed.deployments.length, 2);
  const jobs = await request('/api/jobs');
  assert.equal(jobs.jobs.length, 2);
  assert.ok(jobs.jobs.every((job) => job.status === 'queued'));
  const exitPoll = await fetch(`${base}/api/agent/poll`, { method:'POST', headers:{ authorization:`Bearer ${agentKeys[exit.id]}` } });
  const exitJob = (await exitPoll.json()).job;
  const failed = await fetch(`${base}/api/agent/jobs/${exitJob.id}/complete`, { method:'POST',
    headers:{ authorization:`Bearer ${agentKeys[exit.id]}`, 'content-type':'application/json' },
    body:JSON.stringify({ success:false, error:'PrivateKey: example_secret Password (PublicKey): example_public' }) });
  assert.equal(failed.status, 200);
  assert.doesNotMatch(JSON.stringify(await request('/api/jobs')), /example_secret/);
  assert.doesNotMatch(JSON.stringify(await request('/api/chains')), /example_secret/);
  const changed = await request(`/api/chains/${chain.id}`, 'PATCH', { realityServerName: 'www.tesla.com' });
  assert.equal(changed.requiresRedeploy, true);
  assert.equal(changed.chain.status, 'changes_pending');
  const customerB = (await request('/api/customers', 'POST', { name: '客户 B', ipLimit: 1, deviceLimit: 1 })).customer;
  const direct = (await request('/api/chains', 'POST', { name: 'IPv6 单机节点', topology: 'direct', networkMode: 'ipv6', relayServerIds: [relay.id], customerIds: [customerB.id], relayProtocol: 'shadowsocks-2022-aes256' })).chain;
  const directDeploy = await request(`/api/chains/${direct.id}/deploy`, 'POST', {});
  assert.equal(directDeploy.deployments.length, 1);
  assert.equal(directDeploy.deployments[0].role, 'direct');

  const noActive = await fetch(`${base}/s/${customerB.subscriptionToken}/base64`);
  assert.equal(noActive.status, 503);
  const enrollment = await request(`/api/servers/${relay.id}/enrollment-token`, 'POST', {});
  const enrolled = await fetch(`${base}/api/agent/enroll`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ token:enrollment.token, hostname:'test-agent' }) });
  const { agentKey } = await enrolled.json();
  assert.equal(enrolled.status, 201);
  for (let count = 0; count < 4; count += 1) {
    const polled = await fetch(`${base}/api/agent/poll`, { method:'POST', headers:{ authorization:`Bearer ${agentKey}` } });
    const { job } = await polled.json();
    if (!job) break;
    await fetch(`${base}/api/agent/jobs/${job.id}/complete`, { method:'POST', headers:{ authorization:`Bearer ${agentKey}`, 'content-type':'application/json' }, body:JSON.stringify({ success:true, result:{ artifacts:{ realityPublicKey:'test-public-key' } } }) });
  }
  const usageReport = async (uplink, downlink, epoch = 'xray-start-1') => {
    const response = await fetch(`${base}/api/agent/usage`, { method:'POST', headers:{ authorization:`Bearer ${agentKey}`, 'content-type':'application/json' },
      body: JSON.stringify({ epoch, samples:[{ resourceId:directDeploy.deployments[0].resourceId, uplink, downlink }] }) });
    assert.equal(response.status, 200);
  };
  await usageReport(150, 350);
  await usageReport(150, 350); // Retry after a lost HTTP response must not double count.
  await usageReport(250, 900);
  await usageReport(10, 20, 'xray-start-2'); // Xray restarted, and its counters began from zero.
  const metered = (await request('/api/customers')).customers.find((item) => item.id === customerB.id);
  assert.equal(metered.usedBytes, 1180);
  assert.equal(metered.usedUplinkBytes, 260);
  assert.equal(metered.usedDownlinkBytes, 920);
  const raw = await fetch(`${base}/s/${customerB.subscriptionToken}/raw`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('subscription-userinfo'), /upload=260; download=920;/);
  await usageReport(1000, 2000, 'xray-start-3'); // A fast restart can exceed previous counters before polling.
  await usageReport(1000, 2000, 'xray-start-3');
  assert.equal((await request('/api/customers')).customers.find((item) => item.id === customerB.id).usedBytes, 4180);
  assert.match(await raw.text(), /^ss:\/\//);
  assert.equal(raw.headers.get('cache-control'), 'no-store, private');
  const encoded = await fetch(`${base}/s/${customerB.subscriptionToken}/base64`);
  assert.match(Buffer.from(await encoded.text(), 'base64').toString('utf8'), /^ss:\/\//);
  const clash = await fetch(`${base}/s/${customerB.subscriptionToken}/clash`);
  const clashText = await clash.text();
  assert.match(clashText, /^  - name: /m);
  assert.match(clashText, /^    type: "ss"$/m);
  const smart = await fetch(`${base}/s/${customerB.subscriptionToken}/clash-smart`);
  const smartText = await smart.text();
  assert.match(smartText, /GEOSITE,category-ads-all,REJECT/);
  assert.match(smartText, /GEOSITE,facebook,Meta 服务/);
  const surge = await fetch(`${base}/s/${customerB.subscriptionToken}/surge`);
  assert.match(await surge.text(), /\[Proxy Group\]/);
  const singbox = await fetch(`${base}/s/${customerB.subscriptionToken}/singbox`);
  assert.equal((await singbox.json()).outbounds[1].type, 'shadowsocks');
  const rotated = (await request(`/api/customers/${customerB.id}/rotate-subscription`, 'POST', {})).customer;
  assert.notEqual(rotated.subscriptionToken, customerB.subscriptionToken);
  assert.equal((await fetch(`${base}/s/${customerB.subscriptionToken}/raw`)).status, 404);
  assert.equal((await fetch(`${base}/s/${rotated.subscriptionToken}/raw`)).status, 200);
  const extraClient = await fetch(`${base}/s/${rotated.subscriptionToken}/raw`, { headers: { 'x-device-id': 'another-client', 'user-agent': 'Other Client/1.0' } });
  assert.equal(extraClient.status, 429);
  const access = await request(`/api/customers/${customerB.id}/access`);
  assert.equal(access.subscriptionClients, 1);
  assert.ok(access.events.some((item) => item.status === 429 && item.reason.includes('超限')));
  assert.ok(access.events.some((item) => item.status === 200 && item.bytes > 0));
  assert.ok(access.events.every((item) => !('clientKey' in item)));
  assert.equal((await request('/api/customers')).customers.find((item) => item.id === customerB.id).subscriptionClientCount, 1);
  await request(`/api/customers/${customerB.id}/access`, 'DELETE');
  assert.equal((await request(`/api/customers/${customerB.id}/access`)).events.length, 0);
  assert.equal((await fetch(`${base}/s/${rotated.subscriptionToken}/raw`, { headers: { 'x-device-id': 'another-client' } })).status, 200);

  // Exit-server source addresses belong to relay machines, never to client IP quota.
  await fetch(`${base}/api/agent/observations`, { method:'POST', headers:{ authorization:`Bearer ${agentKeys[exit.id]}`, 'content-type':'application/json' },
    body: JSON.stringify({ observations: [{ customerId:customerB.id, ip:'198.51.100.1' }] }) });
  assert.equal((await request(`/api/customers/${customerB.id}/access`)).observedIps.length, 0);
  const observed = await fetch(`${base}/api/agent/observations`, { method:'POST', headers:{ authorization:`Bearer ${agentKey}`, 'content-type':'application/json' },
    body: JSON.stringify({ observations: [{ customerId:customerB.id, ip:'203.0.113.1' }] }) });
  assert.equal(observed.status, 200);
  assert.equal((await request(`/api/customers/${customerB.id}/access`)).observedIps.length, 1);
  const excessIp = await fetch(`${base}/api/agent/observations`, { method:'POST', headers:{ authorization:`Bearer ${agentKey}`, 'content-type':'application/json' },
    body: JSON.stringify({ observations: [{ customerId:customerB.id, ip:'203.0.113.2' }] }) });
  assert.equal(excessIp.status, 200);
  assert.equal((await request('/api/customers')).customers.find((item) => item.id === customerB.id).suspendReason, 'ip_limit');

  // A failed / not-yet-applied route can disappear from the UI immediately,
  // while cleanup tombstones retain the ports until agents acknowledge removal.
  await request(`/api/chains/${chain.id}/remove`, 'POST', {});
  const deleted = await request(`/api/chains/${chain.id}`, 'DELETE');
  assert.equal(deleted.cleanupPending, 2);
  const afterDelete = await request('/api/chains');
  assert.equal(afterDelete.chains.some((item) => item.id === chain.id), false);
  assert.equal(afterDelete.deployments.some((item) => item.chainId === chain.id), false);
  const source = JSON.parse(await fs.promises.readFile(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(source.deployments.filter((item) => item.chainId === chain.id && item.archived && item.status === 'removing').length, 2);
  const removedCustomer = await request(`/api/customers/${customer.id}`, 'DELETE');
  assert.equal(removedCustomer.ok, true);
  assert.equal((await fetch(`${base}/s/${customer.subscriptionToken}/raw`)).status, 404);
  const blocked = await fetch(`${base}/api/servers/${exit.id}`, { method:'DELETE', headers:{ cookie, 'x-csrf-token':session.csrf } });
  assert.equal(blocked.status, 409);
  const retry = await request(`/api/servers/${exit.id}/cleanup`, 'POST', {});
  assert.equal(retry.queued, 0);
  const unsafeForget = await fetch(`${base}/api/servers/${exit.id}/forget`, { method:'POST', headers:{ cookie, 'x-csrf-token':session.csrf, 'content-type':'application/json' }, body:JSON.stringify({ confirm:'FORGET', name:'落地 01' }) });
  assert.equal(unsafeForget.status, 409);
  const renamed = await request('/api/account', 'PATCH', { username:'owner_2', currentPassword:'test-password', newPassword:'new-password-456' });
  assert.equal(renamed.reauthenticate, true);
  const relogin = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ username:'owner_2', password:'new-password-456' }) });
  assert.equal(relogin.status, 200);
});
