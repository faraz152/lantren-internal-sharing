'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const MAGIC = Buffer.from('LNSHARE1', 'ascii');
const ENVELOPE_BYTES = MAGIC.length + 16 + 12;
const TAG_BYTES = 16;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw new Error('Use a backup passphrase between 12 and 1,024 bytes.');
  }
}

function validArchivePath(name) {
  return name === 'items.json' || name === 'join-pin.txt' || /^files\/[a-f0-9-]{36}\.blob$/.test(name);
}

async function hashEntry(entry) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  if (entry.buffer) {
    size = entry.buffer.length;
    hash.update(entry.buffer);
  } else {
    const stat = await fs.promises.stat(entry.path);
    if (!stat.isFile()) throw new Error('A backup entry is not a regular file.');
    size = stat.size;
    for await (const chunk of fs.createReadStream(entry.path)) hash.update(chunk);
  }
  return { path: entry.name, size, sha256: hash.digest('hex') };
}

function writeOctal(header, offset, length, value) {
  const field = Math.floor(value).toString(8).padStart(length - 1, '0') + '\0';
  if (field.length > length) throw new Error('A backup entry is too large for the archive format.');
  header.write(field, offset, length, 'ascii');
}

function tarHeader(name, size) {
  if (Buffer.byteLength(name, 'ascii') !== name.length || name.length > 100) throw new Error('A backup path is invalid.');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumField = checksum.toString(8).padStart(6, '0');
  header.write(checksumField, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function* createTar(entries, manifest) {
  const allEntries = [{ name: 'manifest.json', buffer: manifest }, ...entries];
  for (const entry of allEntries) {
    const size = entry.buffer ? entry.buffer.length : (await fs.promises.stat(entry.path)).size;
    yield tarHeader(entry.name, size);
    if (entry.buffer) {
      if (entry.buffer.length) yield entry.buffer;
    } else {
      for await (const chunk of fs.createReadStream(entry.path)) yield chunk;
    }
    const padding = (512 - (size % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

async function* createEncryptedBackup(entries, passphrase) {
  checkPassphrase(passphrase);
  for (const entry of entries) {
    if (!validArchivePath(entry.name)) throw new Error('A backup contains an unsupported path.');
  }
  const listed = await Promise.all(entries.map(hashEntry));
  const names = new Set(listed.map((entry) => entry.path));
  if (names.size !== listed.length || !names.has('items.json') || !names.has('join-pin.txt')) {
    throw new Error('The host data is incomplete and cannot be backed up.');
  }
  const manifest = Buffer.from(JSON.stringify({
    format: 'lantern-share-host-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    entries: listed
  }), 'utf8');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const source = Readable.from(createTar(entries, manifest));
  const piping = pipeline(source, cipher);
  try {
    yield Buffer.concat([MAGIC, salt, iv]);
    for await (const chunk of cipher) yield chunk;
    await piping;
    yield cipher.getAuthTag();
  } finally {
    source.destroy();
    cipher.destroy();
    await piping.catch(() => {});
  }
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('The backup file is incomplete.');
  return buffer;
}

async function decryptBackupFile(archivePath, tarPath, passphrase) {
  checkPassphrase(passphrase);
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < ENVELOPE_BYTES + TAG_BYTES + 1024) throw new Error('The backup file is too small or damaged.');
    const prefix = await readAt(handle, ENVELOPE_BYTES, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a Lantern Share backup.');
    const salt = prefix.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = prefix.subarray(MAGIC.length + 16);
    const tag = await readAt(handle, TAG_BYTES, size - TAG_BYTES);
    const key = await scrypt(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    await pipeline(
      fs.createReadStream(archivePath, { start: ENVELOPE_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(tarPath, { flags: 'wx' })
    );
  } finally {
    await handle.close();
  }
}

function parseOctal(field) {
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('The backup contains an invalid archive header.');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The backup contains an invalid entry size.');
  return value;
}

function tarPath(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
  return prefix ? prefix + '/' + name : name;
}

function validateIndex(saved, manifestEntries) {
  if (!Array.isArray(saved)) throw new Error('The backup shelf index is invalid.');
  const ids = new Set();
  const expectedPaths = new Set(['items.json', 'join-pin.txt']);
  for (const item of saved) {
    if (!item || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 240 || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new Error('The backup contains invalid shelf metadata.');
    }
    ids.add(item.id);
    if (item.kind === 'text') {
      if (typeof item.text !== 'string' || !Number.isSafeInteger(item.size) || item.size !== Buffer.byteLength(item.text, 'utf8')) throw new Error('The backup contains invalid text metadata.');
    } else if (item.kind === 'file') {
      if (item.storageName !== item.id + '.blob' || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.mime !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item.mime)) {
        throw new Error('The backup contains invalid file metadata.');
      }
      expectedPaths.add('files/' + item.storageName);
    } else {
      throw new Error('The backup contains an unsupported shelf item.');
    }
  }
  const listedPaths = new Set(manifestEntries.map((entry) => entry.path));
  if (listedPaths.size !== manifestEntries.length || listedPaths.size !== expectedPaths.size || [...expectedPaths].some((name) => !listedPaths.has(name))) {
    throw new Error('The backup file list does not match its shelf index.');
  }
  const listedByPath = new Map(manifestEntries.map((entry) => [entry.path, entry]));
  for (const item of saved) {
    if (item.kind === 'file' && listedByPath.get('files/' + item.storageName)?.size !== item.size) {
      throw new Error('A shared file size does not match its shelf record.');
    }
  }
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

async function extractAndValidateTar(tarPath, payloadRoot) {
  const stat = await fs.promises.stat(tarPath);
  const handle = await fs.promises.open(tarPath, 'r');
  const paths = new Set();
  let offset = 0;
  let foundEnd = false;
  try {
    await fs.promises.mkdir(path.join(payloadRoot, 'files'), { recursive: true });
    while (offset + 512 <= stat.size) {
      const header = await readAt(handle, 512, offset);
      if (header.every((byte) => byte === 0)) {
        const second = await readAt(handle, 512, offset + 512);
        if (!second.every((byte) => byte === 0) || offset + 1024 !== stat.size) throw new Error('The backup has invalid trailing data.');
        foundEnd = true;
        break;
      }
      const expectedChecksum = parseOctal(header.subarray(148, 156));
      let checksum = 0;
      for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
      if (checksum !== expectedChecksum) throw new Error('The backup archive header failed its checksum.');
      const name = tarPath(header);
      const type = header[156];
      if (type !== 0 && type !== 0x30) throw new Error('The backup contains an unsupported archive entry type.');
      if (name !== 'manifest.json' && !validArchivePath(name)) throw new Error('The backup contains an unsafe or unsupported path.');
      if (paths.has(name)) throw new Error('The backup contains duplicate entries.');
      paths.add(name);
      const size = parseOctal(header.subarray(124, 136));
      const dataStart = offset + 512;
      const paddedSize = Math.ceil(size / 512) * 512;
      if (dataStart + paddedSize > stat.size) throw new Error('The backup file is truncated.');
      if ((name === 'manifest.json' || name === 'items.json' || name === 'join-pin.txt') && size > MAX_METADATA_BYTES) {
        throw new Error('The backup metadata is too large to import safely.');
      }
      if (name === 'join-pin.txt' && size > 1024) throw new Error('The backup PIN file is invalid.');
      const relative = name.split('/');
      const destination = path.join(payloadRoot, ...relative);
      if (path.dirname(destination) !== payloadRoot && path.dirname(destination) !== path.join(payloadRoot, 'files')) {
        throw new Error('The backup contains an unsafe path.');
      }
      if (size === 0) await fs.promises.writeFile(destination, Buffer.alloc(0), { flag: 'wx' });
      else await pipeline(
        fs.createReadStream(tarPath, { start: dataStart, end: dataStart + size - 1 }),
        fs.createWriteStream(destination, { flags: 'wx' })
      );
      offset = dataStart + paddedSize;
    }
  } finally {
    await handle.close();
  }
  if (!foundEnd || !paths.has('manifest.json') || !paths.has('items.json') || !paths.has('join-pin.txt')) {
    throw new Error('The backup is missing required files.');
  }
  const manifest = JSON.parse(await fs.promises.readFile(path.join(payloadRoot, 'manifest.json'), 'utf8'));
  if (!manifest || manifest.format !== 'lantern-share-host-backup' || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('This Lantern Share backup format is not supported.');
  }
  const listed = new Map();
  for (const entry of manifest.entries) {
    if (!entry || !validArchivePath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || listed.has(entry.path)) {
      throw new Error('The backup manifest is invalid.');
    }
    listed.set(entry.path, entry);
  }
  const archivedPayloadPaths = new Set([...paths].filter((name) => name !== 'manifest.json'));
  if (listed.size !== archivedPayloadPaths.size || [...listed.keys()].some((name) => !archivedPayloadPaths.has(name))) {
    throw new Error('The backup manifest does not match the archive contents.');
  }
  for (const entry of listed.values()) {
    const filePath = path.join(payloadRoot, ...entry.path.split('/'));
    const actual = await hashFile(filePath);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error('A backup file failed its integrity check.');
  }
  const pin = (await fs.promises.readFile(path.join(payloadRoot, 'join-pin.txt'), 'utf8')).trim();
  if (!/^\d{6}$/.test(pin)) throw new Error('The backup contains an invalid join PIN.');
  const saved = JSON.parse(await fs.promises.readFile(path.join(payloadRoot, 'items.json'), 'utf8'));
  validateIndex(saved, [...listed.values()]);
  return { items: saved, pin };
}

module.exports = { checkPassphrase, createEncryptedBackup, decryptBackupFile, extractAndValidateTar };
