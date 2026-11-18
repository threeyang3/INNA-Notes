'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timers } = require('../src/timers');
const { NativeFiles } = require('../src/native');

function nativeClock() {
  let sequence = 0;
  const pending = new Map();
  const order = [];
  return {
    pending, order,
    set(callback, milliseconds) {
      const id = 'timer-' + (++sequence);
      pending.set(id, { callback, milliseconds });
      order.push(['set', id]);
      return id;
    },
    clear(id) { order.push(['clear', id]); pending.delete(id); },
    fire(id) {
      const timer = pending.get(id);
      // Mirrors IINA 1.5: merely firing the callback does not remove its entry.
      if (timer) timer.callback();
    }
  };
}

function environment() {
  const native = nativeClock();
  const timers = new Timers(native.set.bind(native), native.clear.bind(native));
  return { native, timers };
}

function isCancelled(error) { return error && error.code === 'IINA_VIDEO_NOTES_CANCELLED'; }

test('completed timer releases IINA’s native callback before running application code', () => {
  const { native, timers } = environment();
  let calls = 0;
  const id = timers.set(() => {
    calls += 1;
    assert.equal(native.pending.has(id), false);
    assert.equal(timers.ids.has(id), false);
    native.order.push(['callback', id]);
  }, 20);
  native.fire(id);
  native.fire(id);
  assert.equal(calls, 1);
  assert.deepEqual(native.order, [['set', id], ['clear', id], ['callback', id]]);
});

test('successful delay clears its cancellation bookkeeping and resolves once', async () => {
  const { native, timers } = environment();
  let completed = 0;
  const promise = timers.delay(0).then(() => { completed += 1; });
  const id = Array.from(native.pending.keys())[0];
  assert.equal(timers.waiters.size, 1);
  native.fire(id);
  await promise;
  assert.equal(completed, 1);
  assert.equal(timers.waiters.size, 0);
  assert.equal(timers.ids.size, 0);
  assert.equal(native.pending.size, 0);
});

test('clearing one awaited delay rejects it, allowing its finally block to finish', async () => {
  const { native, timers } = environment();
  let cleaned = false;
  const promise = timers.delay(100).finally(() => { cleaned = true; });
  const rejected = assert.rejects(promise, isCancelled);
  const id = Array.from(native.pending.keys())[0];
  timers.clear(id);
  await rejected;
  assert.equal(cleaned, true);
  assert.equal(timers.waiters.size, 0);
  assert.equal(native.pending.size, 0);
  timers.clear(id);
  assert.equal(timers.waiters.size, 0);
});

test('permanent stop settles all waiters and does not schedule new work', async () => {
  const { native, timers } = environment();
  const first = assert.rejects(timers.delay(5), isCancelled);
  const second = assert.rejects(timers.delay(10), isCancelled);
  let callbackRan = false;
  timers.set(() => { callbackRan = true; }, 15);
  timers.stop();
  await Promise.all([first, second]);
  assert.equal(native.pending.size, 0);
  assert.equal(timers.ids.size, 0);
  assert.equal(timers.waiters.size, 0);
  assert.equal(callbackRan, false);
  const scheduled = native.order.filter(entry => entry[0] === 'set').length;
  assert.equal(timers.set(() => {}, 0), null);
  await assert.rejects(timers.delay(0), isCancelled);
  timers.stop();
  assert.equal(native.order.filter(entry => entry[0] === 'set').length, scheduled);
});

test('cancelling NativeFiles.equalFiles while it yields closes both read handles', async () => {
  const { native, timers } = environment();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const bytes = new Map([['/data/source.png', png], ['/data/target.png', Buffer.from(png)]]);
  const handles = [];
  const resolve = filename => filename.replace(/^@data\//, '/data/');
  const api = {
    utils: { resolvePath() { return '/data'; } },
    file: {
      handle(filename, mode) {
        assert.equal(mode, 'read');
        filename = resolve(filename);
        if (!bytes.has(filename)) throw new Error('FileHandle requires an existing file');
        let offset = 0;
        const handle = {
          mode, filename, closed: false,
          offset() { return offset; },
          seekToEnd() { offset = bytes.get(filename).length; },
          seekTo(position) { offset = position; },
          read(length) {
            const value = bytes.get(filename).subarray(offset, offset + length);
            offset += value.length;
            return new Uint8Array(value);
          },
          close() { handle.closed = true; }
        };
        handles.push(handle);
        return handle;
      }
    }
  };
  const files = new NativeFiles(api, milliseconds => timers.delay(milliseconds));
  const comparing = files.equalFiles('/data/source.png', '/data/target.png');
  const rejected = assert.rejects(comparing, isCancelled);
  assert.equal(native.pending.size, 1, 'comparison has yielded between binary chunks');
  assert.equal(handles.filter(handle => !handle.closed).length, 2, 'both read handles are open while waiting');
  timers.stop();
  await rejected;
  assert.ok(handles.every(handle => handle.closed), 'finally closed source and destination');
  assert.equal(native.pending.size, 0);
  assert.equal(timers.waiters.size, 0);
  assert.deepEqual(bytes.get('/data/source.png'), png, 'the video capture source is preserved');
  assert.deepEqual(bytes.get('/data/target.png'), png, 'verification never writes to the destination');
});
