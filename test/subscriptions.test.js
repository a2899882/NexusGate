'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { entries, formatSubscription, makeSingBox, clashProxy } = require('../lib/subscriptions');

test('formats active Reality and Shadowsocks entries, excluding exit and incomplete resources', () => {
  const customer = { id:'cus-1' };
  const reality = 'vless://00000000-0000-4000-8000-000000000001@[2001:db8::1]:443?encryption=none&security=reality&sni=www.tesla.com&fp=chrome&pbk=public-key&sid=abcdef&type=tcp&flow=xtls-rprx-vision#Reality';
  const ss = `ss://${Buffer.from('2022-blake3-aes-128-gcm:secret').toString('base64url')}@example.com:1443#SS`;
  const data = { deployments:[
    { customerId:customer.id, role:'relay', status:'active', clientUri:reality },
    { customerId:customer.id, role:'direct', status:'active', clientUri:ss },
    { customerId:customer.id, role:'exit', status:'active', clientUri:'should-not-export' },
    { customerId:customer.id, role:'relay', status:'failed', clientUri:'should-not-export' },
    { customerId:customer.id, role:'relay', status:'active', archived:true, clientUri:'should-not-export' }
  ] };
  assert.equal(entries(data, customer.id).length, 2);
  const proxy = clashProxy(data.deployments[0]);
  assert.equal(proxy.server, '2001:db8::1');
  assert.equal(proxy['reality-opts']['public-key'], 'public-key');
  const config = JSON.parse(makeSingBox(entries(data, customer.id)));
  assert.equal(config.outbounds[1].tls.reality.short_id, 'abcdef');
  assert.equal(config.outbounds[2].method, '2022-blake3-aes-128-gcm');
  assert.equal(formatSubscription(data, customer, 'auto', 'Mihomo').contentType, 'text/yaml; charset=utf-8');
  assert.equal(formatSubscription(data, customer, 'auto', 'Other').contentType, 'text/plain; charset=utf-8');
  assert.doesNotMatch(formatSubscription(data, customer, 'raw').body, /should-not-export/);
});

test('TLS WebSocket exports valid Mihomo and sing-box TLS settings', () => {
  const customer = { id:'cus-tls' };
  const data = { deployments:[{ customerId:customer.id, role:'direct', status:'active', clientUri:
    'vless://00000000-0000-4000-8000-000000000001@node.example.com:24444?encryption=none&security=tls&sni=node.example.com&type=ws&path=%2Ftest#TLS' }] };
  const proxy = clashProxy(data.deployments[0]);
  assert.equal(proxy.tls, true);
  assert.equal(proxy.servername, 'node.example.com');
  assert.equal(proxy['reality-opts'], undefined);
  const outbound = JSON.parse(makeSingBox(entries(data, customer.id))).outbounds[1];
  assert.equal(outbound.tls.enabled, true);
  assert.equal(outbound.tls.reality, undefined);
  assert.equal(formatSubscription(data, customer, 'surge'), null);
});

test('adding HY2 to an AnyTLS subscription keeps ALPN on one valid YAML line and route names clean', () => {
  const data = { chains:[{ id:'any-route', name:'US-rak-CN2' }, { id:'hy-route', name:'hy2 cn2' }], deployments:[
    { chainId:'any-route', customerId:'55', role:'direct', status:'active',
      clientUri:'anytls://secret@entry.example.com:48924?sni=entry.example.com#US-rak-CN2%20%C2%B7%20rak%20cn2%3A48924' },
    { chainId:'hy-route', customerId:'55', role:'direct', status:'active',
      clientUri:'hysteria2://secret@entry.example.com:40003?sni=entry.example.com&alpn=h3#hy2%20cn2%20%C2%B7%20rak%20cn2%3A40003' }
  ] };
  const customer = { id:'55' };
  const raw = formatSubscription(data, customer, 'raw').body;
  assert.match(raw, /#US-rak-CN2\n/);
  assert.match(raw, /#hy2%20cn2\n/);
  assert.doesNotMatch(raw, /rak%20cn2%3A/);
  const yaml = formatSubscription(data, customer, 'clash').body;
  assert.match(yaml, /^    alpn: \["h3"\]$/m);
  assert.match(yaml, /^proxy-groups:$/m);
  assert.doesNotMatch(yaml, /^"h3"$/m);
  assert.match(yaml, /^  - name: "US-rak-CN2"$/m);
  assert.match(yaml, /^  - name: "hy2 cn2"$/m);
});

test('legacy VMess subscriptions also use the route name instead of a base64 label', () => {
  const payload = { v:'2', ps:'old · entry:20000', add:'entry.example.com', port:'20000', id:'uuid', path:'/ws' };
  const data = { chains:[{ id:'vmess-route', name:'VMess US' }], deployments:[{
    chainId:'vmess-route', customerId:'vmess-customer', role:'direct', status:'active',
    clientUri:`vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`
  }] };
  const exported = entries(data, 'vmess-customer');
  assert.equal(clashProxy(exported[0]).name, 'VMess US');
  assert.match(formatSubscription(data, { id:'vmess-customer' }, 'clash').body, /^  - name: "VMess US"$/m);
});

test('Clash aliases only route names that collide with built-in groups or policies', () => {
  const data = { chains:[{ id:'route-a', name:'节点选择' }, { id:'route-b', name:'DIRECT' }], deployments:[
    { chainId:'route-a', customerId:'one', role:'direct', status:'active', clientUri:'anytls://password@entry.example.com:443?sni=entry.example.com#old' },
    { chainId:'route-b', customerId:'one', role:'direct', status:'active', clientUri:'hysteria2://password@entry.example.com:444?sni=entry.example.com#old' }
  ] };
  const yaml = formatSubscription(data, { id:'one' }, 'clash-smart').body;
  assert.match(yaml, /^  - name: "节点选择 \(节点\)"$/m);
  assert.match(yaml, /^  - name: "DIRECT \(节点\)"$/m);
  assert.match(yaml, /^      - "节点选择 \(节点\)"$/m);
  assert.match(formatSubscription(data, { id:'one' }, 'raw').body, /#%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9/);
});
