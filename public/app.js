'use strict';

const state = {
  session: null, page: 'overview', overview: null, servers: [], customers: [],
  chains: [], deployments: [], jobs: [], protocols: [], realityPresets: [], search: '', version: '0.3.0'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const selected = (value, current) => String(value) === String(current) ? ' selected' : '';
const checked = (value, values) => (values || []).includes(value) ? ' checked' : '';
const fmtDate = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
const fmtBytes = (value) => {
  let size = Number(value || 0); const units = ['B','KB','MB','GB','TB','PB']; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
};
const splitList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const statusText = {
  online:'在线', offline:'离线', pending:'待注册', active:'运行中', draft:'草稿', deploying:'部署中', queued:'排队中',
  running:'执行中', completed:'已完成', failed:'失败', degraded:'异常', suspended:'已停用', removing:'停用中', deleted:'已删除',
  redeploying:'重建中', redeploy_pending:'等待重建', changes_pending:'待重新部署'
};
const roleText = { relay:'入口 / 转发', exit:'出口 / 落地', hybrid:'综合节点' };
const topologyText = { forward:'转发线路', direct:'单机直连' };
const deploymentRoleText = { relay:'客户端入口', exit:'出口传输', direct:'单机节点' };
const auditText = {
  create_server:'添加设备', update_server:'编辑设备', delete_server:'删除设备', create_enrollment:'生成注册令牌', enroll_agent:'Agent 注册',
  reconcile_server:'设备配置对账', create_customer:'添加客户', update_customer:'编辑客户', reset_customer_usage:'重置客户流量', delete_customer:'删除客户',
  create_chain:'创建线路', update_route:'编辑线路', deploy_route:'部署线路', redeploy_route:'重新部署线路', repair_route:'修复线路', remove_route:'停用线路',
  delete_chain:'删除线路', retry_cleanup:'重试遗留清理', force_forget_server:'强制遗忘离线设备', update_account:'修改管理员账号', suspend_ip_limit:'IP 超限停用', rotate_subscription:'重置订阅链接'
};

function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('nexusgate-theme', next); } catch { /* storage may be disabled */ }
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#0e1421' : '#f5f7fc';
  document.querySelector('meta[name="color-scheme"]').content = next;
  $$('[data-theme-toggle]').forEach((button) => { button.textContent = next === 'dark' ? '☾ 深色' : '☀ 浅色'; button.title = next === 'dark' ? '切换为浅色主题' : '切换为深色主题'; button.setAttribute('aria-pressed', String(next === 'dark')); });
}

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`; item.textContent = message;
  $('#toasts').append(item); setTimeout(() => item.remove(), 3800);
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
  $('#user-chip').textContent = `${state.session.user.username} · 管理员`;
}

async function load(page = state.page) {
  try {
    if (page === 'overview') {
      const [overview, servers, customers, routes] = await Promise.all([api('/api/overview'), api('/api/servers'), api('/api/customers'), api('/api/chains')]);
      state.overview = overview; state.version = overview.version || state.version; state.servers = servers.servers; state.customers = customers.customers; state.chains = routes.chains; state.deployments = routes.deployments;
    } else if (page === 'servers') state.servers = (await api('/api/servers')).servers;
    else if (page === 'customers') state.customers = (await api('/api/customers')).customers;
    else if (page === 'chains') {
      const [servers, customers, routes, protocols] = await Promise.all([api('/api/servers'), api('/api/customers'), api('/api/chains'), api('/api/protocols')]);
      state.servers = servers.servers; state.customers = customers.customers; state.chains = routes.chains; state.deployments = routes.deployments;
      state.protocols = protocols.profiles; state.realityPresets = protocols.realityPresets || [];
    } else if (page === 'deployments') {
      const [servers, customers, routes] = await Promise.all([api('/api/servers'), api('/api/customers'), api('/api/chains')]);
      state.servers = servers.servers; state.customers = customers.customers; state.chains = routes.chains; state.deployments = routes.deployments;
    } else if (page === 'operations') {
      const [jobs, servers, overview] = await Promise.all([api('/api/jobs'), api('/api/servers'), api('/api/overview')]);
      state.jobs = jobs.jobs; state.servers = servers.servers; state.overview = overview; state.version = overview.version || state.version;
    }
    render();
  } catch (error) { toast(error.message, true); }
}

function setPage(page) {
  state.page = page; state.search = ''; closeSidebar();
  $$('#nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  const titles = { overview:'概览', servers:'服务器', customers:'客户', chains:'线路', deployments:'部署与链接', operations:'设置与运维' };
  $('#page-title').textContent = titles[page]; $('#breadcrumb').textContent = `NEXUSGATE / ${titles[page]}`;
  load(page);
}

function status(value) { return `<span class="status ${esc(value)}">${esc(statusText[value] || value)}</span>`; }
function tags(values) { return (values || []).map((value) => `<span class="tag">${esc(value)}</span>`).join('') || '—'; }
function empty(title, note) { return `<div class="empty"><b>${esc(title)}</b><span>${esc(note)}</span></div>`; }
function names(ids, collection) { return (ids || []).map((key) => (collection.find((item) => item.id === key) || {}).name || '已删除').join('、'); }
function protocolName(id, role) { return (state.protocols.find((item) => item.id === id && (!role || item.role === role)) || {}).name || id || '—'; }

function renderOverview() {
  const counts = (state.overview && state.overview.counts) || {};
  const metrics = [
    ['受管设备', counts.servers || 0, `${counts.online || 0} 台在线`, '#38bd91'],
    ['客户账户', counts.customers || 0, '额度与到期统一管理', '#5877f4'],
    ['编排线路', counts.chains || 0, '转发与单机节点', '#9667e8'],
    ['活动部署', counts.activeDeployments || 0, '实际运行资源', '#e8a63c'],
    ['待办任务', counts.queuedJobs || 0, 'Agent 自动领取', '#e5667c']
  ];
  const serverRows = state.servers.slice(0, 7).map((server) => `<div class="health-row"><div><b>${esc(server.name)}</b><span>${esc(roleText[server.role] || server.role)} · ${esc(server.region || server.publicAddress)}</span></div>${status(server.status)}</div>`).join('');
  const events = ((state.overview && state.overview.activity) || []).map((event) => `<div class="event"><i class="event-dot"></i><div><b>${esc(auditText[event.action] || event.action)}</b><small>${esc(event.actor)} · ${esc(event.target)}</small></div><time>${fmtDate(event.at)}</time></div>`).join('');
  const failures = ((state.overview && state.overview.degraded) || []).length;
  return `<section class="metrics">${metrics.map(([label,value,note,color]) => `<article class="metric" style="--accent:${color}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('')}</section>
    ${failures ? `<div class="notice warning" style="margin-bottom:16px">检测到 ${failures} 个失败部署。请到“线路编排”查看错误后使用“修复”或“重新部署”。</div>` : ''}
    <section class="grid-2"><article class="panel"><div class="panel-head"><div><h2>设备健康</h2><p>超过三分钟未上报将标记离线</p></div><button class="ghost" data-page-jump="servers">查看全部</button></div><div class="panel-body health-list">${serverRows || empty('还没有设备','先添加入口、出口或综合节点')}</div></article>
    <article class="panel"><div class="panel-head"><div><h2>最近活动</h2><p>重要操作审计记录</p></div></div><div class="panel-body timeline">${events || empty('暂无活动','操作记录会显示在这里')}</div></article></section>`;
}

function renderServers() {
  const q = state.search.toLowerCase();
  const rows = state.servers.filter((item) => [item.name,item.region,item.publicAddress,item.publicAddressV6,...(item.labels || [])].join(' ').toLowerCase().includes(q)).map((server) => `<tr>
    <td><strong>${esc(server.name)}</strong><small>${esc(server.publicAddress)}${server.publicAddressV6 ? ` · ${esc(server.publicAddressV6)}` : ''}</small></td><td>${esc(roleText[server.role] || server.role)}</td><td>${esc(server.region || '未分组')}</td>
    <td>${tags(server.labels)}</td><td>${status(server.status)}<small>${server.lastSeenAt ? `最后上报 ${fmtDate(server.lastSeenAt)}` : '等待 Agent 注册'}</small>${server.pendingCleanup ? `<small>待清理 ${server.pendingCleanup} 项 · 设备上线后执行</small>` : ''}</td>
    <td><div class="actions"><button data-action="edit-server" data-id="${esc(server.id)}">编辑</button><button data-action="enroll-server" data-id="${esc(server.id)}">注册 / 重装</button><button data-action="agent-uninstall">SSH 卸载</button>${server.pendingCleanup ? `<button data-action="retry-cleanup" data-id="${esc(server.id)}">重试清理</button>` : ''}${server.pendingCleanup && server.status !== 'online' ? `<button class="danger" data-action="forget-server" data-id="${esc(server.id)}">遗忘离线设备</button>` : `<button class="danger" data-action="delete-server" data-id="${esc(server.id)}">删除</button>`}</div></td></tr>`).join('');
  return `<div class="page-intro"><p>统一管理入口转发机、出口落地机与单机节点。Agent 主动连接控制面，不保存设备 SSH 密码；重装 Agent 会自动对账并恢复已有资源。</p><button class="primary" data-action="add-server">＋ 添加设备</button></div>
    <section class="panel"><div class="panel-head"><div class="toolbar"><input class="search" data-search placeholder="搜索名称、地区、IP 或标签" value="${esc(state.search)}"><span class="tag">${state.servers.length} 台</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>设备</th><th>用途</th><th>地区</th><th>标签</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('没有匹配设备','添加设备后生成一次性注册命令')}</td></tr>`}</tbody></table></div></section>`;
}

function renderCustomers() {
  const q = state.search.toLowerCase();
  const rows = state.customers.filter((item) => [item.name,item.group,...(item.tags || [])].join(' ').toLowerCase().includes(q)).map((item) => {
    const percent = item.trafficLimitBytes ? Math.min(100, Math.round(item.usedBytes / item.trafficLimitBytes * 100)) : 0;
    return `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.group || '未分组')}</small></td><td>${status(item.status)}</td>
      <td><strong>${fmtBytes(item.usedBytes)} / ${item.trafficLimitBytes ? fmtBytes(item.trafficLimitBytes) : '不限'}</strong><div class="progress"><i style="width:${percent}%"></i></div></td>
      <td>${item.expiresAt ? fmtDate(item.expiresAt) : '不限期'}</td><td>${item.ipLimit || '不限'} IP<small>设备策略 ${item.deviceLimit || '不限'}（独立凭据阶段启用）</small></td><td>${tags(item.tags)}</td>
      <td><div class="actions"><button data-action="edit-customer" data-id="${esc(item.id)}">编辑</button><button data-action="customer-subscription" data-id="${esc(item.id)}">订阅链接</button><button data-action="reset-usage" data-id="${esc(item.id)}">流量清零</button><button data-action="toggle-customer" data-id="${esc(item.id)}">${item.status === 'active' ? '停用' : '启用'}</button><button class="danger" data-action="delete-customer" data-id="${esc(item.id)}">删除</button></div>${item.pendingCleanup ? `<small>后台仍有 ${item.pendingCleanup} 项设备清理任务；已删除线路后可删除客户。</small>` : ''}</td></tr>`;
  }).join('');
  return `<div class="page-intro"><p>客户使用独立线路凭据。流量、到期日期、滚动 IP 上限会实际执行；设备数量需配合后续“一设备一凭据”机制。每位客户拥有可重置的订阅链接。</p><button class="primary" data-action="add-customer">＋ 添加客户</button></div>
    <section class="panel"><div class="panel-head"><div class="toolbar"><input class="search" data-search placeholder="搜索客户、分组或标签" value="${esc(state.search)}"><span class="tag">${state.customers.length} 位</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>客户</th><th>状态</th><th>流量</th><th>到期</th><th>使用限制</th><th>标签</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="7">${empty('还没有客户','先创建客户，再编排线路')}</td></tr>`}</tbody></table></div></section>`;
}

function chainActions(chain) {
  const edit = `<button data-action="edit-chain" data-id="${esc(chain.id)}">编辑</button>`;
  const remove = `<button class="danger" data-action="delete-chain" data-id="${esc(chain.id)}">删除</button>`;
  if (chain.status === 'draft') return `${edit}<button class="primary" data-action="deploy-chain" data-id="${esc(chain.id)}">部署</button>${remove}`;
  if (chain.status === 'changes_pending') return `${edit}<button class="primary" data-action="redeploy-chain" data-id="${esc(chain.id)}">应用修改</button><button data-action="remove-chain" data-id="${esc(chain.id)}">停用</button>`;
  if (chain.status === 'degraded') return `${edit}<button class="primary" data-action="repair-chain" data-id="${esc(chain.id)}">修复失败项</button><button data-action="remove-chain" data-id="${esc(chain.id)}">停用</button>${remove}`;
  if (['active','deploying'].includes(chain.status)) return `${edit}<button data-action="redeploy-chain" data-id="${esc(chain.id)}">重新部署</button><button data-action="remove-chain" data-id="${esc(chain.id)}">停用</button>`;
  return `${edit}${remove}`;
}

function renderChains() {
  const rows = state.chains.map((chain) => {
    const direct = (chain.topology || 'forward') === 'direct';
    const path = direct ? protocolName(chain.relayProtocol, 'relay-ingress') : `${protocolName(chain.relayProtocol, 'relay-ingress')} → ${protocolName(chain.exitProtocol, 'exit-transport')}`;
    const exit = direct ? '本机直出' : ((state.servers.find((item) => item.id === chain.exitServerId) || {}).name || '已删除');
    return `<tr><td><strong>${esc(chain.name)}</strong><small>${esc(topologyText[chain.topology || 'forward'])} · ${esc(path)}</small></td>
      <td>${esc(names(chain.relayServerIds, state.servers))}<small>${esc(chain.networkMode || 'ipv4').toUpperCase()}</small></td><td>${esc(exit)}</td>
      <td>${esc(names(chain.customerIds, state.customers))}</td><td>${status(chain.status)}${chain.lastError ? `<small>${esc(chain.lastError)}</small>` : ''}</td><td><div class="actions">${chainActions(chain)}</div></td></tr>`;
  }).join('');
  return `<div class="page-intro"><p>“转发线路”把多个客户端入口汇聚到一个出口；“单机直连”无需出口机，直接在任意设备创建节点。编辑运行中线路后，点击“应用修改”安全重建。</p><button class="primary" data-action="add-chain">＋ 新建线路</button></div>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>线路</th><th>入口 / 节点设备</th><th>出口</th><th>客户</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('还没有线路','准备好设备和客户后创建第一条线路')}</td></tr>`}</tbody></table></div></section>`;
}

function renderDeployments() {
  const active = state.deployments.filter((item) => item.status !== 'deleted');
  const rows = active.map((item) => {
    const server = state.servers.find((entry) => entry.id === item.serverId);
    const customer = state.customers.find((entry) => entry.id === item.customerId);
    const chain = state.chains.find((entry) => entry.id === item.chainId);
    return `<tr><td><strong>${esc(chain ? chain.name : '已删除线路')}</strong><small>${esc(deploymentRoleText[item.role] || item.role)}</small></td><td>${esc(customer ? customer.name : '已删除')}</td>
      <td>${esc(server ? server.name : '已删除')}<small>${esc(server ? (server.publicAddressV6 && chain && chain.networkMode === 'ipv6' ? server.publicAddressV6 : server.publicAddress) : '')}:${item.port}</small></td>
      <td>${esc(protocolName(item.protocol, item.role === 'exit' ? 'exit-transport' : 'relay-ingress'))}</td><td>${status(item.status)}${item.error ? `<small>${esc(item.error)}</small>` : ''}</td>
      <td><div class="actions">${item.clientUri ? `<button data-action="copy-uri" data-value="${esc(item.clientUri)}">复制链接</button>` : ''}${chain ? `<button data-action="edit-chain" data-id="${esc(chain.id)}">编辑线路</button>` : ''}</div></td></tr>`;
  }).join('');
  return `<div class="page-intro"><p>显示线路生成的实际入口、出口和单机节点。客户端链接只在入口资源部署成功后生成；编辑请从对应线路统一完成。</p></div>
    <section class="panel"><div class="table-wrap"><table><thead><tr><th>线路 / 角色</th><th>客户</th><th>设备</th><th>协议</th><th>状态 / 错误</th><th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('暂无部署','从“线路编排”页面发起部署')}</td></tr>`}</tbody></table></div></section>`;
}

function renderOperations() {
  const rows = state.jobs.slice(0, 100).map((job) => `<tr><td><strong>${esc(job.action === 'apply_resource' ? '应用资源' : '移除资源')}</strong><small>${esc(job.id)}</small></td><td>${esc((state.servers.find((item) => item.id === job.serverId) || {}).name || job.serverId)}</td><td>${status(job.status)}</td><td>${job.attempts}</td><td>${fmtDate(job.updatedAt)}</td><td><small>${esc(job.error || '')}</small></td></tr>`).join('');
  return `<section class="grid-3">
    <article class="panel"><div class="panel-head"><div><h2>账号安全</h2><p>修改后台登录账号或密码</p></div></div><div class="panel-body"><form id="account-form" class="stack"><label>登录账号<input name="username" value="${esc(state.session.user.username)}" required></label><label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>新密码（不修改可留空）<input name="newPassword" type="password" minlength="10" autocomplete="new-password"></label><label>确认新密码<input name="confirmPassword" type="password" minlength="10" autocomplete="new-password"></label><button class="primary" type="submit">保存并重新登录</button></form></div></article>
    <article class="panel"><div class="panel-head"><div><h2>备份与恢复</h2><p>浏览器 JSON 与整机迁移包</p></div></div><div class="panel-body stack"><div class="notice">备份含客户凭据，请加密保管。整机迁移推荐 SSH 运行 <b>ng backup</b>，新机安装后把压缩包放进 /root，再运行 <b>ng restore</b>。</div><div class="toolbar"><button class="primary" data-action="download-backup">下载 JSON</button><button data-action="restore-backup">恢复 JSON</button></div></div></article>
    <article class="panel"><div class="panel-head"><div><h2>版本与证书</h2><p>轻量单进程控制面</p></div></div><div class="panel-body"><div class="health-row"><div><b>NexusGate</b><span>当前版本</span></div><span class="tag">v${esc(state.version)}</span></div><div class="health-row"><div><b>Caddy HTTPS</b><span>证书自动申请与续签</span></div>${status('active')}</div><div class="codebox">ng update\nng domain new.example.com\nng cert</div></div></article>
  </section>
  <section class="panel" style="margin-top:16px"><div class="panel-head"><div><h2>任务队列</h2><p>任务租约 5 分钟，超时自动重试，最多 3 次</p></div></div><div class="table-wrap"><table><thead><tr><th>任务</th><th>设备</th><th>状态</th><th>尝试</th><th>更新时间</th><th>错误</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty('任务队列为空','部署或停用线路后会产生任务')}</td></tr>`}</tbody></table></div></section>`;
}

function render() {
  const views = { overview: renderOverview, servers: renderServers, customers: renderCustomers, chains: renderChains, deployments: renderDeployments, operations: renderOperations };
  $('#content').innerHTML = views[state.page]();
}

function modal(kicker, title, body) {
  $('#modal-kicker').textContent = kicker; $('#modal-title').textContent = title; $('#modal-body').innerHTML = body;
  if (!$('#modal').open) $('#modal').showModal();
}

function serverForm(item = null) {
  const server = item || { role:'hybrid', portRangeStart:20000, portRangeEnd:50000, labels:[] };
  modal(item ? 'EDIT DEVICE' : 'NEW DEVICE', item ? '编辑设备' : '添加设备', `<form id="server-form" class="form-grid"><input type="hidden" name="resourceId" value="${esc(item ? item.id : '')}">
    <label>设备名称<input name="name" value="${esc(server.name || '')}" placeholder="新加坡入口 01" required></label><label>用途<select name="role"><option value="relay"${selected('relay',server.role)}>入口 / 转发</option><option value="exit"${selected('exit',server.role)}>出口 / 落地</option><option value="hybrid"${selected('hybrid',server.role)}>综合节点</option></select></label>
    <label>地区 / 分组<input name="region" value="${esc(server.region || '')}" placeholder="新加坡"></label><label>公网 IPv4 / 域名<input name="publicAddress" value="${esc(server.publicAddress || '')}" placeholder="203.0.113.10" required></label>
    <label>公网 IPv6（可选）<input name="publicAddressV6" value="${esc(server.publicAddressV6 || '')}" placeholder="2001:db8::10"></label><label>标签（逗号分隔）<input name="labels" value="${esc((server.labels || []).join(', '))}" placeholder="CN2, 高带宽, 主力"></label>
    <label>可用端口起点<input name="portRangeStart" type="number" value="${Number(server.portRangeStart || 20000)}" min="1024" max="65535" required></label><label>可用端口终点<input name="portRangeEnd" type="number" value="${Number(server.portRangeEnd || 50000)}" min="1024" max="65535" required></label>
    <div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">${item ? '保存修改' : '添加设备'}</button></div></form>`);
}

function localDateParts(value) {
  if (!value) return { date:'', time:'23:59' };
  const date = new Date(value); const pad = (number) => String(number).padStart(2, '0');
  return { date:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`, time:`${pad(date.getHours())}:${pad(date.getMinutes())}` };
}

function timeOptions(current = '23:59') {
  const values = ['00:00','06:00','12:00','18:00','23:59'];
  if (current && !values.includes(current)) values.push(current);
  return values.sort().map((value) => `<option value="${value}"${selected(value,current)}>${value}</option>`).join('');
}

function customerForm(item = null) {
  const customer = item || { trafficLimitBytes:0, ipLimit:2, deviceLimit:3, tags:[] };
  const expiry = localDateParts(customer.expiresAt);
  modal(item ? 'EDIT CUSTOMER' : 'NEW CUSTOMER', item ? '编辑客户' : '添加客户', `<form id="customer-form" class="form-grid"><input type="hidden" name="resourceId" value="${esc(item ? item.id : '')}">
    <label>客户名称<input name="name" value="${esc(customer.name || '')}" required></label><label>分组<input name="group" value="${esc(customer.group || '')}" placeholder="华南团队"></label>
    <label>流量上限（GB，0 不限）<input name="trafficGb" type="number" min="0" step="0.01" value="${Number(customer.trafficLimitBytes || 0) / 1024 ** 3}"></label><label>快速到期<select data-expiry-quick><option value="">自定义 / 不限</option><option value="7">7 天后</option><option value="30">30 天后</option><option value="90">90 天后</option><option value="365">1 年后</option></select></label>
    <label>到期日期<input name="expiryDate" type="date" value="${esc(expiry.date)}"><small>留空表示不限期，不再需要手工输入日期格式。</small></label><label>到期时间<select name="expiryTime">${timeOptions(expiry.time)}</select></label>
    <label>滚动 IP 上限<input name="ipLimit" type="number" min="0" step="1" value="${Number(customer.ipLimit || 0)}"><small>0 表示不限，按观察窗口统计。</small></label><label>设备策略上限<input name="deviceLimit" type="number" min="0" step="1" value="${Number(customer.deviceLimit || 0)}"><small>为“一设备一凭据”预留，当前不强制。</small></label>
    <label class="wide">标签（逗号分隔）<input name="tags" value="${esc((customer.tags || []).join(', '))}"></label><label class="wide">备注<textarea name="notes">${esc(customer.notes || '')}</textarea></label>
    <div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">${item ? '保存修改' : '创建客户'}</button></div></form>`);
}

function protocolOptions(role, current) {
  return state.protocols.filter((item) => item.role === role && item.deployable).map((item) => `<option value="${esc(item.id)}"${selected(item.id,current)}>${esc(item.name)}${item.status === 'beta' ? ' · 兼容模式' : ''}</option>`).join('');
}

function multiPicker(name, items, values, subtitle, emptyLabel) {
  return `<details class="multi-picker" data-picker><summary><span data-picker-count>已选择 ${(values || []).length} 项</span><span>▾</span></summary>
    <div class="picker-content"><input type="search" data-picker-search placeholder="搜索名称、地区、地址或分组" aria-label="搜索${esc(emptyLabel)}">
      <div class="picker-options">${items.map((item) => `<label class="picker-option" data-picker-option data-query="${esc([item.name,subtitle(item)].join(' ').toLowerCase())}"><input type="checkbox" name="${esc(name)}" value="${esc(item.id)}"${checked(item.id,values)}><span><b>${esc(item.name)}</b><small>${esc(subtitle(item))}</small></span></label>`).join('') || `<span class="muted">没有可用${esc(emptyLabel)}</span>`}</div>
      <small>支持搜索后连续多选，已选项在折叠后保留。</small></div></details>`;
}

function subscriptionModal(customer) {
  if (!customer || !customer.subscriptionToken) return toast('客户订阅令牌尚未生成，请刷新页面', true);
  const formats = [
    ['auto','自动识别（Clash / 通用 Base64）'], ['base64','通用 Base64 / V2Ray / Shadowrocket'],
    ['clash','Clash Meta / Mihomo'], ['singbox','sing-box JSON 配置'], ['raw','原始节点链接']
  ];
  modal('CLIENT SUBSCRIPTION', `${customer.name} · 订阅链接`, `<div class="stack"><div class="notice">仅展示已成功部署的入口节点。客户停用、到期或流量用尽时链接停止分发。重置令牌会立即使旧订阅地址失效；已复制的节点凭据仍需停用或重建线路才能撤销。</div>
    ${formats.map(([format,label]) => { const url = `${location.origin}/s/${customer.subscriptionToken}/${format}`; return `<div class="subscription-row"><div><b>${esc(label)}</b><code>${esc(url)}</code></div><button type="button" data-action="copy-uri" data-value="${esc(url)}">复制</button></div>`; }).join('')}
    <div class="notice warning">IP 限制按滚动观察窗口执行；同一节点链接可复制，设备数量策略当前尚不能可靠识别物理设备。请勿将订阅地址公开。</div>
    <div class="form-actions"><button class="danger" data-action="rotate-subscription" data-id="${esc(customer.id)}">重置订阅地址</button><button data-close>关闭</button></div></div>`);
}

function chainForm(item = null) {
  const chain = item || { topology:'forward', relayProtocol:'vless-reality-vision', exitProtocol:'shadowsocks-2022-aes128', relayPortMode:'random', exitPortMode:'random', networkMode:'ipv4', realityServerName:'www.tesla.com', realityDestPort:443, relayServerIds:[], customerIds:[] };
  const preset = state.realityPresets.find((entry) => entry.serverName === chain.realityServerName) || { id:'custom' };
  modal(item ? 'EDIT ROUTE' : 'NEW ROUTE', item ? '编辑线路' : '新建线路', `<form id="chain-form" class="form-grid"><input type="hidden" name="resourceId" value="${esc(item ? item.id : '')}">
    <label class="wide">线路名称<input name="name" value="${esc(chain.name || '')}" placeholder="新加坡入口 → 日本出口" required></label>
    <label>线路类型<select name="topology" data-chain-sync><option value="forward"${selected('forward',chain.topology || 'forward')}>转发线路（入口 → 出口）</option><option value="direct"${selected('direct',chain.topology)}>单机直连（无需出口）</option></select></label>
    <label>网络栈<select name="networkMode"><option value="ipv4"${selected('ipv4',chain.networkMode || 'ipv4')}>IPv4</option><option value="ipv6"${selected('ipv6',chain.networkMode)}>IPv6</option><option value="dual"${selected('dual',chain.networkMode)}>双栈监听</option></select><small>IPv6 模式要求设备已填写公网 IPv6。</small></label>
    <div class="section-title">入口与客户端节点</div>
    <div class="wide picker-field"><span>入口 / 节点设备</span>${multiPicker('relayServerIds',state.servers,chain.relayServerIds,(server) => `${roleText[server.role]} · ${server.region || server.publicAddress} · ${server.publicAddress}`,'设备')}</div>
    <label>客户端入口协议<select name="relayProtocol" data-chain-sync>${protocolOptions('relay-ingress', chain.relayProtocol)}</select></label>
    <label>入口端口<div class="inline-fields"><select name="relayPortMode" data-chain-sync><option value="random"${selected('random',chain.relayPortMode)}>范围内随机</option><option value="fixed"${selected('fixed',chain.relayPortMode)}>固定端口</option></select><input name="relayPort" type="number" value="${esc(chain.relayPort || '')}" placeholder="固定时填写" min="1024" max="65535"></div></label>
    <div class="notice wide" data-protocol-note></div>
    <label data-reality-only>Reality 目标预设<select name="realityPreset" data-reality-preset>${state.realityPresets.map((entry) => `<option value="${esc(entry.id)}" data-sni="${esc(entry.serverName)}" data-port="${entry.destPort}"${selected(entry.id,preset.id)}>${esc(entry.label)} · ${esc(entry.serverName)}</option>`).join('')}<option value="custom"${selected('custom',preset.id)}>自定义</option></select></label>
    <label data-reality-only>Reality SNI / 目标端口<div class="inline-fields"><input name="realityServerName" value="${esc(chain.realityServerName || 'www.tesla.com')}" placeholder="www.tesla.com"><input name="realityDestPort" type="number" value="${Number(chain.realityDestPort || 443)}" min="1" max="65535"></div><small>默认 Tesla。预设仅提供填写便利，不是防盗用功能；目标站点须支持所选 SNI。</small></label>
    <div class="section-title" data-forward-only>出口与转发传输</div>
    <label data-forward-only>出口 / 落地设备<select name="exitServerId">${state.servers.map((server) => `<option value="${esc(server.id)}"${selected(server.id,chain.exitServerId)}>${esc(server.name)} · ${esc(roleText[server.role])}</option>`).join('')}</select></label>
    <label data-forward-only>入口到出口协议<select name="exitProtocol" data-chain-sync>${protocolOptions('exit-transport', chain.exitProtocol)}</select><small>出口可独立选 SS / SS2022 / VLESS TCP / SOCKS5，不要求与入口同协议。</small></label>
    <label data-forward-only>出口端口<div class="inline-fields"><select name="exitPortMode" data-chain-sync><option value="random"${selected('random',chain.exitPortMode)}>范围内随机</option><option value="fixed"${selected('fixed',chain.exitPortMode)}>固定端口</option></select><input name="exitPort" type="number" value="${esc(chain.exitPort || '')}" placeholder="固定时填写" min="1024" max="65535"></div></label>
    <div class="section-title">客户分配</div>
    <div class="wide picker-field"><span>客户</span>${multiPicker('customerIds',state.customers.filter((customer) => customer.status === 'active' || (chain.customerIds || []).includes(customer.id)),chain.customerIds,(customer) => `${customer.group || '未分组'}${customer.status !== 'active' ? ' · 已停用' : ''}`,'客户')}<small>批量选择多个客户时请使用随机端口。</small></div>
    <div class="notice wide">当前可部署协议如上。Hysteria 2、AnyTLS、VLESS WS TLS 需要额外的协议引擎或节点证书自动化，目前不会出现在可选列表中，避免创建后才发现无法部署。</div>
    ${item && !['draft'].includes(item.status) ? '<div class="notice warning wide">保存运行中线路只会标记“待重新部署”，不会立即中断服务。确认后再点击“应用修改”。</div>' : ''}
    <div class="form-actions"><button type="button" data-close>取消</button><button class="primary" type="submit">${item ? '保存修改' : '创建线路'}</button></div></form>`);
  syncChainForm();
}

function syncChainForm() {
  const form = $('#chain-form'); if (!form) return;
  const direct = form.elements.topology.value === 'direct';
  $$('[data-forward-only]', form).forEach((element) => element.classList.toggle('hidden', direct));
  form.elements.exitServerId.required = !direct; form.elements.exitProtocol.required = !direct;
  const reality = ['vless-reality-vision','vless-reality'].includes(form.elements.relayProtocol.value);
  $$('[data-reality-only]', form).forEach((element) => element.classList.toggle('hidden', !reality));
  form.elements.realityServerName.required = reality;
  const protocol = state.protocols.find((item) => item.id === form.elements.relayProtocol.value && item.role === 'relay-ingress');
  $('[data-protocol-note]', form).textContent = protocol ? `入口：${protocol.description} ${reality ? 'Reality 默认使用 Tesla SNI，可从下拉菜单切换。' : '此协议不需要 Reality SNI。'}` : '请选择可部署的入口协议。';
  for (const [mode, port] of [['relayPortMode','relayPort'],['exitPortMode','exitPort']]) {
    const fixed = form.elements[mode].value === 'fixed' && (mode === 'relayPortMode' || !direct);
    form.elements[port].disabled = !fixed;
    form.elements[port].required = fixed;
  }
}

function expiryIso(formData) {
  const date = formData.get('expiryDate'); if (!date) return null;
  const time = formData.get('expiryTime') || '23:59';
  const result = new Date(`${date}T${time}:00`);
  if (!Number.isFinite(result.getTime())) throw new Error('请选择有效的到期日期');
  return result.toISOString();
}

document.addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.target; const data = new FormData(form);
  try {
    if (form.id === 'login-form') {
      $('#login-error').textContent = '';
      state.session = await api('/api/auth/login', { method:'POST', body:JSON.stringify({ username:data.get('username'), password:data.get('password') }) });
      showApp(); setPage('overview'); return;
    }
    if (form.id === 'server-form') {
      const resourceId = data.get('resourceId');
      const payload = { name:data.get('name'), role:data.get('role'), region:data.get('region'), publicAddress:data.get('publicAddress'), publicAddressV6:data.get('publicAddressV6'), portRangeStart:Number(data.get('portRangeStart')), portRangeEnd:Number(data.get('portRangeEnd')), labels:splitList(data.get('labels')) };
      await api(resourceId ? `/api/servers/${resourceId}` : '/api/servers', { method:resourceId ? 'PATCH' : 'POST', body:JSON.stringify(payload) });
      $('#modal').close(); toast(resourceId ? '设备信息已更新' : '设备已添加'); await load('servers');
    } else if (form.id === 'customer-form') {
      const resourceId = data.get('resourceId');
      const payload = { name:data.get('name'), group:data.get('group'), trafficLimitBytes:Number(data.get('trafficGb') || 0) * 1024 ** 3, expiresAt:expiryIso(data), ipLimit:Number(data.get('ipLimit') || 0), deviceLimit:Number(data.get('deviceLimit') || 0), tags:splitList(data.get('tags')), notes:data.get('notes') };
      await api(resourceId ? `/api/customers/${resourceId}` : '/api/customers', { method:resourceId ? 'PATCH' : 'POST', body:JSON.stringify(payload) });
      $('#modal').close(); toast(resourceId ? '客户信息已更新' : '客户已创建'); await load('customers');
    } else if (form.id === 'chain-form') {
      const resourceId = data.get('resourceId');
      const payload = { name:data.get('name'), topology:data.get('topology'), networkMode:data.get('networkMode'), relayServerIds:data.getAll('relayServerIds'), exitServerId:data.get('exitServerId') || null, customerIds:data.getAll('customerIds'), relayProtocol:data.get('relayProtocol'), exitProtocol:data.get('exitProtocol') || null, relayPortMode:data.get('relayPortMode'), relayPort:data.get('relayPort') || null, exitPortMode:data.get('exitPortMode') || null, exitPort:data.get('exitPort') || null, realityServerName:data.get('realityServerName'), realityDestPort:Number(data.get('realityDestPort') || 443) };
      const result = await api(resourceId ? `/api/chains/${resourceId}` : '/api/chains', { method:resourceId ? 'PATCH' : 'POST', body:JSON.stringify(payload) });
      $('#modal').close(); toast(result.requiresRedeploy ? '修改已保存，请点击“应用修改”' : (resourceId ? '线路已更新' : '线路草稿已创建')); await load('chains');
    } else if (form.id === 'account-form') {
      if (data.get('newPassword') !== data.get('confirmPassword')) throw new Error('两次输入的新密码不一致');
      await api('/api/account', { method:'PATCH', body:JSON.stringify({ username:data.get('username'), currentPassword:data.get('currentPassword'), newPassword:data.get('newPassword') }) });
      toast('账号已更新，请重新登录'); $('#login-form [name="username"]').value = data.get('username'); showLogin();
    }
  } catch (error) { if (form.id === 'login-form') $('#login-error').textContent = error.message; else toast(error.message, true); }
});

document.addEventListener('click', async (event) => {
  const theme = event.target.closest('[data-theme-toggle]'); if (theme) { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return; }
  const nav = event.target.closest('[data-page]'); if (nav) { setPage(nav.dataset.page); return; }
  const jump = event.target.closest('[data-page-jump]'); if (jump) { setPage(jump.dataset.pageJump); return; }
  if (event.target.closest('[data-close]')) { $('#modal').close(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action; const itemId = button.dataset.id;
  try {
    if (action === 'add-server') serverForm();
    else if (action === 'edit-server') serverForm(state.servers.find((item) => item.id === itemId));
    else if (action === 'add-customer') customerForm();
    else if (action === 'edit-customer') customerForm(state.customers.find((item) => item.id === itemId));
    else if (action === 'customer-subscription') subscriptionModal(state.customers.find((item) => item.id === itemId));
    else if (action === 'rotate-subscription' && confirm('旧订阅地址会立刻失效。已导入的节点凭据不会随订阅令牌重置，确认继续？')) {
      const result = await api(`/api/customers/${itemId}/rotate-subscription`, { method:'POST', body:'{}' });
      state.customers = state.customers.map((item) => item.id === itemId ? result.customer : item);
      subscriptionModal(result.customer); toast('订阅地址已重置');
    }
    else if (action === 'add-chain') chainForm();
    else if (action === 'edit-chain') {
      if (!state.protocols.length) { const result = await api('/api/protocols'); state.protocols = result.profiles; state.realityPresets = result.realityPresets || []; }
      chainForm(state.chains.find((item) => item.id === itemId));
    } else if (action === 'enroll-server') {
      const result = await api(`/api/servers/${itemId}/enrollment-token`, { method:'POST', body:'{}' });
      const command = `curl -fsSL https://raw.githubusercontent.com/a2899882/NexusGate/main/scripts/agent-install.sh | bash -s -- --server ${location.origin} --token ${result.token}`;
      modal('ONE-TIME ENROLLMENT', 'Agent 注册 / 重装命令', `<div class="stack"><div class="notice">令牌 30 分钟内有效且只能使用一次。重装会保留本机资源文件，并在 Agent 重启后自动与控制面对账。</div><div class="codebox">${esc(command)}</div><button class="primary" data-action="copy-uri" data-value="${esc(command)}">复制命令</button></div>`);
    } else if (action === 'copy-uri') { await navigator.clipboard.writeText(button.dataset.value); toast('已复制到剪贴板'); }
    else if (action === 'agent-uninstall') {
      const command = 'ng-agent uninstall';
      const fallback = 'curl -fsSL https://raw.githubusercontent.com/a2899882/NexusGate/main/scripts/agent-uninstall.sh | bash';
      modal('AGENT MAINTENANCE', '在目标服务器 SSH 卸载 Agent', `<div class="stack"><div class="notice warning">先停用并删除关联线路，让在线 Agent 完成资源清理。卸载会停止 NexusGate 专属服务并移除密钥与节点配置。然后在控制台删除设备登记；离线且有待清理项时使用“遗忘离线设备”。遗忘不会远程卸载机器。</div><div class="codebox">${esc(command)}</div><button data-action="copy-uri" data-value="${esc(command)}">复制命令</button><small>旧版 Agent 没有 ng-agent 命令时，使用下列兼容命令：</small><div class="codebox">${esc(fallback)}</div><button data-action="copy-uri" data-value="${esc(fallback)}">复制兼容命令</button></div>`);
    }
    else if (action === 'retry-cleanup') { const result = await api(`/api/servers/${itemId}/cleanup`, { method:'POST', body:'{}' }); toast(result.queued ? `已重新排队 ${result.queued} 个清理任务` : '清理任务已在队列中，请等待设备上线'); await load(); }
    else if (action === 'forget-server') {
      const item = state.servers.find((entry) => entry.id === itemId);
      if (!item) return;
      const name = prompt(`仅在服务器永久下线、销毁，或已手工清除其代理配置时使用。强制遗忘会放弃 ${item.pendingCleanup} 项远程清理；旧节点若仍运行，配置可能继续监听。\n\n请输入设备名称「${item.name}」确认：`);
      if (name !== item.name) return;
      await api(`/api/servers/${itemId}/forget`, { method:'POST', body:JSON.stringify({ confirm:'FORGET', name }) });
      toast('已强制遗忘设备；请确保旧机器已销毁或手工清理'); await load();
    }
    else if (action === 'delete-server' && confirm('删除控制台登记并吊销 Agent 密钥？如需要彻底卸载，请先在目标机 SSH 执行 ng-agent uninstall。')) { await api(`/api/servers/${itemId}`, { method:'DELETE' }); toast('设备登记已删除'); await load(); }
    else if (action === 'delete-customer' && confirm('删除客户及订阅地址？须先删除关联线路；归档清理任务会在后台继续执行。')) { await api(`/api/customers/${itemId}`, { method:'DELETE' }); toast('客户已删除'); await load(); }
    else if (action === 'reset-usage' && confirm('确认把该客户已用流量清零？')) { await api(`/api/customers/${itemId}/reset-usage`, { method:'POST', body:'{}' }); toast('客户流量已清零'); await load(); }
    else if (action === 'toggle-customer') {
      const item = state.customers.find((entry) => entry.id === itemId);
      await api(`/api/customers/${itemId}`, { method:'PATCH', body:JSON.stringify({ status:item.status === 'active' ? 'suspended' : 'active' }) }); toast('客户状态已更新'); await load();
    } else if (action === 'deploy-chain' && confirm('现在向所选设备下发这条线路？')) { await api(`/api/chains/${itemId}/deploy`, { method:'POST', body:'{}' }); toast('部署任务已进入队列'); await load(); }
    else if (action === 'redeploy-chain' && confirm('重新部署会先移除旧资源，再自动创建新资源。确认继续？')) { await api(`/api/chains/${itemId}/redeploy`, { method:'POST', body:'{}' }); toast('线路已进入安全重建流程'); await load(); }
    else if (action === 'repair-chain' && confirm('仅重试当前失败的部署项？')) { await api(`/api/chains/${itemId}/repair`, { method:'POST', body:'{}' }); toast('修复任务已进入队列'); await load(); }
    else if (action === 'remove-chain' && confirm('停用会从相关设备移除配置，确认继续？')) { await api(`/api/chains/${itemId}/remove`, { method:'POST', body:'{}' }); toast('移除任务已进入队列'); await load(); }
    else if (action === 'delete-chain' && confirm('确定删除这条线路？未完成的部署会取消；系统会给相关设备排队清理遗留资源。运行中的资源须先停用。')) { const result = await api(`/api/chains/${itemId}`, { method:'DELETE' }); toast(result.cleanupPending ? `线路已移除，${result.cleanupPending} 个设备资源待 Agent 确认清理` : '线路已删除'); await load(); }
    else if (action === 'download-backup') location.href = '/api/backup';
    else if (action === 'restore-backup') {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.onchange = async () => {
        try {
          if (!input.files[0] || !confirm('恢复会覆盖当前全部控制面数据，确认继续？')) return;
          const backupData = JSON.parse(await input.files[0].text()); await api('/api/restore', { method:'POST', body:JSON.stringify({ confirm:'RESTORE', data:backupData }) }); location.reload();
        } catch (error) { toast(error.message, true); }
      }; input.click();
    }
  } catch (error) { toast(error.message, true); }
});

document.addEventListener('change', (event) => {
  if (event.target.closest('[data-picker-option]')) {
    const picker = event.target.closest('[data-picker]');
    $('[data-picker-count]', picker).textContent = `已选择 ${$$('input[type="checkbox"]:checked', picker).length} 项`;
  }
  if (event.target.matches('[data-chain-sync]')) syncChainForm();
  if (event.target.matches('[data-reality-preset]')) {
    const option = event.target.selectedOptions[0]; const form = event.target.form;
    if (option && option.value !== 'custom') { form.elements.realityServerName.value = option.dataset.sni; form.elements.realityDestPort.value = option.dataset.port; }
  }
  if (event.target.matches('[data-expiry-quick]') && event.target.value) {
    const target = new Date(); target.setDate(target.getDate() + Number(event.target.value));
    const pad = (number) => String(number).padStart(2, '0');
    event.target.form.elements.expiryDate.value = `${target.getFullYear()}-${pad(target.getMonth()+1)}-${pad(target.getDate())}`;
    event.target.form.elements.expiryTime.value = '23:59';
  }
});

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-picker-search]')) {
    const picker = event.target.closest('[data-picker]'); const query = event.target.value.trim().toLowerCase();
    $$('[data-picker-option]', picker).forEach((option) => { option.hidden = !option.dataset.query.includes(query); });
    return;
  }
  if (event.target.matches('[data-search]')) { state.search = event.target.value; render(); const next = $('[data-search]'); next.focus(); next.setSelectionRange(next.value.length,next.value.length); }
});

function closeSidebar() { $('#app').classList.remove('sidebar-open'); }
$('#menu-toggle').addEventListener('click', () => $('#app').classList.add('sidebar-open'));
$('#sidebar-scrim').addEventListener('click', closeSidebar);
$('#refresh').addEventListener('click', () => load());
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method:'POST', body:'{}' }); } finally { showLogin(); } });

(async function boot() {
  let preferred = 'light'; try { preferred = localStorage.getItem('nexusgate-theme') || 'light'; } catch { /* storage may be disabled */ }
  setTheme(preferred);
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return showLogin();
    state.session = session; showApp(); await load('overview');
  } catch { showLogin(); }
  setInterval(() => { if (state.session && document.visibilityState === 'visible' && !$('#modal').open) load(); }, 45000);
})();
