'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const REALITY_PRESETS = Object.freeze([
  { id: 'tesla', label: 'Tesla', serverName: 'www.tesla.com', destPort: 443 },
  { id: 'amazon', label: 'Amazon', serverName: 'www.amazon.com', destPort: 443 },
  { id: 'apple', label: 'Apple', serverName: 'www.apple.com', destPort: 443 },
  { id: 'intel', label: 'Intel', serverName: 'www.intel.com', destPort: 443 },
  { id: 'amd', label: 'AMD', serverName: 'www.amd.com', destPort: 443 }
]);

const PROFILE_CATALOG = Object.freeze([
  { id: 'vless-reality-vision', role: 'relay-ingress', name: 'VLESS · Reality · Vision', status: 'stable', deployable: true, capabilities: ['reality'], description: '推荐公网入口，无需在节点机部署证书。' },
  { id: 'vless-reality', role: 'relay-ingress', name: 'VLESS · Reality', status: 'stable', deployable: true, capabilities: ['reality'], description: '不启用 Vision 流控的 Reality 入口。' },
  { id: 'vless-ws', role: 'relay-ingress', name: 'VLESS · WebSocket', status: 'beta', deployable: true, capabilities: ['websocket'], description: '无 TLS 的兼容模式，建议仅在可信或外层 TLS 环境使用。' },
  { id: 'vmess-ws', role: 'relay-ingress', name: 'VMess · WebSocket', status: 'beta', deployable: true, capabilities: ['websocket'], description: '兼容旧客户端，建议仅在外层 TLS 环境使用。' },
  { id: 'shadowsocks-2022-aes128', role: 'relay-ingress', name: 'SS 2022 · AES-128', status: 'stable', deployable: true, capabilities: [], description: '轻量、推荐的 AEAD 2022 入口。' },
  { id: 'shadowsocks-2022-aes256', role: 'relay-ingress', name: 'SS 2022 · AES-256', status: 'stable', deployable: true, capabilities: [], description: '32 字节密钥的 AEAD 2022 入口。' },
  { id: 'shadowsocks-aes128-gcm', role: 'relay-ingress', name: 'SS · AES-128-GCM', status: 'stable', deployable: true, capabilities: [], description: '兼容主流旧版 Shadowsocks 客户端。' },
  { id: 'shadowsocks-aes256-gcm', role: 'relay-ingress', name: 'SS · AES-256-GCM', status: 'stable', deployable: true, capabilities: [], description: '兼容主流旧版 Shadowsocks 客户端。' },
  { id: 'socks5-auth', role: 'relay-ingress', name: 'SOCKS5 · 用户密码', status: 'stable', deployable: true, capabilities: [], description: '适合受控网络或程序级代理。' },
  { id: 'vless-ws-tls', role: 'relay-ingress', name: 'VLESS · WS · TLS', status: 'planned', deployable: false, capabilities: ['tls-domain'], description: '需要节点域名和证书自动化，暂不开放下发。' },
  { id: 'hysteria2', role: 'relay-ingress', name: 'Hysteria 2', status: 'planned', deployable: false, capabilities: ['udp', 'tls-domain', 'sing-box'], description: '需要 sing-box/QUIC 与证书引擎，后续版本开放。' },
  { id: 'anytls', role: 'relay-ingress', name: 'AnyTLS', status: 'planned', deployable: false, capabilities: ['tls-domain', 'sing-box'], description: '需要 sing-box 与证书引擎，后续版本开放。' },
  { id: 'shadowsocks-2022-aes128', role: 'exit-transport', name: 'SS 2022 · AES-128', status: 'stable', deployable: true, capabilities: ['encrypted'], description: '推荐的转发到出口传输。' },
  { id: 'shadowsocks-2022-aes256', role: 'exit-transport', name: 'SS 2022 · AES-256', status: 'stable', deployable: true, capabilities: ['encrypted'], description: '增强密钥长度的转发传输。' },
  { id: 'shadowsocks-aes128-gcm', role: 'exit-transport', name: 'SS · AES-128-GCM', status: 'stable', deployable: true, capabilities: ['encrypted'], description: '兼容旧环境的转发传输。' },
  { id: 'shadowsocks-aes256-gcm', role: 'exit-transport', name: 'SS · AES-256-GCM', status: 'stable', deployable: true, capabilities: ['encrypted'], description: '兼容旧环境的转发传输。' },
  { id: 'vless-tcp', role: 'exit-transport', name: 'VLESS · TCP', status: 'beta', deployable: true, capabilities: [], description: '适合可信内网或已有加密隧道，不建议裸露公网。' },
  { id: 'socks5-auth', role: 'exit-transport', name: 'SOCKS5 · 用户密码', status: 'beta', deployable: true, capabilities: [], description: '不加密，仅用于可信网络或外层隧道。' }
]);

const SHADOWSOCKS_METHODS = Object.freeze({
  'shadowsocks-2022-aes128': { method: '2022-blake3-aes-128-gcm', keyBytes: 16 },
  'shadowsocks-2022-aes256': { method: '2022-blake3-aes-256-gcm', keyBytes: 32 },
  'shadowsocks-aes128-gcm': { method: 'aes-128-gcm', keyBytes: 24 },
  'shadowsocks-aes256-gcm': { method: 'aes-256-gcm', keyBytes: 32 }
});

function b64(bytes) { return crypto.randomBytes(bytes).toString('base64'); }
function shortId() { return crypto.randomBytes(8).toString('hex'); }

function newCredentialSet(relayProtocol, exitProtocol) {
  const relayCipher = SHADOWSOCKS_METHODS[relayProtocol];
  const exitCipher = SHADOWSOCKS_METHODS[exitProtocol];
  return {
    clientId: crypto.randomUUID(),
    relayPassword: b64(relayCipher ? relayCipher.keyBytes : 24),
    exitPassword: b64(exitCipher ? exitCipher.keyBytes : 24),
    socksUser: `ng_${crypto.randomBytes(5).toString('hex')}`,
    shortId: shortId(),
    wsPath: `/${crypto.randomBytes(8).toString('hex')}`
  };
}

function listenAddress(networkMode) { return networkMode === 'ipv6' || networkMode === 'dual' ? '::' : '0.0.0.0'; }

function inboundBase(tag, port, protocol, settings, streamSettings, networkMode = 'ipv4') {
  return {
    tag, listen: listenAddress(networkMode), port, protocol, settings,
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
    ...(streamSettings ? { streamSettings } : {})
  };
}

function shadowsocksInbound(tag, port, protocol, password, networkMode) {
  const cipher = SHADOWSOCKS_METHODS[protocol];
  if (!cipher) return null;
  return inboundBase(tag, port, 'shadowsocks', { method: cipher.method, password, network: 'tcp,udp' }, null, networkMode);
}

function socksInbound(tag, port, credentials, password, networkMode) {
  return inboundBase(tag, port, 'socks', {
    auth: 'password', accounts: [{ user: credentials.socksUser, pass: password }], udp: true, ip: '127.0.0.1', userLevel: 0
  }, null, networkMode);
}

function buildExitResource({ resourceId, tagPrefix, port, protocol, credentials, customer, networkMode }) {
  let inbound = shadowsocksInbound(`${tagPrefix}-in`, port, protocol, credentials.exitPassword, networkMode);
  if (protocol === 'socks5-auth') inbound = socksInbound(`${tagPrefix}-in`, port, credentials, credentials.exitPassword, networkMode);
  if (protocol === 'vless-tcp') {
    inbound = inboundBase(`${tagPrefix}-in`, port, 'vless', {
      clients: [{ id: credentials.clientId, email: `ng:${customer.id}` }], decryption: 'none'
    }, { network: 'raw', security: 'none' }, networkMode);
  }
  if (!inbound) throw new Error(`Unsupported exit transport: ${protocol}`);
  const directTag = `${tagPrefix}-direct`;
  return {
    id: resourceId, meta: { kind: 'exit', customerId: customer.id, metricsTag: inbound.tag }, inbounds: [inbound],
    outbounds: [{ tag: directTag, protocol: 'freedom', settings: {} }],
    routingRules: [{ type: 'field', inboundTag: [inbound.tag], outboundTag: directTag }]
  };
}

function buildRelayInbound({ tag, port, protocol, credentials, customer, reality, networkMode }) {
  const email = `ng:${customer.id}`;
  if (protocol === 'vless-reality-vision' || protocol === 'vless-reality') {
    const client = { id: credentials.clientId, email };
    if (protocol === 'vless-reality-vision') client.flow = 'xtls-rprx-vision';
    return inboundBase(tag, port, 'vless', { clients: [client], decryption: 'none' }, {
      network: 'raw', security: 'reality',
      realitySettings: {
        show: false, target: `${reality.serverName}:${reality.destPort}`, xver: 0,
        serverNames: [reality.serverName], privateKey: `\${REALITY_PRIVATE:${reality.keyId}}`, shortIds: [credentials.shortId]
      }
    }, networkMode);
  }
  if (SHADOWSOCKS_METHODS[protocol]) return shadowsocksInbound(tag, port, protocol, credentials.relayPassword, networkMode);
  if (protocol === 'socks5-auth') return socksInbound(tag, port, credentials, credentials.relayPassword, networkMode);
  if (protocol === 'vless-ws') {
    return inboundBase(tag, port, 'vless', { clients: [{ id: credentials.clientId, email }], decryption: 'none' }, {
      network: 'ws', security: 'none', wsSettings: { path: credentials.wsPath }
    }, networkMode);
  }
  if (protocol === 'vmess-ws') {
    return inboundBase(tag, port, 'vmess', { clients: [{ id: credentials.clientId, email }] }, {
      network: 'ws', security: 'none', wsSettings: { path: credentials.wsPath }
    }, networkMode);
  }
  throw new Error(`Unsupported relay ingress: ${protocol}`);
}

function serverAddress(server, networkMode) {
  return networkMode === 'ipv6' && server.publicAddressV6 ? server.publicAddressV6 : server.publicAddress;
}

function buildExitOutbound(tag, protocol, exitServer, exitPort, credentials, networkMode) {
  const address = serverAddress(exitServer, networkMode);
  const cipher = SHADOWSOCKS_METHODS[protocol];
  if (cipher) return { tag, protocol: 'shadowsocks', settings: { servers: [{ address, port: exitPort, method: cipher.method, password: credentials.exitPassword }] } };
  if (protocol === 'socks5-auth') return { tag, protocol: 'socks', settings: { servers: [{ address, port: exitPort, users: [{ user: credentials.socksUser, pass: credentials.exitPassword }] }] } };
  if (protocol === 'vless-tcp') {
    return {
      tag, protocol: 'vless', settings: { vnext: [{ address, port: exitPort, users: [{ id: credentials.clientId, encryption: 'none' }] }] },
      streamSettings: { network: 'raw', security: 'none' }
    };
  }
  throw new Error(`Unsupported exit transport: ${protocol}`);
}

function buildRelayResource({ resourceId, tagPrefix, port, protocol, exitProtocol, exitServer, exitPort, credentials, customer, reality, networkMode }) {
  const inbound = buildRelayInbound({ tag: `${tagPrefix}-in`, port, protocol, credentials, customer, reality, networkMode });
  const outboundTag = `${tagPrefix}-exit`;
  return {
    id: resourceId, meta: { kind: 'relay', customerId: customer.id, metricsTag: inbound.tag, protocol },
    inbounds: [inbound], outbounds: [buildExitOutbound(outboundTag, exitProtocol, exitServer, exitPort, credentials, networkMode)],
    routingRules: [{ type: 'field', inboundTag: [inbound.tag], outboundTag }]
  };
}

function buildDirectResource({ resourceId, tagPrefix, port, protocol, credentials, customer, reality, networkMode }) {
  const inbound = buildRelayInbound({ tag: `${tagPrefix}-in`, port, protocol, credentials, customer, reality, networkMode });
  const outboundTag = `${tagPrefix}-direct`;
  return {
    id: resourceId, meta: { kind: 'direct', customerId: customer.id, metricsTag: inbound.tag, protocol },
    inbounds: [inbound], outbounds: [{ tag: outboundTag, protocol: 'freedom', settings: {} }],
    routingRules: [{ type: 'field', inboundTag: [inbound.tag], outboundTag }]
  };
}

function uriHost(address) { return net.isIP(String(address)) === 6 ? `[${address}]` : address; }

function buildClientUri({ protocol, relayServer, relayPort, credentials, reality, publicKey, name, networkMode }) {
  const label = encodeURIComponent(name);
  const publicAddress = serverAddress(relayServer, networkMode);
  const host = uriHost(publicAddress);
  if (protocol === 'vless-reality-vision' || protocol === 'vless-reality') {
    if (!publicKey) return null;
    const query = new URLSearchParams({ encryption: 'none', security: 'reality', sni: reality.serverName, fp: 'chrome', pbk: publicKey, sid: credentials.shortId, type: 'tcp', headerType: 'none' });
    if (protocol === 'vless-reality-vision') query.set('flow', 'xtls-rprx-vision');
    return `vless://${credentials.clientId}@${host}:${relayPort}?${query}#${label}`;
  }
  if (protocol === 'vless-ws') {
    const query = new URLSearchParams({ encryption: 'none', security: 'none', type: 'ws', path: credentials.wsPath });
    return `vless://${credentials.clientId}@${host}:${relayPort}?${query}#${label}`;
  }
  if (SHADOWSOCKS_METHODS[protocol]) {
    const user = Buffer.from(`${SHADOWSOCKS_METHODS[protocol].method}:${credentials.relayPassword}`).toString('base64url');
    return `ss://${user}@${host}:${relayPort}#${label}`;
  }
  if (protocol === 'socks5-auth') return `socks5://${encodeURIComponent(credentials.socksUser)}:${encodeURIComponent(credentials.relayPassword)}@${host}:${relayPort}#${label}`;
  if (protocol === 'vmess-ws') {
    const payload = { v: '2', ps: name, add: publicAddress, port: String(relayPort), id: credentials.clientId, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: '', path: credentials.wsPath, tls: '' };
    return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  }
  return null;
}

function profile(role, protocol) { return PROFILE_CATALOG.find((item) => item.role === role && item.id === protocol); }
function validateEntryProtocol(protocol) {
  const item = profile('relay-ingress', protocol);
  if (!item || !item.deployable) { const error = new Error(`Unsupported relay ingress: ${protocol}`); error.statusCode = 400; throw error; }
}
function validateProtocolPair(relayProtocol, exitProtocol) {
  validateEntryProtocol(relayProtocol);
  const exit = profile('exit-transport', exitProtocol);
  if (!exit || !exit.deployable) { const error = new Error(`Unsupported exit transport: ${exitProtocol}`); error.statusCode = 400; throw error; }
}
function isRealityProtocol(protocol) { return ['vless-reality-vision', 'vless-reality'].includes(protocol); }

module.exports = {
  PROFILE_CATALOG, REALITY_PRESETS, SHADOWSOCKS_METHODS, newCredentialSet, buildExitResource,
  buildRelayResource, buildDirectResource, buildClientUri, validateEntryProtocol, validateProtocolPair, isRealityProtocol
};
