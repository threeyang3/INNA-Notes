'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshot, isoLocal } = require('../src/capture');

function status(changes) {
  return Object.assign({
    path: '/Users/杨/日本語 clip #1.mkv',
    url: 'file:///Users/杨/日本語 clip #1.mkv',
    title: '日本語 clip #1',
    idle: false,
    isNetworkResource: false,
    position: 1938.1234,
    duration: 7200,
    paused: false
  }, changes);
}

function options(changes) {
  return Object.assign({ id: 'capture_123456789', now: new Date('2026-11-18T12:00:01.234Z') }, changes);
}

test('local MKV, MP4 and MOV snapshots record genuine immutable capture values', () => {
  for (const extension of ['mkv', 'mp4', 'mov']) {
    const live = status({ path: '/tmp/映画.' + extension, url: 'file:///tmp/映画.' + extension });
    const record = createSnapshot(live, options());
    assert.equal(record.captureId, 'capture_123456789');
    assert.equal(record.positionMs, 1938123);
    assert.equal(record.durationMs, 7200000);
    assert.equal(record.sourcePath, '/tmp/映画.' + extension);
    assert.equal(record.sourceUri, 'file:///tmp/%E6%98%A0%E7%94%BB.' + extension);
    assert.equal(Date.parse(record.capturedAt), Date.parse('2026-11-18T12:00:01.234Z'));
    assert.equal(Object.isFrozen(record), true);
    live.position = 3500;
    live.path = '/tmp/another.mp4';
    live.title = 'another title';
    assert.equal(record.positionMs, 1938123);
    assert.equal(record.videoTitle, '日本語 clip #1');
    assert.throws(() => { record.positionMs = 3500000; }, TypeError);
  }
});

test('playing and pre-paused capture states are recorded without issuing playback commands', () => {
  assert.equal(createSnapshot(status({ paused: false }), options()).wasPaused, false);
  assert.equal(createSnapshot(status({ paused: true, position: 0 }), options()).wasPaused, true);
  assert.equal(createSnapshot(status({ position: 0 }), options()).positionMs, 0);
  assert.equal(createSnapshot(status({ position: 1.9999 }), options()).positionMs, 2000);
});

test('idle, file transitions and incomplete state never become a successful capture', () => {
  assert.throws(() => createSnapshot(null, options()));
  assert.throws(() => createSnapshot(status(), options({ loading: true })));
  for (const change of [
    { idle: true }, { idle: undefined }, { position: undefined }, { position: NaN },
    { position: Infinity }, { position: -1 }, { position: '1.2' },
    { position: Number.MAX_SAFE_INTEGER }, { paused: undefined },
    { title: '' }, { title: null }, { path: undefined }, { path: 'relative.mp4' },
    { path: '/' }, { url: '' }, { isNetworkResource: undefined }
  ]) assert.throws(() => createSnapshot(status(change), options()), JSON.stringify(change));
});

test('network sources and secrets are rejected before a draft can be created', () => {
  for (const change of [
    { isNetworkResource: true },
    { url: 'https://host/video.mp4?access_token=secret', path: 'https://host/video.mp4?access_token=secret' },
    { url: 'https://host/video.mp4?access_token=secret' },
    { url: 'smb://host/video.mp4' },
    { url: 'file://host/video.mp4' }
  ]) assert.throws(() => createSnapshot(status(change), options()));
});

test('unknown or unavailable duration is omitted, never replaced with a fake total', () => {
  for (const duration of [undefined, null, 0, -1, NaN, Infinity, '7200']) {
    const record = createSnapshot(status({ duration }), options());
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'durationMs'), false);
  }
});

test('IINA decoded file URLs never cause literal percent sequences to be decoded twice', () => {
  const record = createSnapshot(status({ path: '/tmp/片名%20%2f%3f.mkv', url: 'file:///tmp/片名%20%2f%3f.mkv' }), options());
  assert.equal(record.sourcePath, '/tmp/片名%20%2f%3f.mkv');
  assert.equal(record.sourceUri, 'file:///tmp/%E7%89%87%E5%90%8D%2520%252f%253f.mkv');
  assert.throws(() => createSnapshot(status({ path: undefined }), options()));
});

test('capture time includes the real local timezone offset and preserves milliseconds', () => {
  const date = new Date('2026-11-18T12:00:01.234Z');
  const local = isoLocal(date);
  assert.match(local, /^2026-11-\d\dT\d\d:\d\d:\d\d\.234[+-]\d\d:\d\d$/);
  assert.equal(Date.parse(local), date.getTime());
  assert.throws(() => isoLocal(new Date(NaN)));
  assert.throws(() => isoLocal('2026-11-18'));
  assert.throws(() => createSnapshot(status(), options({ id: 'bad/id' })));
});

test('two player snapshots cannot share or mutate each other’s source state', () => {
  const first = createSnapshot(status(), options());
  const second = createSnapshot(status({ path: '/tmp/second.mp4', url: 'file:///tmp/second.mp4', position: 7.5 }), options({ id: 'capture_second123' }));
  assert.notEqual(first.captureId, second.captureId);
  assert.notEqual(first.sourceUri, second.sourceUri);
  assert.equal(first.positionMs, 1938123);
  assert.equal(second.positionMs, 7500);
});
