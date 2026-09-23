'use strict';

// Xray has printed Reality private keys under both "Private key" and
// "PrivateKey". Never retain either form in job history or API responses.
function redactSecrets(value) {
  return String(value || '')
    .replace(/\bPrivate\s*Key\s*:\s*[^\s,;]+/gi, 'PrivateKey: [REDACTED]')
    .replace(/\bNG_AGENT_KEY\s*=\s*[^\s,;]+/gi, 'NG_AGENT_KEY=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

module.exports = { redactSecrets };
