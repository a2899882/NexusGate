'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIdentity, activeClients, observedIps, pruneAccess } = require('../lib/access');

test('subscription identities prefer explicit client headers and count only served requests in the window', () => {
  const first = clientIdentity({ 'x-device-id':'client-a', 'user-agent':'Client/1' }, 'secret');
  const same = clientIdentity({ 'x-device-id':'client-a', 'user-agent':'Client/2' }, 'secret');
  const other = clientIdentity({ 'user-agent':'Client/1' }, 'secret');
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, other.key);
  const now = Date.now();
  const data = { settings:{ observationTtlMinutes:10 }, subscriptionClients:[
    { customerId:'a', clientKey:first.key, lastSeenAt:new Date(now - 1000).toISOString() },
    { customerId:'a', clientKey:other.key, lastSeenAt:new Date(now - 25 * 3600000).toISOString() }
  ], subscriptionAccess:[
    { customerId:'a', status:200, clientKey:first.key, at:new Date(now - 1000).toISOString() },
    { customerId:'a', status:200, clientKey:first.key, at:new Date(now - 2000).toISOString() },
    { customerId:'a', status:429, clientKey:other.key, at:new Date(now - 3000).toISOString() },
    { customerId:'a', status:200, clientKey:other.key, at:new Date(now - 25 * 3600000).toISOString() }
  ], observations:[
    { customerId:'a', ip:'192.0.2.1', lastSeenAt:new Date(now - 1000).toISOString() },
    { customerId:'a', ip:'192.0.2.2', lastSeenAt:new Date(now - 11 * 60000).toISOString() }
  ] };
  assert.deepEqual(activeClients(data, 'a', now), [first.key]);
  assert.equal(observedIps(data, 'a', now).length, 1);
  pruneAccess(data, now);
  assert.equal(data.subscriptionAccess.length, 4);
  assert.equal(data.subscriptionClients.length, 1);
  assert.deepEqual(data.observations.map((item) => item.ip), ['192.0.2.1']);
});
