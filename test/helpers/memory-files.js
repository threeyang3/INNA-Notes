'use strict';

// Test-only filesystem: real bytes and NativeFiles' contract, no macOS processes.
const path = require('node:path').posix;
const { deflateSync } = require('node:zlib');
const { inspectPng } = require('../../src/png.js');
const { child } = require('../../src/native.js');
const { normalizeAbsolutePath } = require('../../src/protocol.js');

function makePng(rgba = [255, 64, 16, 255]) {
  function chunk(name, data = Buffer.alloc(0)) {
    const type = Buffer.from(name, 'ascii');
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    type.copy(output, 4); data.copy(output, 8);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0].concat(rgba)))), chunk('IEND')
  ]);
}

class MemoryFiles {
  constructor(options = {}) {
    this.dataRoot = normalizeAbsolutePath(options.dataRoot || '/IINA Data');
    this.defaultRoot = child(this.dataRoot, 'exports/IINA');
    this.files = new Map();
    this.directories = new Set(['/']);
    this.calls = [];
    this.handles = [];
    this.failures = [];
    this.hooks = {};
    this.addDirectory(this.dataRoot);
    for (const directory of ['drafts', 'captures', 'previews', 'exports/IINA']) {
      this.addDirectory(this.privatePath(directory));
    }
  }

  // Fault injection is per operation and consumed exactly once. predicate receives
  // {op, path, source?, target?, root?, relative?}; hooks may pause async operations.
  failNext(op, predicate = () => true, error = new Error('EIO: simulated disk failure')) {
    this.failures.push({ op, predicate, error });
  }
  _call(op, details = {}) {
    const call = Object.assign({ op }, details);
    this.calls.push(call);
    const index = this.failures.findIndex(fault => fault.op === op && fault.predicate(call));
    if (index >= 0) throw this.failures.splice(index, 1)[0].error;
    return call;
  }
  async _hook(op, call) {
    if (typeof this.hooks[op] === 'function') await this.hooks[op](call);
  }
  addDirectory(directory) {
    const full = normalizeAbsolutePath(directory);
    const parent = path.dirname(full);
    if (parent !== full && !this.directories.has(parent)) this.addDirectory(parent);
    if (this.files.has(full)) throw new Error('ENOTDIR');
    this.directories.add(full);
    return full;
  }
  put(filename, bytes) {
    const full = normalizeAbsolutePath(filename);
    this.addDirectory(path.dirname(full));
    this.files.set(full, Buffer.from(bytes));
    return full;
  }
  bytes(filename) {
    const bytes = this.files.get(filename);
    if (!bytes) throw new Error('ENOENT: ' + filename);
    return Buffer.from(bytes);
  }
  async initialize() {}
  privatePath(relative) { return child(this.dataRoot, relative); }
  exists(filename) { return this.files.has(filename) || this.directories.has(filename); }
  async type(filename) {
    this._call('type', { path: filename });
    return this.directories.has(filename) ? 'Directory' : this.files.has(filename) ? 'Regular File' : null;
  }
  async canonicalRoot(root) {
    this._call('canonicalRoot', { path: root });
    const value = normalizeAbsolutePath(root);
    if (!this.directories.has(value)) throw new Error('ENOENT: output directory');
    return value;
  }
  async assertRoot(root) {
    if (await this.canonicalRoot(root) !== root) throw new Error('Root changed');
  }
  async ensureDir(root, relative) {
    await this.assertRoot(root);
    return this.addDirectory(child(root, relative));
  }
  async prepareOutput(root) {
    this._call('prepareOutput', { path: root, root });
    await this.assertRoot(root);
    this.addDirectory(child(root, 'assets'));
    this.addDirectory(child(root, '.iina-staging'));
    return root;
  }
  async checkedPath(root, relative) {
    const full = child(root, relative);
    this._call('checkedPath', { path: full, root, relative });
    await this.assertRoot(root);
    if (!this.directories.has(path.dirname(full))) throw new Error('ENOTDIR: parent missing');
    if (this.directories.has(full)) throw new Error('Target is not a regular file');
    return full;
  }
  read(filename) {
    this._call('read', { path: filename });
    return this.bytes(filename).toString('utf8');
  }
  writeText(filename, text) {
    this._call('writeText', { path: filename, text });
    if (!this.directories.has(path.dirname(filename))) throw new Error('ENOENT: parent missing');
    if (this.files.has(filename) && !filename.startsWith(this.dataRoot + '/')) {
      throw new Error('EEXIST: IINA forbids overwriting external files');
    }
    this.files.set(filename, Buffer.from(text, 'utf8'));
    if (this.read(filename) !== text) throw new Error('Text read-back mismatch');
  }
  handle(filename, mode) {
    this._call('handle', { path: filename, mode });
    if (!this.files.has(filename)) throw new Error('ENOENT: handle does not create files');
    if (mode !== 'read' && mode !== 'write') throw new Error('Invalid handle mode');
    let position = 0;
    const files = this.files;
    const handle = {
      path: filename, closed: false,
      offset() { return position; },
      seekToEnd() { position = files.get(filename).length; },
      seekTo(offset) { position = offset; },
      read(length) {
        if (this.closed || mode !== 'read') throw new Error('Handle unavailable');
        const bytes = files.get(filename).subarray(position, position + length);
        position += bytes.length;
        return new Uint8Array(bytes);
      },
      readToEnd() { return this.read(files.get(filename).length - position); },
      write(bytes) {
        if (this.closed || mode !== 'write' || !(bytes instanceof Uint8Array)) throw new Error('Invalid binary write');
        const old = files.get(filename);
        const next = Buffer.alloc(Math.max(old.length, position + bytes.length));
        old.copy(next); Buffer.from(bytes).copy(next, position);
        files.set(filename, next); position += bytes.length;
      },
      close() { this.closed = true; }
    };
    this.handles.push(handle);
    return handle;
  }
  inspectImage(filename) {
    this._call('inspectImage', { path: filename });
    const handle = this.handle(filename, 'read');
    try { return inspectPng(handle); }
    finally { handle.close(); }
  }
  async copyBinary(source, target) {
    const call = this._call('copyBinary', { path: target, source, target });
    this.inspectImage(source);
    if (this.exists(target)) throw new Error('EEXIST');
    if (!this.directories.has(path.dirname(target))) throw new Error('ENOENT');
    this.files.set(target, this.bytes(source));
    await this._hook('copyBinary', call);
  }
  async equalFiles(a, b) {
    this._call('equalFiles', { path: b, source: a, target: b });
    return this.bytes(a).equals(this.bytes(b));
  }
  async publishFile(root, stagingRelative, finalRelative) {
    const source = child(root, stagingRelative);
    const target = child(root, finalRelative);
    const call = this._call('publishFile', { path: target, source, target, root });
    if (!this.files.has(source)) throw new Error('ENOENT: missing staging file');
    if (this.exists(target)) throw new Error('EEXIST: create-if-absent failed');
    if (!this.directories.has(path.dirname(target))) throw new Error('ENOENT: parent missing');
    // Shared immutable buffer models a hard link; unlinking staging retains export.
    this.files.set(target, this.files.get(source));
    this._call('afterPublishFile', { path: target, source, target, root });
    await this._hook('publishFile', call);
    return target;
  }
  removePrivate(relative) {
    const full = this.privatePath(relative);
    this._call('removePrivate', { path: full, relative });
    this.files.delete(full);
  }
  async removeStaging(root, relative) {
    if (!/^\.iina-staging\/[A-Za-z0-9_-]+\.(png|md)\.pending$/.test(relative)) return;
    const full = child(root, relative);
    this._call('removeStaging', { path: full, root, relative });
    this.files.delete(full);
  }
  listPrivate(relative) {
    const prefix = this.privatePath(relative) + '/';
    this._call('listPrivate', { path: prefix });
    return Array.from(this.files.keys()).filter(filename => filename.startsWith(prefix) &&
      !filename.slice(prefix.length).includes('/')).map(filename => filename.slice(prefix.length));
  }
  async preview(filename) {
    const call = this._call('preview', { path: filename });
    await this._hook('preview', call);
    this.inspectImage(filename);
    const bytes = this.bytes(filename);
    return bytes.length <= 2 * 1024 * 1024 ? 'data:image/png;base64,' + bytes.toString('base64') : null;
  }
}

module.exports = { MemoryFiles, makePng };
