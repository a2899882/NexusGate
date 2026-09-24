'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newCredentialSet, buildExitResource, buildRelayResource, buildDirectResource, buildClientUri,
  validateEntryProtocol, validateProtocolPair
} = require('../lib/protocols');

const customer = { id: 'cus_test', name: '测试客户' };
const relay = { id: 'srv_relay', publicAddress: 'relay.example.com' };
const exit = { id: 'srv_exit', publicAddress: 'exit.example.com' };

test('builds a VLESS Reality to Shadowsocks 2022 chain', () => {
  const credentials = newCredentialSet('vless-reality-vision', 'shadowsocks-2022-aes128');
  const reality = { keyId: 'test-key', serverName: 'www.microsoft.com', destPort: 443 };
  const exitResource = buildExitResource({ resourceId: 'res_exit_123', tagPrefix: 'exit-test', port: 32001, protocol: 'shadowsocks-2022-aes128', credentials, customer });
  const relayResource = buildRelayResource({ resourceId: 'res_relay_123', tagPrefix: 'relay-test', port: 21001, protocol: 'vless-reality-vision', exitProtocol: 'shadowsocks-2022-aes128', exitServer: exit, exitPort: 32001, credentials, customer, reality });
  assert.equal(exitResource.inbounds[0].protocol, 'shadowsocks');
  assert.equal(relayResource.inbounds[0].protocol, 'vless');
  assert.equal(relayResource.outbounds[0].settings.servers[0].address, 'exit.example.com');
  assert.equal(relayResource.inbounds[0].streamSettings.realitySettings.privateKey, '${REALITY_PRIVATE:test-key}');
  const uri = buildClientUri({ protocol: 'vless-reality-vision', relayServer: relay, relayPort: 21001, credentials, reality, publicKey: 'public-key', name: '测试' });
  assert.match(uri, /^vless:\/\//);
  assert.match(uri, /pbk=public-key/);
});

test('rejects unsupported protocol pairs', () => {
  assert.throws(() => validateProtocolPair('nonexistent', 'shadowsocks-2022-aes128'), /Unsupported relay ingress/);
  assert.doesNotThrow(() => validateProtocolPair('anytls', 'vless-tcp'));
});

test('AnyTLS runs in sing-box with a separate TLS entry and VLESS or Shadowsocks exit', () => {
  const { makeClash, makeSingBox, makeSurge } = require('../lib/subscriptions');
  const credentials = newCredentialSet('anytls', 'vless-tcp');
  assert.throws(() => buildDirectResource({ resourceId:'res_any_no_cert', tagPrefix:'any', port:23001,
    protocol:'anytls', credentials, customer }), /证书域名/);
  const relayResource = buildRelayResource({ resourceId:'res_any_relay', tagPrefix:'any', port:23001,
    protocol:'anytls', exitProtocol:'vless-tcp', exitServer:exit, exitPort:32001,
    credentials, customer, tlsDomain:'entry.example.com' });
  assert.equal(relayResource.engine, 'sing-box');
  assert.equal(relayResource.inbounds[0].type, 'anytls');
  assert.equal(relayResource.inbounds[0].tls.certificate_path, '/etc/nexusgate/tls/entry.example.com/fullchain.pem');
  assert.equal(relayResource.outbounds[0].type, 'vless');
  assert.equal(relayResource.outbounds[0].uuid, credentials.clientId);
  const direct = buildDirectResource({ resourceId:'res_any_direct', tagPrefix:'direct-any', port:23002,
    protocol:'anytls', credentials, customer, tlsDomain:'entry.example.com' });
  assert.equal(direct.outbounds[0].type, 'direct');
  assert.equal(direct.routingRules[0].outbound, 'direct-any-direct');
  const uri = buildClientUri({ protocol:'anytls', relayServer:relay, relayPort:23001,
    credentials, tlsDomain:'entry.example.com', name:'AnyTLS 测试' });
  assert.match(uri, /^anytls:\/\//);
  assert.match(makeClash([{ clientUri:uri }]), /type: "anytls"/);
  assert.match(makeSingBox([{ clientUri:uri }]), /"type": "anytls"/);
  assert.equal(makeSurge([{ clientUri:uri }]), null);
});

test('Hysteria 2 reuses Xray route and emits importable Clash and sing-box credentials', () => {
  const { makeClash, makeSingBox } = require('../lib/subscriptions');
  const credentials = newCredentialSet('hysteria2', 'shadowsocks-2022-aes128');
  const node = buildRelayResource({ resourceId:'res_hy2_123', tagPrefix:'hy2-test', port:23000,
    protocol:'hysteria2', exitProtocol:'shadowsocks-2022-aes128', exitServer:exit, exitPort:32001,
    credentials, customer, tlsDomain:'node.example.com' });
  assert.equal(node.inbounds[0].protocol, 'hysteria');
  assert.equal(node.inbounds[0].streamSettings.method, 'hysteria');
  assert.equal(node.inbounds[0].streamSettings.network, 'hysteria');
  assert.equal(node.inbounds[0].settings.clients[0].auth, credentials.relayPassword);
  assert.equal(node.inbounds[0].settings.users[0].auth, credentials.relayPassword);
  assert.equal(node.inbounds[0].streamSettings.tlsSettings.certificates[0].keyFile, '/etc/nexusgate/tls/node.example.com/privkey.pem');
  const uri = buildClientUri({ protocol:'hysteria2', relayServer:relay, relayPort:23000,
    credentials, tlsDomain:'node.example.com', name:'H2 test' });
  assert.match(uri, /^hysteria2:\/\//);
  assert.match(makeClash([{ clientUri:uri }]), /type: "hysteria2"/);
  assert.match(makeSingBox([{ clientUri:uri }]), /"type": "hysteria2"/);
});

test('builds direct Shadowsocks, SOCKS5 and IPv6 client resources', () => {
  const ssCredentials = newCredentialSet('shadowsocks-2022-aes256', null);
  const direct = buildDirectResource({ resourceId: 'res_direct_123', tagPrefix: 'direct-test', port: 24001, protocol: 'shadowsocks-2022-aes256', credentials: ssCredentials, customer, networkMode: 'ipv6' });
  assert.equal(direct.meta.kind, 'direct');
  assert.equal(direct.inbounds[0].listen, '::');
  assert.equal(direct.inbounds[0].settings.method, '2022-blake3-aes-256-gcm');
  const ipv6Relay = { ...relay, publicAddressV6: '2001:db8::10' };
  const uri = buildClientUri({ protocol: 'shadowsocks-2022-aes256', relayServer: ipv6Relay, relayPort: 24001, credentials: ssCredentials, name: 'IPv6 节点', networkMode: 'ipv6' });
  assert.match(uri, /@\[2001:db8::10\]:24001/);
  const socksCredentials = newCredentialSet('socks5-auth', null);
  const socks = buildDirectResource({ resourceId: 'res_direct_456', tagPrefix: 'socks-test', port: 24002, protocol: 'socks5-auth', credentials: socksCredentials, customer, networkMode: 'ipv4' });
  assert.equal(socks.inbounds[0].protocol, 'socks');
  assert.doesNotThrow(() => validateEntryProtocol('socks5-auth'));
});

test('VLESS WebSocket TLS requires a node certificate domain and exports TLS clients', () => {
  const credentials = newCredentialSet('vless-ws-tls', null);
  assert.doesNotThrow(() => validateEntryProtocol('vless-ws-tls'));
  assert.throws(() => buildDirectResource({ resourceId:'res_tls_missing', tagPrefix:'tls', port:24444,
    protocol:'vless-ws-tls', credentials, customer }), /证书域名/);
  const resource = buildDirectResource({ resourceId:'res_tls_123', tagPrefix:'tls', port:24444,
    protocol:'vless-ws-tls', credentials, customer, tlsDomain:'node.example.com' });
  const stream = resource.inbounds[0].streamSettings;
  assert.equal(stream.security, 'tls');
  assert.equal(stream.tlsSettings.certificates[0].certificateFile, '/etc/nexusgate/tls/node.example.com/fullchain.pem');
  const uri = buildClientUri({ protocol:'vless-ws-tls', relayServer:relay, relayPort:24444,
    credentials, tlsDomain:'node.example.com', name:'TLS 节点' });
  assert.match(uri, /security=tls/);
  assert.match(uri, /sni=node.example.com/);
});
