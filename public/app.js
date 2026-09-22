'use strict';

const state = {
  session: null, page: 'overview', overview: null, servers: [], customers: [],
  chains: [], deployments: [], jobs: [], protocols: [], search: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const fmtDate = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const fmtBytes = (value) => {
  let size = Number(value || 0); const units = ['B','KB','MB','GB','TB']; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
};
const statusText = { online:'在线', offline:'离线', pending:'待注册', active:'运行中', draft:'草稿', deploying:'部署中', queued:'排队中', running:'执行中', completed:'已完成', failed:'失败', degraded:'异常', suspended:'已停用', removing:'移除中', deleted:'已删除' };
const roleText = { relay:'中转', exit:'落地', hybrid:'混合' };

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`; item.textContent = message;
  $('#toasts').append(item); setTimeout(() => item.remove(), 3600);
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (state.session && !['GET','HEAD'].includes(options.method || 'GET')) headers['x-csrf-token'] = state.session.csrf;
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') showLogin();
    throw new Error(data.message || `请求失败 (${response.status})`);
  }
  return data;
}

function showLogin() {
  state.session = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}
function showApp() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#user-chip').textContent = `${state.session.user.username} · ${state.session.user.role}`;
}

async function load(page = state.page) {
  try {
    if (page === 'overview') state.overview = await api('/api/overview');
    if (['servers','chains','overview'].includes(page)) state.servers = (await api('/api/servers')).servers;
    if (['customers','chains','overview'].includes(page)) state.customers = (await api('/api/customers')).customers;
    if (['chains','deployments','overview'].includes(page)) {
      const result = await api('/api/chains'); state.chains = result.chains; state.deployments = result.deployments;
    }
    if (page === 'chains' && !state.protocols.length) state.protocols = (await api('/api/protocols')).profiles;
    if (['deployments','operations'].includes(page)) state.jobs = (await api('/api/jobs')).jobs;
    render();
  } catch (error) { toast(error.message, true); }
}

function setPage(page) {
  state.page = page; state.search = '';
  $$('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const titles = { overview:'运行总览', servers:'服务器资源', customers:'客户与额度', chains:'链路编排', deployments:'部署与订阅', operations:'运维中心' };
  $('#page-title').textContent = titles[page]; $('#breadcrumb').textContent = `NEXUSGATE / ${titles[page]}`;
  load(page);
}

function status(value) { return `<span class="status ${esc(value)}">${esc(statusText[value] || value)}</span>`; }
function tags(values) { return (values || []).map((value) => `<span class="tag">${esc(value)}</span>`).join('') || '—'; }
function empty(title, note) { return `<div class="empty"><b>${esc(title)}</b>${esc(note)}</div>`; }

function renderOverview() {
  const counts = (state.overview && state.overview.counts) || {};
  const metrics = [
    ['服务器', counts.servers || 0, `${counts.online || 0} 台在线`, '#69e1c1'],
    ['客户', counts.customers || 0, '统一额度与到期策略', '#7aa7ff'],
    ['链路', counts.chains || 0, '入口与落地解耦', '#b98cff'],
    ['活动部署', counts.activeDeployments || 0, '受控资源', '#f6c761'],
    ['待处理任务', counts.queuedJobs || 0, 'Agent 自动领取', '#ff8aa0']
  ];
  const serverRows = state.servers.slice(0, 6).map((server) => `<div class="health-row"><div><b>${esc(server.name)}</b><span>${esc(server.region || server.publicAddress)}</span></div>${status(server.status)}</div>`).join('');
  const events = ((state.overview && state.overview.activity) || []).map((event) => `<div class="event"><i class="event-dot"></i><div><b>${esc(event.action)}</b><small>${esc(event.actor)} · ${esc(event.target)}</small></div><time>${fmtDate(event.at)}</time></div>`).join('');
  return `<section class="metrics">${metrics.map(([label,value,note,color]) => `<article class="metric" style="--accent:${color}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</section>
    <section class="grid-2"><article class="panel"><div class="panel-head"><div><h2>资源健康</h2><p>两分钟未上报将自动标记离线</p></div><button class="ghost" data-page-jump="servers">查看全部</button></div><div class="panel-body health-list">${serverRows || empty('还没有服务器','添加第一台中转或落地服务器')}</div></article>
    <article class="panel"><div class="panel-head"><div><h2>最近活动</h2><p>保留 30 天审计记录</p></div></div><div class="panel-body timeline">${events || empty('暂无活动','操作记录会显示在这里')}</div></article></section>`;
}

function renderServers() {
  const q = state.search.toLowerCase();
  const rows = state.servers.filter((item) => [item.name,item.region,item.publicAddress,...(item.labels || [])].join(' ').toLowerCase().includes(q)).map((server) => `<tr>
    <td><strong>${esc(server.name)}</strong><small>${esc(server.publicAddress)}</small></td><td>${esc(roleText[server.role] || server.role)}</td><td>${esc(server.region || '未分组')}</td>
    <td>${tags(server.labels)}</td><td>${status(server.status)}<small>${server.lastSeenAt ? fmtDate(server.lastSeenAt) : '尚未注册'}</small></td>
    <td><div class="actions"><button data-action="enroll-server" data-id="${esc(server.id)}">注册命令</button><button class="danger" data-action="delete-server" data-id="${esc(server.id)}">删除</button></div></td></tr>`).join('');
  return `<div class="page-intro"><p>集中登记全部中转机与落地机。Agent 只需主动连接控制面，无需保存各台服务器的 SSH 密码。</p><button class="primary" data-action="add-server">＋ 添加服务器</button></div>
    <section class="panel"><div class="panel-head"><div class="toolbar"><input class="search" data-search placeholder="搜索名称、地区、IP 或标签" value="${esc(state.search)}"><span class="tag">${state.servers.length} 台</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>服务器</th><th>角色</th><th>地区</th><th>标签</th><th>状态</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('没有匹配项','添加服务器后可生成一次性注册命令')}</td></tr>`}</tbody></table></div></section>`;
}

function renderCustomers() {
  const q = state.search.toLowerCase();
  const rows = state.customers.filter((item) => [item.name,item.group,...(item.tags || [])].join(' ').toLowerCase().includes(q)).map((item) => {
    const percent = item.trafficLimitBytes ? Math.min(100, Math.round(item.usedBytes / item.trafficLimitBytes * 100)) : 0;
    return `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.group || '未分组')}</small></td><td>${status(item.status)}</td>
      <td><strong>${fmtBytes(item.usedBytes)} / ${item.trafficLimitBytes ? fmtBytes(item.trafficLimitBytes) : '不限'}</strong><div class="progress"><i style="width:${percent}%"></i></div></td>
      <td>${item.expiresAt ? fmtDate(item.expiresAt) : '不限期'}</td><td>${item.ipLimit || '不限'} IP<small>设备策略 ${item.deviceLimit || '不限'}（待独立凭据）</small></td><td>${tags(item.tags)}</td>
      <td><div class="actions"><button data-action="toggle-customer" data-id="${esc(item.id)}">${item.status === 'active' ? '停用' : '启用'}</button><button class="danger" data-action="delete-customer" data-id="${esc(item.id)}">删除</button></div></td></tr>`;
  }).join('');
  return `<div class="page-intro"><p>每位客户使用独立凭据与订阅。流量、到期、IP 和设备限制在这里统一管理。</p><button class="primary" data-action="add-customer">＋ 添加客户</button></div>
    <section class="panel"><div class="panel-head"><div class="toolbar"><input class="search" data-search placeholder="搜索客户、分组或标签" value="${esc(state.search)}"><span class="tag">${state.customers.length} 位</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>客户</th><th>状态</th><th>流量</th><th>到期</th><th>限制</th><th>标签</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7">${empty('还没有客户','先创建客户，再进行链路编排')}</td></tr>`}</tbody></table></div></section>`;
}

function names(ids, collection) { return ids.map((key) => (collection.find((item) => item.id === key) || {}).name || '已删除').join('、'); }
function renderChains() {
  const rows = state.chains.map((chain) => `<tr><td><strong>${esc(chain.name)}</strong><small>${esc(chain.relayProtocol)} → ${esc(chain.exitProtocol)}</small></td>
    <td>${esc(names(chain.relayServerIds, state.servers))}</td><td>${esc((state.servers.find((item) => item.id === chain.exitServerId) || {}).name || '已删除')}</td>
    <td>${esc(names(chain.customerIds, state.customers))}</td><td>${status(chain.status)}</td><td><div class="actions">${['draft','degraded'].includes(chain.status) ? `<button class="primary" data-action="deploy-chain" data-id="${esc(chain.id)}">部署</button>` : `<button data-action="remove-chain" data-id="${esc(chain.id)}">停用</button>`}<button class="danger" data-action="delete-chain" data-id="${esc(chain.id)}">删除</button></div></td></tr>`).join('');
  return `<div class="page-intro"><p>一次选择多台中转、一台落地和多个客户。系统为每个客户生成独立凭据，并把两端配置作为同一条链路管理。</p><button class="primary" data-action="add-chain">＋ 新建链路</button></div>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>链路</th><th>中转</th><th>落地</th><th>客户</th><th>状态</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('还没有链路','准备好服务器和客户后创建第一条链路')}</td></tr>`}</tbody></table></div></section>`;
}

function renderDeployments() {
  const active = state.deployments.filter((item) => item.status !== 'deleted');
  const rows = active.map((item) => {
    const server = state.servers.find((entry) => entry.id === item.serverId);
    const customer = state.customers.find((entry) => entry.id === item.customerId);
    const chain = state.chains.find((entry) => entry.id === item.chainId);
    return `<tr><td><strong>${esc(chain ? chain.name : '已删除链路')}</strong><small>${esc(item.role === 'relay' ? '客户入口' : '落地出口')}</small></td><td>${esc(customer ? customer.name : '已删除')}</td><td>${esc(server ? server.name : '已删除')}<small>${esc(server ? server.publicAddress : '')}:${item.port}</small></td><td>${esc(item.protocol)}</td><td>${status(item.status)}</td><td><div class="actions">${item.clientUri ? `<button data-action="copy-uri" data-value="${esc(item.clientUri)}">复制链接</button>` : ''}</div></td></tr>`;
  }).join('');
  return `<div class="page-intro"><p>这里显示编排产生的实际资源。客户入口完成后可直接复制独立客户端链接。</p></div>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>链路 / 角色</th><th>客户</th><th>服务器</th><th>协议</th><th>状态</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('暂无部署','从链路编排页面发起部署')}</td></tr>`}</tbody></table></div></section>`;
}

function renderOperations() {
  const rows = state.jobs.slice(0, 100).map((job) => `<tr><td><strong>${esc(job.action)}</strong><small>${esc(job.id)}</small></td><td>${esc((state.servers.find((item) => item.id === job.serverId) || {}).name || job.serverId)}</td><td>${status(job.status)}</td><td>${job.attempts}</td><td>${fmtDate(job.updatedAt)}</td><td><small>${esc(job.error || '')}</small></td></tr>`).join('');
  return `<div class="grid-2"><section class="panel"><div class="panel-head"><div><h2>备份与恢复</h2><p>包含控制面数据、客户、链路和凭据</p></div></div><div class="panel-body stack"><div class="notice">备份文件包含敏感凭据，请存放在可信位置。恢复会替换当前控制面数据。</div><div class="toolbar"><button class="primary" data-action="download-backup">下载备份</button><button data-action="restore-backup">恢复备份</button></div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>版本与维护</h2><p>轻量单进程控制面</p></div></div><div class="panel-body"><div class="health-row"><div><b>NexusGate</b><span>当前版本</span></div><span class="tag">v0.1.0</span></div><div class="health-row"><div><b>自动清理</b><span>活动日志 30 天 / 任务 7 天</span></div>${status('active')}</div></div></section></div>
    <section class="panel" style="margin-top:16px"><div class="panel-head"><div><h2>任务队列</h2><p>最近 100 个 Agent 任务</p></div></div><div class="table-wrap"><table><thead><tr><th>任务</th><th>服务器</th><th>状态</th><th>尝试</th><th>更新时间</th><th>错误</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('任务队列为空','部署或移除链路后会产生任务')}</td></tr>`}</tbody></table></div></section>`;
}

function render() {
  const views = { overview: renderOverview, servers: renderServers, customers: renderCustomers, chains: renderChains, deployments: renderDeployments, operations: renderOperations };
  $('#content').innerHTML = views[state.page]();
}

function modal(kicker, title, body) {
  $('#modal-kicker').textContent = kicker; $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; $('#modal').showModal();
}

function serverForm() {
  modal('NEW RESOURCE', '添加服务器', `<form id="server-form" class="form-grid"><label>名称<input name="name" placeholder="新加坡中转 01" required></label><label>角色<select name="role"><option value="relay">中转</option><option value="exit">落地</option><option value="hybrid">混合</option></select></label><label>地区 / 分组<input name="region" placeholder="新加坡"></label><label>公网 IP 或域名<input name="publicAddress" placeholder="203.0.113.10" required></label><label>起始端口<input name="portRangeStart" type="number" value="20000" min="1024" max="65535"></label><label>结束端口<input name="portRangeEnd" type="number" value="50000" min="1024" max="65535"></label><label class="wide">标签（逗号分隔）<input name="labels" placeholder="CN2, 高带宽, 主力"></label><div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">保存服务器</button></div></form>`);
}

function customerForm() {
  modal('NEW CUSTOMER', '添加客户', `<form id="customer-form" class="form-grid"><label>客户名称<input name="name" required></label><label>分组<input name="group" placeholder="华南团队"></label><label>流量上限（GB，0 不限）<input name="trafficGb" type="number" min="0" value="0"></label><label>到期时间<input name="expiresAt" type="datetime-local"></label><label>并发 IP 上限<input name="ipLimit" type="number" min="0" value="2"></label><label>设备策略（独立凭据功能待上线）<input name="deviceLimit" type="number" min="0" value="3"></label><label class="wide">标签（逗号分隔）<input name="tags"></label><label class="wide">备注<textarea name="notes"></textarea></label><div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">创建客户</button></div></form>`);
}

function chainForm() {
  const relays = state.servers.filter((item) => ['relay','hybrid'].includes(item.role));
  const exits = state.servers.filter((item) => ['exit','hybrid'].includes(item.role));
  const ingress = state.protocols.filter((item) => item.role === 'relay-ingress');
  const transports = state.protocols.filter((item) => item.role === 'exit-transport');
  modal('ORCHESTRATION', '新建链路', `<form id="chain-form" class="form-grid"><label class="wide">链路名称<input name="name" placeholder="新加坡入口 → 日本落地" required></label>
    <label class="wide">中转服务器<div class="check-grid">${relays.map((item) => `<label class="check-card"><input type="checkbox" name="relayServerIds" value="${esc(item.id)}"><span>${esc(item.name)}<small>${esc(item.region)}</small></span></label>`).join('') || '<span class="muted">没有可用中转服务器</span>'}</div></label>
    <label>入口协议<select name="relayProtocol">${ingress.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.status)}</option>`).join('')}</select></label>
    <label>入口端口<select name="relayPortMode"><option value="random">范围内随机</option><option value="fixed">固定端口</option></select><input name="relayPort" type="number" placeholder="固定时填写" min="1024" max="65535"></label>
    <label>落地服务器<select name="exitServerId">${exits.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.region)}</option>`).join('')}</select></label>
    <label>落地传输<select name="exitProtocol">${transports.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>
    <label>落地端口<select name="exitPortMode"><option value="random">范围内随机</option><option value="fixed">固定端口</option></select><input name="exitPort" type="number" placeholder="固定时填写" min="1024" max="65535"></label>
    <label>Reality SNI<input name="realityServerName" value="www.microsoft.com"></label>
    <label class="wide">客户<div class="check-grid">${state.customers.filter((item) => item.status === 'active').map((item) => `<label class="check-card"><input type="checkbox" name="customerIds" value="${esc(item.id)}"><span>${esc(item.name)}<small>${esc(item.group || '未分组')}</small></span></label>`).join('') || '<span class="muted">没有可用客户</span>'}</div></label>
    <div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">创建链路</button></div></form>`);
}

document.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.target; const data = new FormData(form);
  try {
    if (form.id === 'login-form') {
      $('#login-error').textContent = '';
      state.session = await api('/api/auth/login', { method:'POST', body: JSON.stringify({ username:data.get('username'), password:data.get('password') }) });
      showApp(); setPage('overview'); return;
    }
    if (form.id === 'server-form') {
      await api('/api/servers', { method:'POST', body: JSON.stringify({ name:data.get('name'), role:data.get('role'), region:data.get('region'), publicAddress:data.get('publicAddress'), portRangeStart:Number(data.get('portRangeStart')), portRangeEnd:Number(data.get('portRangeEnd')), labels:data.get('labels').split(',').map((x) => x.trim()).filter(Boolean) }) });
      $('#modal').close(); toast('服务器已添加'); await load('servers');
    }
    if (form.id === 'customer-form') {
      await api('/api/customers', { method:'POST', body: JSON.stringify({ name:data.get('name'), group:data.get('group'), trafficLimitBytes:Number(data.get('trafficGb') || 0) * 1024 ** 3, expiresAt:data.get('expiresAt') || null, ipLimit:Number(data.get('ipLimit') || 0), deviceLimit:Number(data.get('deviceLimit') || 0), tags:data.get('tags').split(',').map((x) => x.trim()).filter(Boolean), notes:data.get('notes') }) });
      $('#modal').close(); toast('客户已创建'); await load('customers');
    }
    if (form.id === 'chain-form') {
      const payload = { name:data.get('name'), relayServerIds:data.getAll('relayServerIds'), exitServerId:data.get('exitServerId'), customerIds:data.getAll('customerIds'), relayProtocol:data.get('relayProtocol'), exitProtocol:data.get('exitProtocol'), relayPortMode:data.get('relayPortMode'), relayPort:data.get('relayPort') || null, exitPortMode:data.get('exitPortMode'), exitPort:data.get('exitPort') || null, realityServerName:data.get('realityServerName') };
      await api('/api/chains', { method:'POST', body:JSON.stringify(payload) }); $('#modal').close(); toast('链路草稿已创建'); await load('chains');
    }
  } catch (error) { if (form.id === 'login-form') $('#login-error').textContent = error.message; else toast(error.message, true); }
});

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-page]'); if (nav) { setPage(nav.dataset.page); return; }
  const jump = event.target.closest('[data-page-jump]'); if (jump) { setPage(jump.dataset.pageJump); return; }
  if (event.target.closest('[data-close]')) { $('#modal').close(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action; const itemId = button.dataset.id;
  try {
    if (action === 'add-server') serverForm();
    if (action === 'add-customer') customerForm();
    if (action === 'add-chain') chainForm();
    if (action === 'enroll-server') {
      const result = await api(`/api/servers/${itemId}/enrollment-token`, { method:'POST', body:'{}' });
      const command = `curl -fsSL https://raw.githubusercontent.com/a2899882/NexusGate/main/scripts/agent-install.sh | bash -s -- --server ${location.origin} --token ${result.token}`;
      modal('ONE-TIME ENROLLMENT', 'Agent 注册命令', `<div class="stack"><div class="notice">令牌 30 分钟内有效且只能使用一次。在目标 VPS 以 root 执行：</div><div class="codebox">${esc(command)}</div><button class="primary" data-action="copy-uri" data-value="${esc(command)}">复制命令</button></div>`);
    }
    if (action === 'copy-uri') { await navigator.clipboard.writeText(button.dataset.value); toast('已复制'); }
    if (action === 'delete-server' && confirm('确认删除这台服务器？')) { await api(`/api/servers/${itemId}`, { method:'DELETE' }); toast('服务器已删除'); await load(); }
    if (action === 'delete-customer' && confirm('确认删除这个客户？')) { await api(`/api/customers/${itemId}`, { method:'DELETE' }); toast('客户已删除'); await load(); }
    if (action === 'toggle-customer') {
      const item = state.customers.find((entry) => entry.id === itemId);
      await api(`/api/customers/${itemId}`, { method:'PATCH', body:JSON.stringify({ status:item.status === 'active' ? 'suspended' : 'active' }) }); toast('客户状态已更新'); await load();
    }
    if (action === 'deploy-chain' && confirm('现在向所选服务器下发这条链路？')) { await api(`/api/chains/${itemId}/deploy`, { method:'POST', body:'{}' }); toast('部署任务已进入队列'); await load(); }
    if (action === 'remove-chain' && confirm('停用会从相关服务器移除配置，确认继续？')) { await api(`/api/chains/${itemId}/remove`, { method:'POST', body:'{}' }); toast('移除任务已进入队列'); await load(); }
    if (action === 'delete-chain' && confirm('确认删除链路草稿？')) { await api(`/api/chains/${itemId}`, { method:'DELETE' }); toast('链路已删除'); await load(); }
    if (action === 'download-backup') { location.href = '/api/backup'; }
    if (action === 'restore-backup') {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.onchange = async () => {
        if (!input.files[0] || !confirm('恢复会覆盖当前全部控制面数据，确认继续？')) return;
        const data = JSON.parse(await input.files[0].text()); await api('/api/restore', { method:'POST', body:JSON.stringify({ confirm:'RESTORE', data }) }); location.reload();
      }; input.click();
    }
  } catch (error) { toast(error.message, true); }
});

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-search]')) { state.search = event.target.value; render(); const next = $('[data-search]'); next.focus(); next.setSelectionRange(next.value.length,next.value.length); }
});

$('#refresh').addEventListener('click', () => load());
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method:'POST', body:'{}' }); } finally { showLogin(); } });
(async function boot() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return showLogin();
    state.session = session; showApp(); await load('overview');
  } catch { showLogin(); }
})();
