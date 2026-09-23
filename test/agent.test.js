'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseX25519 } = require('../agent/agent');
const { redactSecrets } = require('../lib/redact');

test('parses both current and older Xray x25519 output without including private keys in errors', () => {
  const current = parseX25519('PrivateKey: current_private\nPassword (PublicKey): current_public\nHash32: ignored');
  assert.deepEqual(current, { privateKey:'current_private', publicKey:'current_public' });
  const older = parseX25519('Private key: older_private\nPublic key: older_public');
  assert.equal(older.publicKey, 'older_public');
  assert.throws(() => parseX25519('PrivateKey: very_secret\nUnknown: broken'), (error) => !error.message.includes('very_secret'));
  assert.equal(redactSecrets('Unable to parse: PrivateKey: very_secret Password (PublicKey): public'),
    'Unable to parse: PrivateKey: [REDACTED] Password (PublicKey): public');
});

test('Xray candidate configuration has a JSON extension at validation time', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-agent-test-'));
  try {
    const fakeXray = path.join(temp, 'fake-xray');
    const configDir = path.join(temp, 'xray');
    fs.mkdirSync(path.join(configDir, 'resources'), { recursive:true });
    fs.writeFileSync(fakeXray, '#!/bin/sh\nprintf "%s\\n" "$4" > "' + path.join(temp, 'argument') + '"\nexit 41\n', { mode:0o755 });
    // Module paths are read at import time; test the real activation logic in a child.
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../agent/agent.js'))}).activateConfig()`], {
      env:{ ...process.env, NG_CONFIG_DIR:configDir, NG_XRAY_BIN:fakeXray }, encoding:'utf8'
    });
    assert.notEqual(result.status, 0);
    const candidate = fs.readFileSync(path.join(temp, 'argument'), 'utf8').trim();
    assert.equal(candidate, path.join(configDir, 'config.json.candidate.json'));
    assert.equal(JSON.parse(fs.readFileSync(candidate, 'utf8')).inbounds[0].tag, 'api-in');
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
});
