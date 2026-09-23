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
