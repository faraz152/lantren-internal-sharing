'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const seenNonces = new Map();
const CLOCK_SKEW_MS = 2 * 60 * 1000;

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(value).digest('hex');
}

function requestCanonical(method, target, timestamp, nonce, bodyHash) {
  return ['request', method.toUpperCase(), target, timestamp, nonce, bodyHash].join('\n');
}

function responseCanonical(status, method, target, timestamp, nonce, bodyHash) {
  return ['response', String(status), method.toUpperCase(), target, timestamp, nonce, bodyHash].join('\n');
}

function createSignedHeaders(secret, method, target, bodyHash) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = hmac(secret, requestCanonical(method, target, timestamp, nonce, bodyHash));
  return {
    'X-Lantern-Sync-Time': timestamp,
    'X-Lantern-Sync-Nonce': nonce,
    'X-Lantern-Sync-Body': bodyHash,
    'X-Lantern-Sync-Signature': signature
  };
}

function verifySignedRequest(req, secret, target, bodyHash) {
  const timestamp = String(req.headers['x-lantern-sync-time'] || '');
  const nonce = String(req.headers['x-lantern-sync-nonce'] || '');
  const declaredHash = String(req.headers['x-lantern-sync-body'] || '');
  const signature = String(req.headers['x-lantern-sync-signature'] || '');
  const time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(Date.now() - time) > CLOCK_SKEW_MS) return null;
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(declaredHash) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (declaredHash !== bodyHash) return null;
  const expected = Buffer.from(hmac(secret, requestCanonical(req.method, target, timestamp, nonce, bodyHash)), 'hex');
  const provided = Buffer.from(signature, 'hex');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  const now = Date.now();
  for (const [key, expiry] of seenNonces) if (expiry < now) seenNonces.delete(key);
  if (seenNonces.has(nonce)) return null;
  seenNonces.set(nonce, now + CLOCK_SKEW_MS);
  return { timestamp, nonce };
}

function setSyncResponseHeaders(res, secret, status, method, target, auth, bodyHash) {
  res.setHeader('X-Lantern-Sync-Time', auth.timestamp);
  res.setHeader('X-Lantern-Sync-Nonce', auth.nonce);
  res.setHeader('X-Lantern-Sync-Body', bodyHash);
  res.setHeader('X-Lantern-Sync-Signature', hmac(secret, responseCanonical(status, method, target, auth.timestamp, auth.nonce, bodyHash)));
}

function verifySyncResponse(response, secret, method, target, bodyHash) {
  const timestamp = response.headers.get('x-lantern-sync-time') || '';
  const nonce = response.headers.get('x-lantern-sync-nonce') || '';
  const declaredHash = response.headers.get('x-lantern-sync-body') || '';
  const signature = response.headers.get('x-lantern-sync-signature') || '';
  if (!/^\d{10,16}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(declaredHash) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (declaredHash !== bodyHash || Math.abs(Date.now() - Number(timestamp)) > CLOCK_SKEW_MS) return false;
  const expected = Buffer.from(hmac(secret, responseCanonical(response.status, method, target, timestamp, nonce, bodyHash)), 'hex');
  const provided = Buffer.from(signature, 'hex');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function privateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function validatePeerOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error('Enter the other host’s local address.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('Use a private local host address and include its port, usually :8787.');
  }
  if (!privateIpv4(parsed.hostname)) throw new Error('Pairing is limited to a numeric private-network address.');
  if (!parsed.port) throw new Error('Include the host port, usually :8787.');
  return parsed.origin;
}

async function signedRequest(origin, secret, method, pathname, options = {}) {
  const body = options.body || null;
  const bodyHash = options.bodyHash || (body ? hashBuffer(body) : hashBuffer(Buffer.alloc(0)));
  const headers = { ...(options.headers || {}), ...createSignedHeaders(secret, method, pathname, bodyHash) };
  const response = await fetch(origin + pathname, {
    method,
    headers,
    body,
    duplex: options.duplex,
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs || 86_400_000)
  });
  return { response, bodyHash };
}

module.exports = {
  createSignedHeaders,
  hashBuffer,
  hashFile,
  privateIpv4,
  setSyncResponseHeaders,
  signedRequest,
  validatePeerOrigin,
  verifySignedRequest,
  verifySyncResponse
};
