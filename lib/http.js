'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendError(res, status, message, code = 'request_error') {
  sendJson(res, status, { error: code, message });
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function route(pattern, pathname) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:[A-Za-z0-9_]+/g, (part) => {
    names.push(part.slice(1));
    return '([^/]+)';
  })}/?$`);
  const match = pathname.match(regex);
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}

async function serveStatic(publicDir, pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(path.resolve(publicDir) + path.sep) && target !== path.resolve(publicDir, 'index.html')) return false;
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) return false;
    const body = await fs.promises.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'content-length': body.length,
      // The UI is intentionally tiny; never mix an old app.js with a new stylesheet after ng update.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(body);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { sendJson, sendError, readJson, route, serveStatic };
