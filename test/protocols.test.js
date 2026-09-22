'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newCredentialSet, buildExitResource, buildRelayResource, buildClientUri,
  validateProtocolPair
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
  assert.throws(() => validateProtocolPair('hysteria2', 'shadowsocks-2022-aes128'), /Unsupported relay ingress/);
});
