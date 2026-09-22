'use strict';

const crypto = require('node:crypto');

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifySecret(secret, encoded) {
  try {
    const [kind, salt, expectedHex] = String(encoded).split(':');
    if (kind !== 'scrypt' || !salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(secret), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const at = part.indexOf('=');
    if (at < 0) return ['', ''];
    return [decodeURIComponent(part.slice(0, at).trim()), decodeURIComponent(part.slice(at + 1).trim())];
  }).filter(([key]) => key));
}

class SessionManager {
  constructor(hours = 12) {
    this.ttlMs = hours * 60 * 60 * 1000;
    this.sessions = new Map();
  }

  create(userId) {
    const id = randomToken(32);
    const session = { id, userId, csrf: randomToken(24), expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(id, session);
    return session;
  }

  get(request) {
    const id = parseCookies(request.headers.cookie).ng_session;
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(id);
      return null;
    }
    return session;
  }

  delete(request) {
    const id = parseCookies(request.headers.cookie).ng_session;
    if (id) this.sessions.delete(id);
  }

  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

module.exports = { hashSecret, verifySecret, randomToken, parseCookies, SessionManager };
