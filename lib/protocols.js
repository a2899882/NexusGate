'use strict';

const crypto = require('node:crypto');

const PROFILE_CATALOG = Object.freeze([
  {
    id: 'vless-reality-vision', role: 'relay-ingress', name: 'VLESS · Reality · Vision',
    status: 'stable', description: '推荐入口；无需域名证书，支持 Vision 流控。'
  },
  {
    id: 'shadowsocks-2022-aes128', role: 'relay-ingress', name: 'Shadowsocks 2022 · AES-128',
    status: 'stable', description: '轻量入口，使用 2022-blake3-aes-128-gcm。'
  },
  {
    id: 'vmess-ws', role: 'relay-ingress', name: 'VMess · WebSocket',
    status: 'beta', description: '兼容旧客户端；生产环境建议在外层增加 TLS。'
  },
  {
    id: 'shadowsocks-2022-aes128', role: 'exit-transport', name: 'Shadowsocks 2022 · AES-128',
    status: 'stable', description: '推荐的中转到落地传输。'
  },
  {
    id: 'shadowsocks-aes128-gcm', role: 'exit-transport', name: 'Shadowsocks · AES-128-GCM',
    status: 'stable', description: '兼容旧版 SS 客户端和服务端。'
  }
]);

function b64(bytes) {
  return crypto.randomBytes(bytes).toString('base64');
}

function shortId() {
  return crypto.randomBytes(8).toString('hex');
}

function newCredentialSet(relayProtocol, exitProtocol) {
  return {
    clientId: crypto.randomUUID(),
    relayPassword: relayProtocol === 'shadowsocks-2022-aes128' ? b64(16) : b64(24),
    exitPassword: exitProtocol === 'shadowsocks-2022-aes128' ? b64(16) : b64(24),
    shortId: shortId(),
    wsPath: `/${crypto.randomBytes(8).toString('hex')}`
  };
}

function inboundBase(tag, port, protocol, settings, streamSettings) {
  return {
    tag, listen: '0.0.0.0', port, protocol, settings,
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
    ...(streamSettings ? { streamSettings } : {})
  };
}

function buildExitResource({ resourceId, tagPrefix, port, protocol, credentials, customer }) {
  let inbound;
  if (protocol === 'shadowsocks-2022-aes128') {
    inbound = inboundBase(`${tagPrefix}-in`, port, 'shadowsocks', {
      method: '2022-blake3-aes-128-gcm', password: credentials.exitPassword,
      network: 'tcp,udp'
    });
  } else if (protocol === 'shadowsocks-aes128-gcm') {
    inbound = inboundBase(`${tagPrefix}-in`, port, 'shadowsocks', {
      method: 'aes-128-gcm', password: credentials.exitPassword,
      network: 'tcp,udp'
    });
  } else {
    throw new Error(`Unsupported exit transport: ${protocol}`);
  }
  const directTag = `${tagPrefix}-direct`;
  return {
    id: resourceId,
    meta: { kind: 'exit', customerId: customer.id, metricsTag: inbound.tag },
    inbounds: [inbound],
    outbounds: [{ tag: directTag, protocol: 'freedom', settings: {} }],
    routingRules: [{ type: 'field', inboundTag: [inbound.tag], outboundTag: directTag }]
  };
}

function buildRelayInbound({ tag, port, protocol, credentials, customer, reality }) {
  const email = `ng:${customer.id}`;
  if (protocol === 'vless-reality-vision') {
    return inboundBase(tag, port, 'vless', {
      clients: [{ id: credentials.clientId, email, flow: 'xtls-rprx-vision' }],
      decryption: 'none'
    }, {
      network: 'raw', security: 'reality',
      realitySettings: {
        show: false,
        dest: `${reality.serverName}:${reality.destPort}`,
        xver: 0,
        serverNames: [reality.serverName],
        privateKey: `\${REALITY_PRIVATE:${reality.keyId}}`,
        shortIds: [credentials.shortId]
      }
    });
  }
  if (protocol === 'shadowsocks-2022-aes128') {
    return inboundBase(tag, port, 'shadowsocks', {
      method: '2022-blake3-aes-128-gcm', password: credentials.relayPassword,
      network: 'tcp,udp'
    });
  }
  if (protocol === 'vmess-ws') {
    return inboundBase(tag, port, 'vmess', {
      clients: [{ id: credentials.clientId, email }]
    }, {
      network: 'ws', security: 'none', wsSettings: { path: credentials.wsPath }
    });
  }
  throw new Error(`Unsupported relay ingress: ${protocol}`);
}

function buildRelayResource({ resourceId, tagPrefix, port, protocol, exitProtocol, exitServer, exitPort, credentials, customer, reality }) {
  const inbound = buildRelayInbound({
    tag: `${tagPrefix}-in`, port, protocol, credentials, customer, reality
  });
  const outboundTag = `${tagPrefix}-exit`;
  let outbound;
  if (exitProtocol === 'shadowsocks-2022-aes128') {
    outbound = {
      tag: outboundTag, protocol: 'shadowsocks',
      settings: { servers: [{ address: exitServer.publicAddress, port: exitPort, method: '2022-blake3-aes-128-gcm', password: credentials.exitPassword }] }
    };
  } else if (exitProtocol === 'shadowsocks-aes128-gcm') {
    outbound = {
      tag: outboundTag, protocol: 'shadowsocks',
      settings: { servers: [{ address: exitServer.publicAddress, port: exitPort, method: 'aes-128-gcm', password: credentials.exitPassword }] }
    };
  } else {
    throw new Error(`Unsupported exit transport: ${exitProtocol}`);
  }
  return {
    id: resourceId,
    meta: { kind: 'relay', customerId: customer.id, metricsTag: inbound.tag, protocol },
    inbounds: [inbound], outbounds: [outbound],
    routingRules: [{ type: 'field', inboundTag: [inbound.tag], outboundTag }]
  };
}

function buildClientUri({ protocol, relayServer, relayPort, credentials, reality, publicKey, name }) {
  const label = encodeURIComponent(name);
  if (protocol === 'vless-reality-vision') {
    if (!publicKey) return null;
    const query = new URLSearchParams({
      encryption: 'none', flow: 'xtls-rprx-vision', security: 'reality',
      sni: reality.serverName, fp: 'chrome', pbk: publicKey,
      sid: credentials.shortId, type: 'tcp', headerType: 'none'
    });
    return `vless://${credentials.clientId}@${relayServer.publicAddress}:${relayPort}?${query}#${label}`;
  }
  if (protocol === 'shadowsocks-2022-aes128') {
    const user = Buffer.from(`2022-blake3-aes-128-gcm:${credentials.relayPassword}`).toString('base64url');
    return `ss://${user}@${relayServer.publicAddress}:${relayPort}#${label}`;
  }
  if (protocol === 'vmess-ws') {
    const payload = {
      v: '2', ps: name, add: relayServer.publicAddress, port: String(relayPort),
      id: credentials.clientId, aid: '0', scy: 'auto', net: 'ws', type: 'none',
      host: '', path: credentials.wsPath, tls: ''
    };
    return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  }
  return null;
}

function validateProtocolPair(relayProtocol, exitProtocol) {
  const ingress = PROFILE_CATALOG.some((p) => p.role === 'relay-ingress' && p.id === relayProtocol);
  const exit = PROFILE_CATALOG.some((p) => p.role === 'exit-transport' && p.id === exitProtocol);
  if (!ingress) throw new Error(`Unsupported relay ingress: ${relayProtocol}`);
  if (!exit) throw new Error(`Unsupported exit transport: ${exitProtocol}`);
}

module.exports = {
  PROFILE_CATALOG, newCredentialSet, buildExitResource, buildRelayResource,
  buildClientUri, validateProtocolPair
};
