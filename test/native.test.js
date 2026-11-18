'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeFiles, child } = require('../src/native');

const SMALL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const DATA = '/Users/test/IINA Data';

function pngWithPadding(length) {
  const data = Buffer.from('padding\0' + 'x'.repeat(length));
  const name = Buffer.from('tEXt');
  let checksum = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  const padding = Buffer.alloc(data.length + 12);
  padding.writeUInt32BE(data.length, 0);
  name.copy(padding, 4);
  data.copy(padding, 8);
  padding.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, data.length + 8);
  return Buffer.concat([SMALL_PNG.subarray(0, 33), padding, SMALL_PNG.subarray(33)]);
}

/** Deliberately models IINA's file-creation and pseudo-path overwrite restrictions. */
function fakeApi() {
  const files = new Map();
  const dirs = new Set([DATA, '/vault']);
  const links = new Map();
  const calls = [];
  const handles = [];
  const writes = [];
  const textReads = [];
  const textWrites = [];
  const denied = new Set();
  const readLimits = new Map();
  const corruptCopies = new Set();
  let sipsFailure = false;
  let delayCalls = 0;
  const resolve = value => value.replace(/^@data(?=\/|$)/, DATA).replace(/\/$/, '');
  function canonical(path) {
    let current = path;
    for (let count = 0; count < 40; count += 1) {
      const link = Array.from(links.keys()).find(key => current === key || current.startsWith(key + '/'));
      if (!link) return current;
      current = links.get(link) + current.slice(link.length);
    }
    throw new Error('Symlink loop');
  }
  function type(path) {
    if (links.has(path)) return 'Symbolic Link';
    path = canonical(path);
    return dirs.has(path) ? 'Directory' : files.has(path) ? 'Regular File' : null;
  }
  const success = stdout => ({ status: 0, stdout: stdout || '', stderr: '' });
  const failure = message => ({ status: 1, stdout: '', stderr: message || 'Permission denied' });
  const api = {
    utils: {
      resolvePath(path) { return resolve(path); },
      async exec(binary, args, cwd) {
        calls.push({ binary, args: args.slice(), cwd });
        if (binary === '/usr/bin/stat') {
          const kind = type(args[2]);
          return kind ? success(kind + '\n') : failure('No such file');
        }
        if (binary === '/bin/pwd') {
          const directory = canonical(cwd);
          return dirs.has(directory) ? success(directory + '\n') : failure('No such directory');
        }
        if (binary === '/bin/mkdir') {
          const path = args[0];
          if (denied.has(path) || type(path)) return failure();
          dirs.add(path);
          return success();
        }
        if (binary === '/bin/cp') {
          const [option, from, to] = args;
          assert.equal(option, '-n', 'copies must never replace existing files');
          assert.equal(args.length, 3, 'paths must be separate argv entries');
          if (denied.has(to)) return failure('Disk full');
          if (type(to)) return success(); // macOS cp -n may succeed without copying.
          if (!files.has(from)) return failure('No such file');
          const copied = Buffer.from(files.get(from));
          if (corruptCopies.has(to)) copied[50] ^= 1;
          files.set(to, copied);
          return success();
        }
        if (binary === '/bin/ln') {
          const [, from, to] = args;
          if (type(to) || !files.has(from) || denied.has(to)) return failure('File exists or hard links unavailable');
          files.set(to, files.get(from));
          return success();
        }
        if (binary === '/bin/rm') {
          files.delete(args[1]);
          return success();
        }
        if (binary === '/usr/bin/sips') {
          if (sipsFailure) return failure('Preview failed');
          files.set(args[4], Buffer.from(SMALL_PNG));
          return success();
        }
        throw new Error('Unexpected system tool: ' + binary);
      }
    },
    file: {
      exists(path) { return !!type(resolve(path)); },
      read(path) {
        textReads.push(path);
        const content = files.get(canonical(resolve(path)));
        if (!content) throw new Error('File not found');
        return content.toString('utf8');
      },
      write(path, content) {
        textWrites.push({ path, content });
        const internal = path.startsWith('@data/') || path.startsWith('@tmp/');
        path = canonical(resolve(path));
        if (denied.has(path)) throw new Error('Disk full');
        if (files.has(path) && !internal) throw new Error('IINA refuses overwriting an external path');
        files.set(path, Buffer.from(content));
      },
      delete(path) { files.delete(canonical(resolve(path))); },
      list(path) {
        const prefix = canonical(resolve(path)) + '/';
        return Array.from(files.keys()).filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
          .map(file => ({ filename: file.slice(prefix.length), isDir: false, path: '/untrusted/' + file }));
      },
      handle(path, mode) {
        path = canonical(resolve(path));
        if (!files.has(path)) throw new Error('FileHandle cannot create files');
        let position = 0;
        const object = {
          path, mode, closed: false, reads: [], readAll: false,
          offset() { return position; },
          seekToEnd() { position = files.get(path).length; },
          seekTo(next) { position = next; },
          read(length) {
            object.reads.push(length);
            const limit = readLimits.has(path) ? Math.min(length, readLimits.get(path)) : length;
            const data = files.get(path).subarray(position, position + limit);
            position += data.length;
            return new Uint8Array(data);
          },
          readToEnd() {
            object.readAll = true;
            return object.read(files.get(path).length - position);
          },
          write(bytes) {
            writes.push({ path, length: bytes.length });
            assert.fail('image copies must not use IINA 1.5 legacy FileHandle.write');
          },
          close() { object.closed = true; }
        };
        handles.push(object);
        return object;
      }
    }
  };
  const native = new NativeFiles(api, async () => { delayCalls += 1; });
  return {
    api, native, files, dirs, links, calls, handles, writes, textReads, textWrites, denied, readLimits, corruptCopies,
    setSipsFailure(value) { sipsFailure = value; },
    get delayCalls() { return delayCalls; }
  };
}

test('authorized root and descendants use literal argv paths and reject traversal', async () => {
  const env = fakeApi();
  const root = '/影片/日本語 $(touch secret) `literal`';
  env.dirs.add(root);
  assert.equal(await env.native.prepareOutput(root), root);
  assert.ok(env.dirs.has(root + '/assets'));
  assert.ok(env.dirs.has(root + '/.iina-staging'));
  assert.ok(env.calls.every(call => ['/usr/bin/stat', '/bin/pwd', '/bin/mkdir'].includes(call.binary)));
  assert.ok(env.calls.some(call => call.binary === '/bin/mkdir' && call.args[0] === root + '/assets'));
  for (const relative of ['../escape', '/absolute', 'a/../../b', 'a//b', 'a/./b', 'a\nb', 'a\0b']) {
    assert.throws(() => child(root, relative));
  }
});

test('canonical root preserves a legitimate trailing space in the folder name', async () => {
  const env = fakeApi();
  env.dirs.add('/vault folder ');
  assert.equal(await env.native.canonicalRoot('/vault folder '), '/vault folder ');
});

test('authorized aliases can be resolved once, but later substituted roots are rejected', async () => {
  const env = fakeApi();
  env.links.set('/alias', '/vault');
  assert.equal(await env.native.canonicalRoot('/alias'), '/vault');
  await assert.rejects(env.native.assertRoot('/alias'), /符号链接/);
  env.dirs.add('/elsewhere');
  env.links.set('/vault', '/elsewhere');
  await assert.rejects(env.native.prepareOutput('/vault'), /符号链接/);
});

test('existing symlink directories and symlink output files are refused', async () => {
  const env = fakeApi();
  env.dirs.add('/outside');
  env.links.set('/vault/assets', '/outside');
  await assert.rejects(env.native.prepareOutput('/vault'), /符号链接/);
  assert.ok(!env.calls.some(call => call.binary === '/bin/mkdir' && call.args[0].startsWith('/outside')));
  env.links.delete('/vault/assets');
  await env.native.prepareOutput('/vault');
  env.links.set('/vault/assets/note.png', '/outside/target.png');
  await assert.rejects(env.native.checkedPath('/vault', 'assets/note.png'), /普通文件/);
  env.links.set('/vault/.iina-staging', '/outside');
  await assert.rejects(env.native.checkedPath('/vault', '.iina-staging/note.png'), /子目录/);
});

test('private data initialization, internal overwrite and untrusted list paths follow IINA behavior', async () => {
  const env = fakeApi();
  await env.native.initialize();
  assert.ok(env.dirs.has(DATA + '/exports/IINA'));
  const draft = env.native.privatePath('drafts/capture_123.json');
  env.native.writeText(draft, '{"text":"first"}');
  env.native.writeText(draft, '{"text":"updated"}');
  assert.equal(env.native.read(draft), '{"text":"updated"}');
  assert.deepEqual(env.native.listPrivate('drafts'), ['capture_123.json']);
  env.native.removePrivate('drafts/capture_123.json');
  assert.equal(env.native.exists(draft), false);
});

test('binary screenshot copy uses cp argv and bounded read-only verification without text copying', async () => {
  const env = fakeApi();
  const source = DATA + '/captures/capture_123-1.png';
  const target = '/vault/.iina-staging/capture_123.png.pending';
  const bytes = pngWithPadding(200000);
  env.files.set(source, bytes);
  await env.native.copyBinary(source, target);
  assert.deepEqual(env.files.get(target), bytes);
  assert.deepEqual(env.calls, [{ binary: '/bin/cp', args: ['-n', source, target], cwd: undefined }]);
  assert.equal(env.writes.length, 0);
  assert.equal(env.textReads.length, 0);
  assert.equal(env.textWrites.length, 0);
  assert.equal(env.delayCalls, Math.ceil(bytes.length / (64 * 1024)));
  assert.ok(env.handles.every(handle => handle.mode === 'read'));
  assert.ok(env.handles.every(handle => handle.reads.every(length => length <= 64 * 1024)));
  assert.ok(env.handles.every(handle => handle.closed));
  assert.ok(env.handles.every(handle => !handle.readAll));
  await assert.rejects(env.native.copyBinary(source, target), /拒绝覆盖/);
  assert.equal(env.calls.length, 1, 'an existing target is rejected before invoking cp');
  assert.deepEqual(env.files.get(target), bytes);
});

test('nonzero cp status and corrupted binary copy preserve the source and close opened handles', async () => {
  const env = fakeApi();
  const source = DATA + '/captures/capture_123-1.png';
  const target = '/vault/.iina-staging/capture_123.png.pending';
  env.files.set(source, Buffer.from(SMALL_PNG));
  env.denied.add(target);
  await assert.rejects(env.native.copyBinary(source, target), /文件操作失败.*Disk full/);
  assert.deepEqual(env.files.get(source), SMALL_PNG);
  assert.equal(env.files.has(target), false);
  assert.equal(env.calls[0].binary, '/bin/cp');
  env.denied.delete(target);
  env.corruptCopies.add(target);
  await assert.rejects(env.native.copyBinary(source, target), /校验失败/);
  assert.deepEqual(env.files.get(source), SMALL_PNG);
  assert.ok(env.handles.every(handle => handle.closed));
  assert.ok(env.handles.every(handle => handle.mode === 'read'));
  assert.equal(env.textWrites.length, 0);
});

test('cp -n preserves a target created concurrently and skipped copying is verified', async () => {
  const env = fakeApi();
  const source = DATA + '/captures/capture_123-1.png';
  const target = '/vault/.iina-staging/capture_123.png.pending';
  const existing = Buffer.from(SMALL_PNG);
  existing[50] ^= 1; // PNG structure remains valid, but it is not the captured image.
  env.files.set(source, Buffer.from(SMALL_PNG));
  const exec = env.api.utils.exec;
  env.api.utils.exec = async (binary, args, cwd) => {
    if (binary === '/bin/cp') env.files.set(target, existing);
    return exec(binary, args, cwd);
  };
  await assert.rejects(env.native.copyBinary(source, target), /校验失败/);
  assert.deepEqual(env.calls[0].args, ['-n', source, target]);
  assert.deepEqual(env.files.get(target), existing, 'the competing file was not replaced');
  assert.deepEqual(env.files.get(source), SMALL_PNG);
  assert.ok(env.handles.every(handle => handle.closed && handle.mode === 'read'));
  assert.equal(env.writes.length, 0);
  assert.equal(env.textWrites.length, 0);
});

test('binary comparison rejects mismatched sizes, changed bytes and deceptively equal short reads', async () => {
  const env = fakeApi();
  env.files.set('/a', Buffer.alloc(100, 1));
  env.files.set('/b', Buffer.alloc(99, 1));
  assert.equal(await env.native.equalFiles('/a', '/b'), false);
  const changed = Buffer.alloc(100, 1);
  changed[50] = 2;
  env.files.set('/b', changed);
  assert.equal(await env.native.equalFiles('/a', '/b'), false);
  env.readLimits.set('/a', 4);
  env.readLimits.set('/b', 4);
  assert.equal(await env.native.equalFiles('/a', '/b'), false);
  assert.ok(env.handles.every(handle => handle.closed));
});

test('publication is create-if-absent and failure does not replace an existing Markdown', async () => {
  const env = fakeApi();
  await env.native.prepareOutput('/vault');
  env.files.set('/vault/.iina-staging/capture_123.md.pending', Buffer.from('complete note'));
  const result = await env.native.publishFile('/vault', '.iina-staging/capture_123.md.pending', 'capture_123.md');
  assert.equal(result, '/vault/capture_123.md');
  assert.equal(env.files.get(result).toString(), 'complete note');
  env.files.set('/vault/.iina-staging/capture_123.md.pending', Buffer.from('new text'));
  await assert.rejects(env.native.publishFile('/vault', '.iina-staging/capture_123.md.pending', 'capture_123.md'), /拒绝覆盖/);
  assert.equal(env.files.get(result).toString(), 'complete note');
  assert.deepEqual(env.calls.find(call => call.binary === '/bin/ln').args, ['-h', '/vault/.iina-staging/capture_123.md.pending', '/vault/capture_123.md']);
});

test('staging cleanup is confined to one exact generated filename', async () => {
  const env = fakeApi();
  await env.native.prepareOutput('/vault');
  env.files.set('/vault/.iina-staging/capture_123.png.pending', Buffer.from('temporary'));
  env.files.set('/vault/keep.md', Buffer.from('saved'));
  for (const value of ['../keep.md', 'keep.md', '.iina-staging/../keep.md', '.iina-staging/*']) {
    await env.native.removeStaging('/vault', value);
  }
  assert.equal(env.calls.filter(call => call.binary === '/bin/rm').length, 0);
  await env.native.removeStaging('/vault', '.iina-staging/capture_123.png.pending');
  assert.equal(env.files.has('/vault/.iina-staging/capture_123.png.pending'), false);
  assert.equal(env.files.get('/vault/keep.md').toString(), 'saved');
});

test('small previews use local base64; large images use sips with a separate output', async () => {
  const env = fakeApi();
  await env.native.initialize();
  const source = DATA + '/captures/capture_123-1.png';
  env.files.set(source, Buffer.from(SMALL_PNG));
  assert.equal(await env.native.preview(source, 'capture_123', 1), 'data:image/png;base64,' + SMALL_PNG.toString('base64'));
  assert.equal(env.calls.some(call => call.binary === '/usr/bin/sips'), false);
  const large = pngWithPadding(700000);
  env.files.set(source, large);
  assert.equal(await env.native.preview(source, 'capture_123', 2), 'data:image/png;base64,' + SMALL_PNG.toString('base64'));
  const call = env.calls.find(entry => entry.binary === '/usr/bin/sips');
  assert.deepEqual(call.args, ['-Z', '960', source, '--out', DATA + '/previews/capture_123-2.png']);
  assert.deepEqual(env.files.get(source), large);
  assert.ok(env.handles.every(handle => handle.closed));
  env.setSipsFailure(true);
  assert.equal(await env.native.preview(source, 'capture_123', 3), null);
  assert.equal(await env.native.preview(source, '../escape', 4), null);
  assert.equal(await env.native.preview(source, 'capture_123', 0), null);
});

test('large preview refuses an existing symlink at its generated output path', async () => {
  const env = fakeApi();
  await env.native.initialize();
  const source = DATA + '/captures/capture_123-1.png';
  env.files.set(source, pngWithPadding(700000));
  env.links.set(DATA + '/previews/capture_123-1.png', '/outside/precious.png');
  let refused = false;
  try { refused = await env.native.preview(source, 'capture_123', 1) === null; }
  catch (_) { refused = true; }
  assert.equal(refused, true);
  assert.equal(env.calls.some(call => call.binary === '/usr/bin/sips'), false);
});
