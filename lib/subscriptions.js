'use strict';

// Client URLs are only issued for confirmed, running entry resources.
function entries(data, customerId) {
  return data.deployments.filter((item) => item.customerId === customerId && !item.archived && item.status === 'active' &&
    ['relay', 'direct'].includes(item.role) && typeof item.clientUri === 'string' && item.clientUri.length > 0);
}

function q(value) { return JSON.stringify(String(value)); }

function clashProxy(item) {
  const uri = item.clientUri;
  const name = decodeURIComponent(uri.slice(uri.lastIndexOf('#') + 1));
  if (uri.startsWith('vmess://')) {
    const value = JSON.parse(Buffer.from(uri.slice(8), 'base64').toString('utf8'));
    return { name, type:'vmess', server:value.add, port:Number(value.port), uuid:value.id, alterId:0, cipher:'auto', network:'ws', 'ws-opts':{ path:value.path } };
  }
  const url = new URL(uri);
  const base = { name, server:url.hostname.replace(/^\[|\]$/g, ''), port:Number(url.port) };
  if (url.protocol === 'vless:') {
    const proxy = { ...base, type:'vless', uuid:decodeURIComponent(url.username), tls:url.searchParams.get('security') === 'reality', network:url.searchParams.get('type') === 'ws' ? 'ws' : 'tcp' };
    if (proxy.network === 'ws') proxy['ws-opts'] = { path:url.searchParams.get('path') || '/' };
    if (proxy.tls) {
      proxy.servername = url.searchParams.get('sni');
      proxy['client-fingerprint'] = url.searchParams.get('fp') || 'chrome';
      proxy['reality-opts'] = { 'public-key':url.searchParams.get('pbk'), 'short-id':url.searchParams.get('sid') };
      if (url.searchParams.has('flow')) proxy.flow = url.searchParams.get('flow');
    }
    return proxy;
  }
  if (url.protocol === 'ss:') {
    const decoded = Buffer.from(url.username, 'base64url').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) throw new Error('Invalid Shadowsocks URI');
    return { ...base, type:'ss', cipher:decoded.slice(0, separator), password:decoded.slice(separator + 1) };
  }
  if (url.protocol === 'socks5:') return { ...base, type:'socks5', username:decodeURIComponent(url.username), password:decodeURIComponent(url.password) };
  throw new Error('Unsupported client URI');
}

function yamlValue(value, indent = 0) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([key, child]) => `${' '.repeat(indent)}${key}: ${child && typeof child === 'object' ? `\n${yamlValue(child, indent + 2)}` : yamlValue(child)}`).join('\n');
  }
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return q(value);
}

function makeClash(items) {
  const proxies = items.map(clashProxy);
  const names = proxies.map((item) => item.name);
  const yaml = proxies.map((proxy) => yamlValue(proxy, 4).replace(/^    /, '  - ')).join('\n');
  return `proxies:\n${yaml}\nproxy-groups:\n  - name: ${q('节点选择')}\n    type: select\n    proxies:\n${names.map((name) => `      - ${q(name)}`).join('\n')}\nrules:\n  - MATCH,${q('节点选择')}\n`;
}

function makeSingBox(items) {
  const proxies = items.map(clashProxy).map((proxy, index) => {
    const base = { tag:`node-${index + 1}`, server:proxy.server, server_port:proxy.port };
    if (proxy.type === 'ss') return { type:'shadowsocks', ...base, method:proxy.cipher, password:proxy.password };
    if (proxy.type === 'socks5') return { type:'socks', ...base, version:'5', username:proxy.username, password:proxy.password };
    if (proxy.type === 'vmess') return { type:'vmess', ...base, uuid:proxy.uuid, security:'auto', alter_id:0, transport:{ type:'ws', path:proxy['ws-opts'].path } };
    const outbound = { type:'vless', ...base, uuid:proxy.uuid };
    if (proxy.flow) outbound.flow = proxy.flow;
    if (proxy.network === 'ws') outbound.transport = { type:'ws', path:proxy['ws-opts'].path };
    if (proxy.tls) outbound.tls = { enabled:true, server_name:proxy.servername, reality:{ enabled:true, public_key:proxy['reality-opts']['public-key'], short_id:proxy['reality-opts']['short-id'] } };
    return outbound;
  });
  return JSON.stringify({
    log:{ level:'warn' }, inbounds:[{ type:'mixed', tag:'local', listen:'127.0.0.1', listen_port:2080 }],
    outbounds:[{ type:'selector', tag:'proxy', outbounds:proxies.map((item) => item.tag) }, ...proxies, { type:'direct', tag:'direct' }],
    route:{ final:'proxy' }
  }, null, 2) + '\n';
}

function formatSubscription(data, customer, format, userAgent = '') {
  const items = entries(data, customer.id);
  if (!items.length) return null;
  const selected = format === 'auto' ? (/clash|mihomo/i.test(userAgent) ? 'clash' : 'base64') : format;
  if (selected === 'raw') return { body:items.map((item) => item.clientUri).join('\n') + '\n', contentType:'text/plain; charset=utf-8' };
  if (selected === 'base64') return { body:Buffer.from(items.map((item) => item.clientUri).join('\n') + '\n').toString('base64'), contentType:'text/plain; charset=utf-8' };
  if (selected === 'clash') return { body:makeClash(items), contentType:'text/yaml; charset=utf-8' };
  if (selected === 'singbox') return { body:makeSingBox(items), contentType:'application/json; charset=utf-8' };
  return undefined;
}

module.exports = { entries, clashProxy, makeClash, makeSingBox, formatSubscription };
