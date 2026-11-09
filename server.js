'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const util = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { checkPassphrase, createEncryptedBackup, decryptBackupFile, extractAndValidateTar } = require('./host-backup');
const {
  hashBuffer, hashFile, privateIpv4, setSyncResponseHeaders, signedRequest,
  validatePeerOrigin, verifySignedRequest, verifySyncResponse
} = require('./lan-sync-protocol');

const ROOT = __dirname;
const DATA_ROOT = path.resolve(process.env.SHARE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), '.lantern-share'));
const FILES_DIR = path.join(DATA_ROOT, 'files');
const INDEX_PATH = path.join(DATA_ROOT, 'items.json');
const PIN_PATH = path.join(DATA_ROOT, 'join-pin.txt');
const LOG_PATH = path.join(DATA_ROOT, 'server.log');
const HOST_STATE_PATH = path.join(DATA_ROOT, 'host-transfer.state');
const SYNC_STATE_PATH = path.join(DATA_ROOT, 'host-sync.json');
const TOMBSTONES_PATH = path.join(DATA_ROOT, 'item-tombstones.json');
const PORT = Number(process.env.PORT || 8787);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MEDIA_MIME_BY_EXTENSION = Object.freeze({
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.webp': 'image/webp',
  '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.amr': 'audio/amr',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mid': 'audio/midi',
  '.midi': 'audio/midi', '.mp3': 'audio/mpeg', '.oga': 'audio/ogg', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.wave': 'audio/wav', '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma', '.3gp': 'audio/3gpp'
});
const BRAND_ASSETS = Object.freeze({
  '/brand/lantern-mark.svg': ['brand/lantern-mark.svg', 'image/svg+xml; charset=utf-8'],
  '/brand/lantern-lockup.svg': ['brand/lantern-lockup.svg', 'image/svg+xml; charset=utf-8'],
  '/brand/lantern-mark.png': ['brand/lantern-mark.png', 'image/png'],
  '/brand/lantern-mark-192.png': ['brand/lantern-mark-192.png', 'image/png']
});
const WEB_APP_ASSETS = Object.freeze({
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/service-worker.js': ['service-worker.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8']
});
const sessions = new Map();
const loginAttempts = new Map();
const backupTickets = new Map();
const syncInvites = new Map();
let items = [];
let tombstones = [];
let syncState = null;
let saveQueue = Promise.resolve();
let hostFrozen = false;
let hostBusy = false;
let activeMutations = 0;
let mutationDrainWaiters = [];
let syncCycleRunning = false;
let lastSyncAt = null;
let lastSyncError = null;

let pin = process.env.SHARE_PIN ? process.env.SHARE_PIN.trim() : '';
const useHttps = Boolean(process.env.HTTPS_CERT && process.env.HTTPS_KEY);
const protocol = useHttps ? 'https' : 'http';

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0) >>> 0;
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

function getLanInterfaces() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || !isPrivateIPv4(address.address)) continue;
      const mask = ipv4Number(address.netmask);
      found.push({ name, address: address.address, mask, network: (ipv4Number(address.address) & mask) >>> 0 });
    }
  }
  return found;
}

function normalizedAddress(address) {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isAllowedPeer(address, lanInterfaces) {
  const peer = normalizedAddress(address);
  if (peer === '127.0.0.1' || peer === '::1') return true;
  if (!isPrivateIPv4(peer)) return false;
  const number = ipv4Number(peer);
  return lanInterfaces.some((item) => ((number & item.mask) >>> 0) === item.network);
}

function isHostPeer(address, lanInterfaces) {
  const peer = normalizedAddress(address);
  return peer === '127.0.0.1' || peer === '::1' || lanInterfaces.some((item) => item.address === peer);
}

function isAllowedHost(hostHeader, lanInterfaces) {
  const host = String(hostHeader || '').toLowerCase().replace(/^\[|\]$/g, '').split(':')[0].replace(/\.$/, '');
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (lanInterfaces.some((item) => item.address === host)) return true;
  return localHostAliases().has(host);
}

function localHostAliases() {
  const configured = String(process.env.SHARE_LOCAL_NAME || os.hostname()).trim().toLowerCase().replace(/\.$/, '');
  const aliases = new Set();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(configured) || configured.split('.').some((part) => !part || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) return aliases;
  aliases.add(configured);
  if (configured.endsWith('.local')) aliases.add(configured.slice(0, -6));
  else aliases.add(configured + '.local');
  return aliases;
}

function hostAddresses(lanInterfaces) {
  const addresses = lanInterfaces.map((item) => protocol + '://' + item.address + ':' + PORT);
  for (const alias of localHostAliases()) {
    const name = alias.includes('.') ? alias : alias + '.local';
    addresses.push(protocol + '://' + name + ':' + PORT);
  }
  return [...new Set(addresses)];
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request was interrupted.')));
  });
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === protocol + ':' && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)lantern_session=([a-f0-9]+)/);
  if (!match) return null;
  const expires = sessions.get(match[1]);
  if (!expires || expires < Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  sessions.set(match[1], Date.now() + SESSION_TTL);
  return match[1];
}

function decodeBackupPassphraseHeader(value) {
  const encoded = String(value || '');
  if (!/^[A-Za-z0-9_-]{16,1400}$/.test(encoded)) throw new Error('Enter the backup passphrase.');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('The backup passphrase encoding is invalid.');
  const passphrase = bytes.toString('utf8');
  if (!Buffer.from(passphrase, 'utf8').equals(bytes)) throw new Error('The backup passphrase encoding is invalid.');
  return passphrase;
}

function jsonCookie(value) {
  return 'lantern_session=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL / 1000) + (useHttps ? '; Secure' : '');
}

function safeFilename(input) {
  let value = path.basename(String(input || 'file').replace(/\\/g, '/'));
  value = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim();
  if (!value || value === '.' || value === '..') value = 'file';
  return Array.from(value).slice(0, 240).join('');
}

function safeMime(input) {
  const value = String(input || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)) return 'application/octet-stream';
  return value;
}

function inferMediaMime(name) {
  return MEDIA_MIME_BY_EXTENSION[path.extname(String(name || '')).toLowerCase()] || null;
}

function persistItems() {
  const snapshot = JSON.stringify(items, null, 2);
  const write = async () => {
    const temporary = INDEX_PATH + '.tmp';
    await fs.promises.writeFile(temporary, snapshot, 'utf8');
    await fs.promises.rename(temporary, INDEX_PATH);
  };
  saveQueue = saveQueue.then(write, write);
  return saveQueue;
}

async function loadItems() {
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.promises.readFile(INDEX_PATH, 'utf8'));
    if (Array.isArray(saved)) {
      items = saved.filter((item) => item && /^[a-f0-9-]{36}$/.test(item.id) && typeof item.name === 'string' && (item.kind === 'text' || (item.kind === 'file' && item.storageName === item.id + '.blob')) && (item.kind !== 'text' || typeof item.text === 'string'));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read the share index:', error.message);
  }
  const known = new Set(items.filter((item) => item.kind === 'file').map((item) => item.id + item.storageName));
  for (const item of items) {
    if (item.kind === 'file' && (!item.storageName || !known.has(item.id + item.storageName))) continue;
    if (item.kind === 'file') {
      try { await fs.promises.access(path.join(FILES_DIR, item.storageName)); }
      catch { items = items.filter((candidate) => candidate.id !== item.id); }
    }
  }
  await persistItems();
}

async function loadPin() {
  if (pin) {
    if (!/^\d{6}$/.test(pin)) throw new Error('SHARE_PIN must contain exactly six digits.');
    await fs.promises.writeFile(PIN_PATH, pin + '\n', { encoding: 'utf8', mode: 0o600 });
    return;
  }
  try {
    pin = (await fs.promises.readFile(PIN_PATH, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    pin = String(crypto.randomInt(100000, 1000000));
    try { await fs.promises.writeFile(PIN_PATH, pin + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      pin = (await fs.promises.readFile(PIN_PATH, 'utf8')).trim();
    }
  }
  if (!/^\d{6}$/.test(pin)) throw new Error('The saved join PIN is invalid. Remove join-pin.txt to generate a new PIN.');
}

async function loadHostState() {
  try {
    const state = JSON.parse(await fs.promises.readFile(HOST_STATE_PATH, 'utf8'));
    hostFrozen = Boolean(state && state.version === 1 && state.frozen === true);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read host transfer state:', error.message);
    hostFrozen = false;
  }
}

async function persistHostState(frozen) {
  if (!frozen) {
    await fs.promises.rm(HOST_STATE_PATH, { force: true });
    return;
  }
  const temporary = HOST_STATE_PATH + '.tmp';
  await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, frozen: true }) + '\n', { mode: 0o600 });
  await fs.promises.rename(temporary, HOST_STATE_PATH);
}

async function persistJsonFile(filePath, value) {
  const temporary = filePath + '.tmp';
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.promises.rename(temporary, filePath);
}

async function loadSyncFiles() {
  try {
    const saved = JSON.parse(await fs.promises.readFile(SYNC_STATE_PATH, 'utf8'));
    if (saved && saved.version === 1 && /^[a-f0-9-]{36}$/.test(saved.roomId) && /^[a-f0-9-]{36}$/.test(saved.nodeId) && /^[A-Za-z0-9_-]{40,60}$/.test(saved.secret) && Array.isArray(saved.peers)) {
      syncState = { version: 1, roomId: saved.roomId, nodeId: saved.nodeId, secret: saved.secret, peers: [] };
      mergeSyncPeers(saved.peers);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('Could not read host sync state:', error.message); }
  try {
    const saved = JSON.parse(await fs.promises.readFile(TOMBSTONES_PATH, 'utf8'));
    if (Array.isArray(saved)) tombstones = saved.filter((entry) => entry && /^[a-f0-9-]{36}$/.test(entry.id) && typeof entry.deletedAt === 'string' && Number.isFinite(Date.parse(entry.deletedAt)));
  } catch (error) { if (error.code !== 'ENOENT') console.error('Could not read item deletion history:', error.message); }
}

async function ensureSyncIdentity() {
  if (!syncState) {
    syncState = {
      version: 1,
      roomId: crypto.randomUUID(),
      nodeId: crypto.randomUUID(),
      secret: crypto.randomBytes(32).toString('base64url'),
      peers: []
    };
    await persistJsonFile(SYNC_STATE_PATH, syncState);
  }
  return syncState;
}

async function persistSyncState() {
  if (syncState) await persistJsonFile(SYNC_STATE_PATH, syncState);
}

function mergeSyncPeers(incoming) {
  if (!syncState || !Array.isArray(incoming)) return false;
  let changed = false;
  const byNode = new Map(syncState.peers.map((peer) => [peer.nodeId, peer]));
  for (const candidate of incoming) {
    if (!candidate || !/^[a-f0-9-]{36}$/.test(candidate.nodeId) || candidate.nodeId === syncState.nodeId) continue;
    let origin;
    try { origin = validatePeerOrigin(candidate.url); } catch { continue; }
    const previous = byNode.get(candidate.nodeId);
    if (previous) {
      if (previous.url !== origin) { previous.url = origin; changed = true; }
      continue;
    }
    byNode.set(candidate.nodeId, { nodeId: candidate.nodeId, url: origin, lastSyncAt: null, lastError: '' });
    changed = true;
  }
  if (changed) syncState.peers = [...byNode.values()];
  return changed;
}

function hostAddress(lanInterfaces) {
  const item = lanInterfaces[0];
  return item ? protocol + '://' + item.address + ':' + PORT : '';
}

function hostAddressForPeer(peerOrigin, lanInterfaces) {
  const remoteAddress = new URL(peerOrigin).hostname;
  const interfaceForPeer = lanInterfaces.find((item) => isAllowedPeer(remoteAddress, [item])) || lanInterfaces[0];
  return interfaceForPeer ? protocol + '://' + interfaceForPeer.address + ':' + PORT : '';
}

function normalizedPeerAddress(address) {
  return normalizedAddress(address).replace(/^::ffff:/, '');
}

function currentSyncPeerSummary() {
  return syncState ? syncState.peers.map((peer) => ({ nodeId: peer.nodeId, url: peer.url, lastSyncAt: peer.lastSyncAt || null, lastError: peer.lastError || '' })) : [];
}

async function persistTombstones() {
  await persistJsonFile(TOMBSTONES_PATH, tombstones);
}

async function applyTombstones(incoming) {
  if (!Array.isArray(incoming)) throw Object.assign(new Error('The sync deletion list is invalid.'), { status: 400 });
  if (incoming.length > 20000) throw Object.assign(new Error('The sync deletion list is too large.'), { status: 413 });
  const byId = new Map(tombstones.map((entry) => [entry.id, entry]));
  let changed = false;
  for (const value of incoming) {
    if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.deletedAt !== 'string' || !Number.isFinite(Date.parse(value.deletedAt))) {
      throw Object.assign(new Error('The sync deletion list contains invalid data.'), { status: 400 });
    }
    const prior = byId.get(value.id);
    if (!prior || Date.parse(value.deletedAt) > Date.parse(prior.deletedAt)) {
      byId.set(value.id, { id: value.id, deletedAt: value.deletedAt });
      changed = true;
    }
  }
  if (!changed) return false;
  tombstones = [...byId.values()];
  const deletedIds = new Set(tombstones.map((entry) => entry.id));
  const removed = items.filter((item) => deletedIds.has(item.id));
  if (removed.length) {
    items = items.filter((item) => !deletedIds.has(item.id));
    for (const item of removed) if (item.kind === 'file') await fs.promises.rm(path.join(FILES_DIR, item.storageName), { force: true });
    await persistItems();
  }
  await persistTombstones();
  return true;
}

function validateSyncItem(value) {
  if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw Object.assign(new Error('The sync item is invalid.'), { status: 400 });
  const name = safeFilename(value.name);
  if (value.kind === 'text') {
    if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > MAX_TEXT_BYTES || !Number.isSafeInteger(value.size) || Buffer.byteLength(value.text) !== value.size) throw Object.assign(new Error('The sync text is invalid.'), { status: 400 });
    return { id: value.id, kind: 'text', name, text: value.text, size: value.size, createdAt: value.createdAt };
  }
  if (value.kind === 'file') {
    if (value.storageName !== value.id + '.blob' || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mime !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mime) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Object.assign(new Error('The sync file metadata is invalid.'), { status: 400 });
    return { id: value.id, kind: 'file', name, mime: value.mime, size: value.size, storageName: value.storageName, sha256: value.sha256, createdAt: value.createdAt };
  }
  throw Object.assign(new Error('The sync item kind is not supported.'), { status: 400 });
}

async function syncSnapshot() {
  const state = await ensureSyncIdentity();
  let changed = false;
  const snapshotItems = [];
  for (const item of items) {
    if (item.kind === 'text') snapshotItems.push({ ...item });
    else {
      const filePath = path.join(FILES_DIR, item.storageName);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || stat.size !== item.size) throw new Error('A shared file changed or is missing: ' + item.name);
      if (!item.sha256) {
        const actual = await hashFile(filePath);
        if (actual.size !== item.size) throw new Error('A shared file changed or is missing: ' + item.name);
        item.sha256 = actual.sha256;
        changed = true;
      }
      snapshotItems.push({ ...item });
    }
  }
  if (changed) await persistItems();
  return { roomId: state.roomId, nodeId: state.nodeId, pin, peers: currentSyncPeerSummary(), items: snapshotItems, tombstones: [...tombstones] };
}

function signedSyncJson(res, status, body, method, target, auth) {
  const data = Buffer.from(JSON.stringify(body));
  const digest = hashBuffer(data);
  setSyncResponseHeaders(res, syncState.secret, status, method, target, auth, digest);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

function verifyPeerAuth(req, target, bodyHash) {
  if (!syncState) return null;
  return verifySignedRequest(req, syncState.secret, target, bodyHash);
}

async function requestPeerJson(peer, method, pathname, value) {
  const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
  const { response } = await signedRequest(peer.url, syncState.secret, method, pathname, {
    body,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    timeoutMs: 86_400_000
  });
  const data = Buffer.from(await response.arrayBuffer());
  const digest = hashBuffer(data);
  if (!verifySyncResponse(response, syncState.secret, method, pathname, digest)) throw new Error('A paired host returned an invalid sync signature.');
  let result = {};
  try { result = JSON.parse(data.toString('utf8')); } catch { throw new Error('A paired host returned an invalid sync response.'); }
  if (!response.ok) throw new Error(result.error || 'The paired host rejected synchronization.');
  return result;
}

async function receiveSyncText(value) {
  const item = validateSyncItem(value);
  if (item.kind !== 'text') throw Object.assign(new Error('Only text items can use this sync endpoint.'), { status: 400 });
  if (tombstones.some((entry) => entry.id === item.id)) return false;
  const existing = items.find((entry) => entry.id === item.id);
  if (existing) return false;
  items.unshift(item);
  await persistItems();
  return true;
}

async function receiveSyncFile(req, res, url, auth, target) {
  let meta;
  try {
    const value = url.searchParams.get('item') || '';
    if (!/^[A-Za-z0-9_-]{20,1800}$/.test(value)) throw new Error('Missing file metadata.');
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Invalid file metadata.');
    meta = validateSyncItem(JSON.parse(bytes.toString('utf8')));
  } catch (error) { signedSyncJson(res, 400, { error: error.message }, req.method, target, auth); return; }
  if (meta.kind !== 'file' || req.headers['x-lantern-sync-body'] !== meta.sha256) {
    signedSyncJson(res, 400, { error: 'The file metadata does not match its content hash.' }, req.method, target, auth);
    req.resume();
    return;
  }
  if (hostFrozen || hostBusy) {
    signedSyncJson(res, 423, { error: 'This host is paused or busy; it will sync again later.' }, req.method, target, auth);
    req.resume();
    return;
  }
  if (tombstones.some((entry) => entry.id === meta.id) || items.some((item) => item.id === meta.id)) {
    signedSyncJson(res, 200, { ok: true, skipped: true }, req.method, target, auth);
    req.resume();
    return;
  }
  activeMutations++;
  const temporary = path.join(FILES_DIR, '.sync-' + crypto.randomUUID() + '.tmp');
  const destination = path.join(FILES_DIR, meta.storageName);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const counter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  try {
    await pipeline(req, counter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (size !== meta.size || hash.digest('hex') !== meta.sha256) throw new Error('A synced file failed its size or integrity check.');
    await fs.promises.rename(temporary, destination);
    items.unshift(meta);
    try { await persistItems(); }
    catch (error) { items = items.filter((item) => item.id !== meta.id); await fs.promises.rm(destination, { force: true }); throw error; }
    signedSyncJson(res, 201, { ok: true }, req.method, target, auth);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    signedSyncJson(res, 400, { error: error.message || 'The synced file could not be stored.' }, req.method, target, auth);
  } finally { endMutation(); }
}

async function handleSyncPeerRequest(req, res, url) {
  const target = req.url;
  if (!syncState) { sendJson(res, 403, { error: 'This host has not been paired to a sharing room.' }); return true; }
  if (req.method === 'GET' && url.pathname === '/api/sync/state') {
    const emptyHash = hashBuffer(Buffer.alloc(0));
    const auth = verifyPeerAuth(req, target, emptyHash);
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); return true; }
    try { signedSyncJson(res, 200, await syncSnapshot(), req.method, target, auth); }
    catch (error) { signedSyncJson(res, 500, { error: 'Could not prepare the host sync state: ' + error.message }, req.method, target, auth); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/status') {
    let body;
    try { body = await readBody(req, 2048); }
    catch (error) { sendJson(res, error.status || 400, { error: error.message }); return true; }
    const digest = hashBuffer(body);
    const auth = verifyPeerAuth(req, target, digest);
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); return true; }
    let value;
    try { value = JSON.parse(body.toString('utf8')); }
    catch { signedSyncJson(res, 400, { error: 'The sync status is invalid.' }, req.method, target, auth); return true; }
    const peer = syncState.peers.find((entry) => entry.nodeId === value.nodeId);
    if (!peer || typeof value.syncedAt !== 'string' || !Number.isFinite(Date.parse(value.syncedAt))) {
      signedSyncJson(res, 400, { error: 'The sync status does not match a paired host.' }, req.method, target, auth);
      return true;
    }
    mergeSyncPeers(value.peers);
    peer.lastSyncAt = value.syncedAt;
    peer.lastError = '';
    await persistSyncState();
    signedSyncJson(res, 200, { ok: true }, req.method, target, auth);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/items') {
    let body;
    try { body = await readBody(req, MAX_TEXT_BYTES + 4096); }
    catch (error) { sendJson(res, error.status || 400, { error: error.message }); return true; }
    const digest = hashBuffer(body);
    const auth = verifyPeerAuth(req, target, digest);
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); return true; }
    if (hostFrozen || hostBusy) { signedSyncJson(res, 423, { error: 'This host is paused or busy; it will sync again later.' }, req.method, target, auth); return true; }
    let changed = false;
    try {
      const value = JSON.parse(body.toString('utf8'));
      if (!Array.isArray(value.items) || value.items.length > 100) throw new Error('The sync item batch is invalid.');
      activeMutations++;
      for (const item of value.items) changed = await receiveSyncText(item) || changed;
      if (changed) await persistItems();
      signedSyncJson(res, 200, { ok: true }, req.method, target, auth);
    } catch (error) { signedSyncJson(res, error.status || 400, { error: error.message || 'Invalid sync items.' }, req.method, target, auth); }
    finally { if (activeMutations > 0) endMutation(); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/tombstones') {
    let body;
    try { body = await readBody(req, 2 * 1024 * 1024); }
    catch (error) { sendJson(res, error.status || 400, { error: error.message }); return true; }
    const digest = hashBuffer(body);
    const auth = verifyPeerAuth(req, target, digest);
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); return true; }
    if (hostFrozen || hostBusy) { signedSyncJson(res, 423, { error: 'This host is paused or busy; it will sync again later.' }, req.method, target, auth); return true; }
    try {
      const value = JSON.parse(body.toString('utf8'));
      activeMutations++;
      await applyTombstones(value.tombstones);
      signedSyncJson(res, 200, { ok: true }, req.method, target, auth);
    } catch (error) { signedSyncJson(res, error.status || 400, { error: error.message || 'Invalid sync deletions.' }, req.method, target, auth); }
    finally { if (activeMutations > 0) endMutation(); }
    return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/sync\/files\/([a-f0-9-]{36})$/);
  if (fileMatch && req.method === 'GET') {
    const auth = verifyPeerAuth(req, target, hashBuffer(Buffer.alloc(0)));
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); return true; }
    const item = items.find((candidate) => candidate.id === fileMatch[1] && candidate.kind === 'file');
    if (!item || tombstones.some((entry) => entry.id === item.id)) { signedSyncJson(res, 404, { error: 'File not found.' }, req.method, target, auth); return true; }
    try {
      const filePath = path.join(FILES_DIR, item.storageName);
      const actual = await hashFile(filePath);
      if (actual.size !== item.size) throw new Error('File size changed.');
      item.sha256 = actual.sha256;
      const bodyHash = actual.sha256;
      setSyncResponseHeaders(res, syncState.secret, 200, req.method, target, auth, bodyHash);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size, 'X-Lantern-Item': Buffer.from(JSON.stringify(item)).toString('base64url'), 'Cache-Control': 'no-store' });
      await pipeline(fs.createReadStream(filePath), res);
    } catch { signedSyncJson(res, 404, { error: 'The shared file is unavailable.' }, req.method, target, auth); }
    return true;
  }
  if (fileMatch && req.method === 'POST') {
    const bodyHash = String(req.headers['x-lantern-sync-body'] || '');
    const auth = verifyPeerAuth(req, target, bodyHash);
    if (!auth) { sendJson(res, 401, { error: 'Host sync authentication failed.' }); req.resume(); return true; }
    await receiveSyncFile(req, res, url, auth, target);
    return true;
  }
  sendJson(res, 404, { error: 'Sync endpoint not found.' });
  return true;
}

async function pullSyncFile(peer, remoteItem) {
  const pathname = '/api/sync/files/' + encodeURIComponent(remoteItem.id);
  const { response } = await signedRequest(peer.url, syncState.secret, 'GET', pathname);
  if (!response.ok) {
    const raw = Buffer.from(await response.arrayBuffer());
    const digest = hashBuffer(raw);
    if (verifySyncResponse(response, syncState.secret, 'GET', pathname, digest)) {
      try { throw new Error(JSON.parse(raw.toString('utf8')).error || 'Could not download a paired file.'); } catch (error) { if (error instanceof SyntaxError) throw new Error('Could not download a paired file.'); else throw error; }
    }
    throw new Error('The paired host returned an invalid file response.');
  }
  const declaredHash = response.headers.get('x-lantern-sync-body') || '';
  if (declaredHash !== remoteItem.sha256 || !verifySyncResponse(response, syncState.secret, 'GET', pathname, declaredHash)) throw new Error('The paired file failed its signature check.');
  if (hostFrozen || hostBusy || tombstones.some((entry) => entry.id === remoteItem.id)) { await response.body?.cancel(); return false; }
  const temporary = path.join(FILES_DIR, '.sync-' + crypto.randomUUID() + '.tmp');
  const destination = path.join(FILES_DIR, remoteItem.id + '.blob');
  const hash = crypto.createHash('sha256');
  let size = 0;
  const counter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  activeMutations++;
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (size !== remoteItem.size || hash.digest('hex') !== remoteItem.sha256) throw new Error('A downloaded file failed its integrity check.');
    if (items.some((item) => item.id === remoteItem.id)) { await fs.promises.rm(temporary, { force: true }); return false; }
    await fs.promises.rename(temporary, destination);
    items.unshift(validateSyncItem(remoteItem));
    await persistItems();
    return true;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally { endMutation(); }
}

async function pushSyncFile(peer, item) {
  const filePath = path.join(FILES_DIR, item.storageName);
  const actual = await hashFile(filePath);
  if (actual.size !== item.size || actual.sha256 !== item.sha256) throw new Error('A local file failed its integrity check: ' + item.name);
  const metadata = Buffer.from(JSON.stringify(item)).toString('base64url');
  const pathname = '/api/sync/files/' + encodeURIComponent(item.id) + '?item=' + encodeURIComponent(metadata);
  const stream = fs.createReadStream(filePath);
  const { response } = await signedRequest(peer.url, syncState.secret, 'POST', pathname, {
    body: stream,
    bodyHash: item.sha256,
    duplex: 'half',
    timeoutMs: 86_400_000,
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  const data = Buffer.from(await response.arrayBuffer());
  const digest = hashBuffer(data);
  if (!verifySyncResponse(response, syncState.secret, 'POST', pathname, digest)) throw new Error('The paired host returned an invalid file receipt.');
  let result = {};
  try { result = JSON.parse(data.toString('utf8')); } catch { throw new Error('The paired host returned an invalid file receipt.'); }
  if (!response.ok) throw new Error(result.error || 'The paired host could not store a file.');
}

async function syncWithPeer(peer) {
  if (!syncState || hostFrozen || hostBusy) return;
  await syncSnapshot();
  const remote = await requestPeerJson(peer, 'GET', '/api/sync/state');
  if (!remote || remote.roomId !== syncState.roomId || !Array.isArray(remote.items) || !Array.isArray(remote.tombstones)) throw new Error('The connected host belongs to a different room.');
  if (mergeSyncPeers(remote.peers)) await persistSyncState();
  const combinedTombstones = new Map(tombstones.map((entry) => [entry.id, entry]));
  for (const entry of remote.tombstones) {
    const previous = combinedTombstones.get(entry.id);
    if (!previous || Date.parse(entry.deletedAt) > Date.parse(previous.deletedAt)) combinedTombstones.set(entry.id, entry);
  }
  const tombstoneList = [...combinedTombstones.values()];
  if (JSON.stringify(tombstones) !== JSON.stringify(tombstoneList)) await applyTombstones(tombstoneList);
  if (JSON.stringify(remote.tombstones) !== JSON.stringify(tombstoneList)) {
    await requestPeerJson(peer, 'POST', '/api/sync/tombstones', { tombstones: tombstoneList });
  }
  const deleted = new Set(tombstoneList.map((entry) => entry.id));
  const remoteItems = new Map(remote.items.filter((item) => item && !deleted.has(item.id)).map((item) => [item.id, item]));
  const localItems = new Map(items.filter((item) => !deleted.has(item.id)).map((item) => [item.id, item]));
  const textToPush = [...localItems.values()].filter((item) => item.kind === 'text' && !remoteItems.has(item.id));
  for (const item of textToPush) await requestPeerJson(peer, 'POST', '/api/sync/items', { items: [item] });
  for (const item of remoteItems.values()) {
    if (localItems.has(item.id) || tombstones.some((entry) => entry.id === item.id)) continue;
    if (item.kind === 'text') await receiveSyncText(item);
    else if (item.kind === 'file') await pullSyncFile(peer, item);
  }
  for (const item of localItems.values()) {
    if (remoteItems.has(item.id) || tombstoneList.some((entry) => entry.id === item.id)) continue;
    if (item.kind === 'file') await pushSyncFile(peer, item);
  }
  peer.lastSyncAt = new Date().toISOString();
  peer.lastError = '';
  lastSyncAt = peer.lastSyncAt;
  await requestPeerJson(peer, 'POST', '/api/sync/status', { nodeId: syncState.nodeId, syncedAt: peer.lastSyncAt, peers: currentSyncPeerSummary() });
}

async function runSyncCycle(targetNodeId = null) {
  if (syncCycleRunning) throw Object.assign(new Error('A room sync is already running on this host.'), { status: 409 });
  if (!syncState || !syncState.peers.length) throw Object.assign(new Error('No other hosts are paired with this room yet.'), { status: 409 });
  if (hostFrozen || hostBusy) throw Object.assign(new Error('Resume this host before syncing the room.'), { status: 409 });
  const selectedPeers = targetNodeId ? syncState.peers.filter((peer) => peer.nodeId === targetNodeId) : [...syncState.peers];
  if (!selectedPeers.length) throw Object.assign(new Error('That host is not in this room’s paired-device list.'), { status: 404 });
  syncCycleRunning = true;
  const failures = [];
  let syncedCount = 0;
  try {
    for (const peer of selectedPeers) {
      if (hostFrozen || hostBusy) break;
      activeMutations++;
      try { await syncWithPeer(peer); syncedCount++; }
      catch (error) { peer.lastError = error.message || 'Host sync failed.'; lastSyncError = peer.lastError; failures.push({ nodeId: peer.nodeId, error: peer.lastError }); }
      finally { endMutation(); }
      await persistSyncState().catch((error) => console.error('Could not save sync status:', error.message));
    }
    if (!syncState.peers.some((peer) => peer.lastError)) lastSyncError = null;
    return { ok: failures.length === 0 && syncedCount === selectedPeers.length, synced: syncedCount, failures, peers: currentSyncPeerSummary() };
  } finally { syncCycleRunning = false; }
}

async function handleSyncClaim(req, res, peer, lanInterfaces) {
  let value;
  try { value = JSON.parse((await readBody(req, 4096)).toString('utf8')); }
  catch (error) { sendJson(res, error.status || 400, { error: 'The host-pairing request is invalid.' }); return; }
  const code = String(value.code || '').trim().toLowerCase();
  const invite = syncInvites.get(code);
  if (!invite || invite.expiresAt < Date.now()) { syncInvites.delete(code); sendJson(res, 410, { error: 'That host-pairing code expired. Create a new one on the existing host.' }); return; }
  let targetOrigin;
  try { targetOrigin = validatePeerOrigin(value.targetUrl); }
  catch (error) { sendJson(res, 400, { error: error.message }); return; }
  const targetHost = new URL(targetOrigin).hostname;
  if (targetHost !== normalizedPeerAddress(peer) || !/^[a-f0-9-]{36}$/.test(value.nodeId || '')) {
    sendJson(res, 403, { error: 'The new host address could not be verified on this local network.' }); return;
  }
  syncInvites.delete(code);
  const state = await ensureSyncIdentity();
  mergeSyncPeers([{ nodeId: value.nodeId, url: targetOrigin }]);
  await persistSyncState();
  sendJson(res, 200, {
    roomId: state.roomId,
    nodeId: state.nodeId,
    secret: state.secret,
    pin,
    peers: currentSyncPeerSummary(),
    addresses: hostAddresses(lanInterfaces)
  });
}

async function pairWithHost(sourceUrl, code, lanInterfaces) {
  if (process.env.SHARE_PIN) throw Object.assign(new Error('Unset SHARE_PIN on this host before pairing so the room PIN can match.'), { status: 409 });
  if (!await dataFolderIsEmpty() || syncState || tombstones.length) throw Object.assign(new Error('Pairing is only available on a new, empty host.'), { status: 409 });
  const sourceOrigin = validatePeerOrigin(sourceUrl);
  const targetUrl = hostAddressForPeer(sourceOrigin, lanInterfaces);
  if (!targetUrl) throw Object.assign(new Error('No private network address is available on this host.'), { status: 409 });
  const nodeId = crypto.randomUUID();
  let response;
  try {
    response = await fetch(sourceOrigin + '/api/sync/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim().toLowerCase(), nodeId, targetUrl }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    });
  } catch { throw Object.assign(new Error('Could not reach that host. Check its address, PIN room, firewall, and same-network connection.'), { status: 502 }); }
  let result = {};
  try { result = await response.json(); } catch { /* Use a clear pairing error below. */ }
  if (!response.ok) throw Object.assign(new Error(result.error || 'The other host rejected pairing.'), { status: response.status });
  if (!/^[a-f0-9-]{36}$/.test(result.roomId || '') || !/^[a-f0-9-]{36}$/.test(result.nodeId || '') || !/^[A-Za-z0-9_-]{40,60}$/.test(result.secret || '') || !/^\d{6}$/.test(result.pin || '')) {
    throw Object.assign(new Error('The other host returned invalid room information.'), { status: 502 });
  }
  const peers = [{ nodeId: result.nodeId, url: sourceOrigin }, ...(Array.isArray(result.peers) ? result.peers : [])];
  syncState = { version: 1, roomId: result.roomId, nodeId, secret: result.secret, peers: [] };
  mergeSyncPeers(peers);
  tombstones = [];
  pin = result.pin;
  await fs.promises.writeFile(PIN_PATH, pin + '\n', { encoding: 'utf8', mode: 0o600 });
  await persistSyncState();
  await persistTombstones();
  sessions.clear();
  return { ok: true, peerCount: syncState.peers.length };
}

function beginMutation(res) {
  if (hostFrozen || hostBusy) {
    sendJson(res, 423, { error: hostFrozen ? 'Sharing is paused while this host is being moved.' : 'Host data is being transferred. Try again shortly.' });
    return false;
  }
  activeMutations++;
  return true;
}

function endMutation() {
  activeMutations = Math.max(0, activeMutations - 1);
  if (activeMutations === 0) {
    for (const resolve of mutationDrainWaiters) resolve();
    mutationDrainWaiters = [];
  }
}

function waitForMutations() {
  if (activeMutations === 0) return Promise.resolve();
  return new Promise((resolve) => mutationDrainWaiters.push(resolve));
}

async function dataFolderIsEmpty() {
  if (items.length > 0) return false;
  const entries = await fs.promises.readdir(FILES_DIR);
  return entries.length === 0;
}

async function createHostBackupEntries() {
  await saveQueue;
  const entries = [
    { name: 'items.json', buffer: Buffer.from(JSON.stringify(items, null, 2), 'utf8') },
    { name: 'join-pin.txt', buffer: Buffer.from(pin + '\n', 'utf8') }
  ];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const filePath = path.join(FILES_DIR, item.storageName);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size !== item.size) throw new Error('A shared file is missing or changed; backup was cancelled.');
    entries.push({ name: 'files/' + item.storageName, path: filePath });
  }
  return entries;
}

async function commitImportedHostData(payloadRoot, imported) {
  const backupRoot = path.join(DATA_ROOT, '.before-host-import-' + crypto.randomUUID());
  await fs.promises.mkdir(backupRoot, { mode: 0o700 });
  const movable = [
    [FILES_DIR, path.join(backupRoot, 'files')],
    [INDEX_PATH, path.join(backupRoot, 'items.json')],
    [PIN_PATH, path.join(backupRoot, 'join-pin.txt')]
  ];
  const backedUp = [];
  const installed = [];
  try {
    for (const [source, destination] of movable) {
      try {
        await fs.promises.rename(source, destination);
        backedUp.push([source, destination]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.promises.rename(path.join(payloadRoot, 'files'), FILES_DIR);
    installed.push(FILES_DIR);
    await fs.promises.rename(path.join(payloadRoot, 'items.json'), INDEX_PATH);
    installed.push(INDEX_PATH);
    await fs.promises.rename(path.join(payloadRoot, 'join-pin.txt'), PIN_PATH);
    installed.push(PIN_PATH);
  } catch (error) {
    for (const target of installed) {
      await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    for (const [original, saved] of backedUp.reverse()) {
      await fs.promises.rename(saved, original).catch((restoreError) => console.error('Could not restore pre-import data:', restoreError.message));
    }
    throw error;
  }
  await fs.promises.rm(HOST_STATE_PATH, { force: true }).catch((error) => console.error('Could not clear the old host transfer state:', error.message));
  items = imported.items;
  pin = imported.pin;
  hostFrozen = false;
  saveQueue = Promise.resolve();
  sessions.clear();
  await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch((error) => console.error('Could not remove the empty pre-import folder:', error.message));
}

async function configureFileLogging() {
  try {
    const stat = await fs.promises.stat(LOG_PATH);
    if (stat.size > 1024 * 1024) {
      await fs.promises.rm(LOG_PATH + '.1', { force: true });
      await fs.promises.rename(LOG_PATH, LOG_PATH + '.1');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const output = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  output.on('error', (error) => process.stderr.write('Could not write the Lantern Share log: ' + error.message + '\n'));
  const originals = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) };
  for (const level of Object.keys(originals)) {
    console[level] = (...args) => {
      originals[level](...args);
      output.write(new Date().toISOString() + ' [' + level.toUpperCase() + '] ' + util.format(...args) + '\n');
    };
  }
}

function publicItem(item) {
  return { id: item.id, kind: item.kind, name: item.name, mime: item.mime || null, size: item.size || 0, text: item.text, createdAt: item.createdAt };
}

function contentDisposition(name, disposition) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return disposition + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

function getPreviewType(mime, name) {
  if (mime === 'application/octet-stream') mime = inferMediaMime(name) || mime;
  if (/^image\/(?:jpeg|png|gif|webp|avif|bmp|x-icon|tiff)$/.test(mime)) return mime;
  if (/^video\/(?:mp4|webm|ogg|quicktime|3gpp|x-matroska|mpeg|x-msvideo)$/.test(mime)) return mime;
  if (/^audio\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return mime;
  return null;
}

function sendStatic(res, filePath) {
  fs.createReadStream(filePath).on('error', () => sendJson(res, 404, { error: 'Not found.' })).pipe(res);
}

async function handleRequest(req, res, lanInterfaces) {
  setSecurityHeaders(res);
  const peer = req.socket.remoteAddress;
  if (!isAllowedPeer(peer, lanInterfaces) || !isAllowedHost(req.headers.host, lanInterfaces)) {
    sendJson(res, 403, { error: 'This share is available only from the host device or its local network.' });
    return;
  }

  let url;
  try { url = new URL(req.url, protocol + '://' + req.headers.host); }
  catch { sendJson(res, 400, { error: 'Invalid request.' }); return; }

  if (req.method === 'POST' && url.pathname === '/api/sync/claim') {
    await handleSyncClaim(req, res, peer, lanInterfaces);
    return;
  }
  if (url.pathname.startsWith('/api/sync/') && !['/api/sync/invite', '/api/sync/pair', '/api/sync/run'].includes(url.pathname)) {
    await handleSyncPeerRequest(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    sendStatic(res, path.join(ROOT, 'public', 'index.html'));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/styles.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    sendStatic(res, path.join(ROOT, 'public', 'styles.css'));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    sendStatic(res, path.join(ROOT, 'public', 'app.js'));
    return;
  }
  if (req.method === 'GET' && WEB_APP_ASSETS[url.pathname]) {
    const [assetPath, contentType] = WEB_APP_ASSETS[url.pathname];
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    sendStatic(res, path.join(ROOT, 'public', assetPath));
    return;
  }
  if (req.method === 'GET' && BRAND_ASSETS[url.pathname]) {
    const [assetPath, contentType] = BRAND_ASSETS[url.pathname];
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    sendStatic(res, path.join(ROOT, 'public', assetPath));
    return;
  }

  if (req.method === 'POST' && !requireSameOrigin(req)) {
    sendJson(res, 403, { error: 'Request origin could not be verified.' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const clientIp = normalizedAddress(peer);
    const attempt = loginAttempts.get(clientIp) || { count: 0, until: Date.now() + 60_000 };
    if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 60_000; }
    if (attempt.count >= 12) { sendJson(res, 429, { error: 'Too many attempts. Wait one minute and try again.' }); return; }
    let body;
    try { body = JSON.parse((await readBody(req, 2048)).toString('utf8')); }
    catch (error) { sendJson(res, error.status || 400, { error: 'Enter the join PIN shown on the host.' }); return; }
    const submitted = Buffer.from(String(body.pin || ''));
    const expected = Buffer.from(pin);
    const valid = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
    if (!valid) {
      attempt.count++;
      loginAttempts.set(clientIp, attempt);
      sendJson(res, 401, { error: 'That PIN did not match. Check the host device and try again.' });
      return;
    }
    loginAttempts.delete(clientIp);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL);
    res.setHeader('Set-Cookie', jsonCookie(token));
    sendJson(res, 200, { ok: true });
    return;
  }

  const session = getSession(req);
  if (req.method === 'GET' && url.pathname === '/api/session') {
    sendJson(res, 200, { authenticated: Boolean(session), items: session ? items.map(publicItem) : [] });
    return;
  }
  if (!session) { sendJson(res, 401, { error: 'Enter the join PIN to continue.' }); return; }

  if (req.method === 'GET' && url.pathname === '/api/host/status') {
    const canManage = isHostPeer(peer, lanInterfaces);
    const empty = canManage ? await dataFolderIsEmpty() : false;
    sendJson(res, 200, {
      canManage,
      frozen: hostFrozen,
      busy: hostBusy,
      empty,
      itemCount: items.length,
      fileCount: items.filter((item) => item.kind === 'file').length,
      dataPath: canManage ? DATA_ROOT : null,
      fixedPin: Boolean(process.env.SHARE_PIN),
      addresses: hostAddresses(lanInterfaces),
      canImport: canManage && !hostFrozen && !hostBusy && !process.env.SHARE_PIN && empty,
      syncReady: Boolean(syncState),
      syncNodeId: syncState ? syncState.nodeId : null,
      syncPeers: currentSyncPeerSummary(),
      syncRunning: syncCycleRunning,
      lastSyncAt,
      lastSyncError
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/run') {
    let body;
    try { body = JSON.parse((await readBody(req, 2048)).toString('utf8')); }
    catch { sendJson(res, 400, { error: 'Choose a paired host to sync with.' }); return; }
    try {
      const result = await runSyncCycle(typeof body.nodeId === 'string' ? body.nodeId : null);
      await persistSyncState();
      sendJson(res, result.ok ? 200 : 502, result.ok ? result : { ...result, error: result.failures[0]?.error || 'Could not sync with one or more devices.' });
    } catch (error) { sendJson(res, error.status || 400, { error: error.message || 'Could not sync with the paired host.' }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/invite') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host pairing is available only on the host device.' }); return; }
    if (hostFrozen || hostBusy) { sendJson(res, 409, { error: 'Resume this host before pairing another device.' }); return; }
    await ensureSyncIdentity();
    const code = crypto.randomBytes(16).toString('hex');
    const invite = { expiresAt: Date.now() + 10 * 60 * 1000 };
    for (const [key, value] of syncInvites) if (value.expiresAt < Date.now()) syncInvites.delete(key);
    syncInvites.set(code, invite);
    setTimeout(() => { if (syncInvites.get(code) === invite) syncInvites.delete(code); }, 10 * 60 * 1000).unref();
    sendJson(res, 200, { code, expiresAt: invite.expiresAt, addresses: hostAddresses(lanInterfaces) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/sync/pair') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host pairing is available only on the host device.' }); return; }
    if (hostFrozen || hostBusy) { sendJson(res, 409, { error: 'Resume this host before pairing.' }); return; }
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); }
    catch { sendJson(res, 400, { error: 'Enter the existing host address and pairing code.' }); return; }
    try {
      const result = await pairWithHost(body.address, body.code, lanInterfaces);
      res.setHeader('Set-Cookie', 'lantern_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (useHttps ? '; Secure' : ''));
      sendJson(res, 200, result);
    } catch (error) { sendJson(res, error.status || 400, { error: error.message || 'Could not pair this host.' }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/host/freeze') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host controls are available only on the host device.' }); return; }
    if (hostBusy) { sendJson(res, 409, { error: 'A host transfer is already in progress.' }); return; }
    if (!hostFrozen) {
      hostFrozen = true;
      try {
        await persistHostState(true);
        await waitForMutations();
      } catch (error) {
        hostFrozen = false;
        throw error;
      }
    }
    sendJson(res, 200, { frozen: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/host/resume') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host controls are available only on the host device.' }); return; }
    if (hostBusy) { sendJson(res, 409, { error: 'A host transfer is already in progress.' }); return; }
    await persistHostState(false);
    hostFrozen = false;
    sendJson(res, 200, { frozen: false });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/host/backup-ticket') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host controls are available only on the host device.' }); return; }
    if (!hostFrozen || hostBusy) { sendJson(res, 409, { error: 'Freeze this host before creating its backup.' }); return; }
    let body;
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); }
    catch { sendJson(res, 400, { error: 'Enter a backup passphrase.' }); return; }
    try { checkPassphrase(body.passphrase); }
    catch (error) { sendJson(res, 400, { error: error.message }); return; }
    const ticket = crypto.randomBytes(32).toString('hex');
    for (const [key, value] of backupTickets) if (value.expiresAt < Date.now()) backupTickets.delete(key);
    const ticketData = { passphrase: body.passphrase, expiresAt: Date.now() + 10 * 60 * 1000 };
    backupTickets.set(ticket, ticketData);
    const expiryTimer = setTimeout(() => {
      if (backupTickets.get(ticket) === ticketData) {
        ticketData.passphrase = '';
        backupTickets.delete(ticket);
      }
    }, 10 * 60 * 1000);
    expiryTimer.unref();
    sendJson(res, 200, { url: '/api/host/backup?ticket=' + ticket });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/host/backup') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host controls are available only on the host device.' }); return; }
    if (!hostFrozen || hostBusy) { sendJson(res, 409, { error: 'Freeze this host before downloading its backup.' }); return; }
    const ticket = url.searchParams.get('ticket') || '';
    const credentials = backupTickets.get(ticket);
    backupTickets.delete(ticket);
    if (!credentials || credentials.expiresAt < Date.now()) { sendJson(res, 410, { error: 'The backup link expired. Create a new one.' }); return; }
    hostBusy = true;
    try {
      const entries = await createHostBackupEntries();
      res.writeHead(200, {
        'Content-Type': 'application/vnd.lantern-share.backup',
        'Content-Disposition': 'attachment; filename="lantern-share-backup.lshare"',
        'Cache-Control': 'private, no-store'
      });
      await pipeline(Readable.from(createEncryptedBackup(entries, credentials.passphrase)), res);
    } finally {
      hostBusy = false;
      credentials.passphrase = '';
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/host/import') {
    if (!isHostPeer(peer, lanInterfaces)) { sendJson(res, 403, { error: 'Host controls are available only on the host device.' }); return; }
    if (hostFrozen || hostBusy) { sendJson(res, 409, { error: 'Resume this host before importing another host backup.' }); return; }
    if (process.env.SHARE_PIN) { sendJson(res, 409, { error: 'Unset SHARE_PIN on this host before importing so the room PIN remains the one in the backup.' }); return; }
    if (!(req.headers['content-type'] || '').startsWith('application/octet-stream')) { sendJson(res, 415, { error: 'Choose a Lantern Share backup file.' }); return; }
    if (!await dataFolderIsEmpty()) { sendJson(res, 409, { error: 'Import is only allowed on a new, empty host. Back up or remove its existing shares first.' }); return; }
    let passphrase;
    try {
      passphrase = decodeBackupPassphraseHeader(req.headers['x-lantern-backup-passphrase']);
      checkPassphrase(passphrase);
    }
    catch (error) { sendJson(res, 400, { error: error.message }); return; }

    hostBusy = true;
    const operationRoot = path.join(DATA_ROOT, '.host-import-' + crypto.randomUUID());
    const archivePath = path.join(operationRoot, 'incoming.lshare');
    const tarPath = path.join(operationRoot, 'incoming.tar');
    const payloadRoot = path.join(operationRoot, 'payload');
    try {
      await waitForMutations();
      if (!await dataFolderIsEmpty()) throw Object.assign(new Error('The target host received new shares during import. Remove them before trying again.'), { status: 409 });
      await fs.promises.mkdir(operationRoot, { mode: 0o700 });
      await pipeline(req, fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
      try { await decryptBackupFile(archivePath, tarPath, passphrase); }
      catch { throw Object.assign(new Error('The backup passphrase is incorrect or the backup is damaged.'), { status: 400 }); }
      await fs.promises.rm(archivePath, { force: true });
      const imported = await extractAndValidateTar(tarPath, payloadRoot);
      await fs.promises.rm(tarPath, { force: true });
      await commitImportedHostData(payloadRoot, imported);
      res.setHeader('Set-Cookie', 'lantern_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (useHttps ? '; Secure' : ''));
      sendJson(res, 200, { ok: true, itemCount: imported.items.length, fileCount: imported.items.filter((item) => item.kind === 'file').length });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 400, { error: error.status === 409 ? error.message : (error.status ? error.message : 'The host backup could not be imported. Check the passphrase and available disk space.') });
    } finally {
      hostBusy = false;
      passphrase = '';
      await fs.promises.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(session);
    res.setHeader('Set-Cookie', 'lantern_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (useHttps ? '; Secure' : ''));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/items') {
    sendJson(res, 200, { items: items.map(publicItem) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/text') {
    if (!beginMutation(res)) return;
    try {
      let body;
      try { body = JSON.parse((await readBody(req, MAX_TEXT_BYTES)).toString('utf8')); }
      catch (error) { sendJson(res, error.status || 400, { error: 'Text could not be read.' }); return; }
      const text = String(body.text || '');
      if (!text.trim()) { sendJson(res, 400, { error: 'Write or paste some text first.' }); return; }
      const item = { id: crypto.randomUUID(), kind: 'text', name: 'Shared text', text, size: Buffer.byteLength(text), createdAt: new Date().toISOString() };
      items.unshift(item);
      try { await persistItems(); }
      catch (error) { items = items.filter((candidate) => candidate.id !== item.id); throw error; }
      sendJson(res, 201, { item: publicItem(item) });
    } finally { endMutation(); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/files') {
    if (!beginMutation(res)) return;
    try {
    const name = safeFilename(url.searchParams.get('name'));
    const requestedMime = safeMime(req.headers['content-type']);
    const mime = requestedMime === 'application/octet-stream' ? inferMediaMime(name) || requestedMime : requestedMime;
    const id = crypto.randomUUID();
    const storageName = id + '.blob';
    const destination = path.join(FILES_DIR, storageName);
    let size = 0;
    const contentHash = crypto.createHash('sha256');
    try {
      const counter = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; contentHash.update(chunk); callback(null, chunk); } });
      await pipeline(req, counter, fs.createWriteStream(destination, { flags: 'wx' }));
      const item = { id, kind: 'file', name, mime, size, storageName, sha256: contentHash.digest('hex'), createdAt: new Date().toISOString() };
      items.unshift(item);
      try { await persistItems(); }
      catch (error) { items = items.filter((candidate) => candidate.id !== id); throw error; }
      sendJson(res, 201, { item: publicItem(item) });
    } catch (error) {
      await fs.promises.rm(destination, { force: true }).catch(() => {});
      if (!res.headersSent) sendJson(res, 500, { error: 'Upload was interrupted. Check the connection and available disk space.' });
    }
    } finally { endMutation(); }
    return;
  }
  const fileMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]{36})\/(download|preview)$/);
  if (req.method === 'GET' && fileMatch) {
    const item = items.find((candidate) => candidate.id === fileMatch[1] && candidate.kind === 'file');
    if (!item) { sendJson(res, 404, { error: 'File not found.' }); return; }
    const preview = fileMatch[2] === 'preview';
    const mime = preview ? getPreviewType(item.mime || 'application/octet-stream', item.name) : null;
    if (preview && !mime) { sendJson(res, 415, { error: 'Preview is not available for this file type.' }); return; }
    const filePath = path.join(FILES_DIR, item.storageName);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0 && !req.headers.range) {
        res.writeHead(200, {
          'Content-Type': mime || 'application/octet-stream',
          'Content-Length': 0,
          'Content-Disposition': contentDisposition(item.name, preview ? 'inline' : 'attachment'),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store'
        });
        res.end();
        return;
      }
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match || stat.size === 0) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Accept-Ranges': 'bytes' });
          res.end();
          return;
        }
        if (match[1] === '') {
          const suffixLength = Number(match[2]);
          if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Accept-Ranges': 'bytes' });
            res.end();
            return;
          }
          start = Math.max(0, stat.size - suffixLength);
        } else {
          start = Number(match[1]);
          end = match[2] === '' ? end : Number(match[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Accept-Ranges': 'bytes' });
          res.end();
          return;
        }
        end = Math.min(end, stat.size - 1);
        status = 206;
      }
      const headers = {
        'Content-Type': mime || 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Disposition': contentDisposition(item.name, preview ? 'inline' : 'attachment'),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store'
      };
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      res.writeHead(status, headers);
      fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
    } catch { sendJson(res, 404, { error: 'File is no longer available.' }); }
    return;
  }
  const deleteMatch = url.pathname.match(/^\/api\/items\/([a-f0-9-]{36})$/);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!beginMutation(res)) return;
    try {
    const index = items.findIndex((item) => item.id === deleteMatch[1]);
    if (index < 0) { sendJson(res, 404, { error: 'Item not found.' }); return; }
    const deletedAt = new Date().toISOString();
    tombstones = [...tombstones.filter((entry) => entry.id !== deleteMatch[1]), { id: deleteMatch[1], deletedAt }];
    await persistTombstones();
    const [item] = items.splice(index, 1);
    if (item.kind === 'file') await fs.promises.rm(path.join(FILES_DIR, item.storageName), { force: true });
    await persistItems();
    sendJson(res, 200, { ok: true });
    } finally { endMutation(); }
    return;
  }
  sendJson(res, 404, { error: 'Not found.' });
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be a valid TCP port.');
  if (Boolean(process.env.HTTPS_CERT) !== Boolean(process.env.HTTPS_KEY)) throw new Error('Set both HTTPS_CERT and HTTPS_KEY to enable HTTPS.');
  await loadItems();
  await loadPin();
  await loadHostState();
  await loadSyncFiles();
  await configureFileLogging();
  const lanInterfaces = getLanInterfaces();
  const handler = (req, res) => handleRequest(req, res, getLanInterfaces()).catch((error) => {
    console.error('Request failed:', error.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'The server could not complete that request.' });
    else res.destroy();
  });
  const server = useHttps
    ? https.createServer({ key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\nLantern Share is running.');
    console.log('Join PIN: ' + pin);
    if (hostFrozen) console.log('This host is paused for transfer. Resume it from the host controls in the app when ready.');
    console.log('Open one of these addresses on devices using this same local network:');
    for (const item of lanInterfaces) console.log('  ' + protocol + '://' + item.address + ':' + PORT + '  (' + item.name + ')');
    for (const localName of new Set([...localHostAliases()].map((alias) => alias.includes('.') ? alias : alias + '.local'))) {
      console.log('  ' + protocol + '://' + localName + ':' + PORT + '  (local network name)');
    }
    console.log('  ' + protocol + '://localhost:' + PORT + '  (this device)');
    console.log('Files and share history are stored in: ' + DATA_ROOT);
    console.log('Join PIN is also saved in: ' + PIN_PATH);
    console.log('Server log: ' + LOG_PATH);
    if (lanInterfaces.length === 0) console.log('No private IPv4 interface was found yet. The server will check again when devices connect.');
    if (!useHttps) console.log('LAN traffic uses HTTP. For encrypted transport, set HTTPS_CERT and HTTPS_KEY to a trusted certificate and restart.');
    if (syncState && syncState.peers.length) console.log('This host is paired with ' + syncState.peers.length + ' other host(s); data moves only when someone taps Sync now.');
    console.log('');
  });
  server.on('error', (error) => {
    console.error('Could not start the server:', error.message);
    process.exitCode = 1;
  });
}

process.on('SIGINT', () => {
  console.log('\nStopping Lantern Share.');
  process.exit(0);
});
process.on('uncaughtException', (error) => {
  console.error('Unexpected server error:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error('Could not start Lantern Share:', error.message);
  process.exit(1);
});
