'use strict';

const crypto = require('node:crypto');

const CLIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function clientIdentity(headers, secret) {
  const declared = String(headers['x-device-id'] || headers['x-client-id'] || '').trim().slice(0, 128);
  const userAgent = String(headers['user-agent'] || '').trim().slice(0, 200);
  const kind = declared ? 'header' : userAgent ? 'user-agent' : 'unknown';
  const identity = declared || userAgent || 'unknown';
  return {
    userAgent,
    kind,
    key: crypto.createHmac('sha256', secret).update(`${kind}:${identity}`).digest('hex')
  };
}

function activeClients(data, customerId, now = Date.now()) {
  const cutoff = now - CLIENT_WINDOW_MS;
  return data.subscriptionClients.filter((item) => item.customerId === customerId && Date.parse(item.lastSeenAt) > cutoff)
    .map((item) => item.clientKey);
}

function observedIps(data, customerId, now = Date.now()) {
  const cutoff = now - (data.settings.observationTtlMinutes || 10) * 60000;
  return data.observations.filter((item) => item.customerId === customerId && Date.parse(item.lastSeenAt) > cutoff);
}

function pruneAccess(data, now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS;
  data.subscriptionAccess = data.subscriptionAccess.filter((item) => Date.parse(item.at) > cutoff).slice(-10000);
  data.subscriptionClients = data.subscriptionClients.filter((item) => Date.parse(item.lastSeenAt) > now - CLIENT_WINDOW_MS);
  const observationCutoff = now - (data.settings.observationTtlMinutes || 10) * 60000;
  data.observations = data.observations.filter((item) => Date.parse(item.lastSeenAt) > observationCutoff);
}

module.exports = { CLIENT_WINDOW_MS, clientIdentity, activeClients, observedIps, pruneAccess };
