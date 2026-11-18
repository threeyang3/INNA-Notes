'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { inspectPng, bytesToBase64 } = require('../src/png');

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Test fixtures stay compatible with Node 20, before node:zlib.crc32 existed.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

function header(changes = {}) {
  const properties = Object.assign({ width: 1, height: 1, depth: 8, color: 6, compression: 0, filter: 0, interlace: 0 }, changes);
  const data = Buffer.alloc(13);
  data.writeUInt32BE(properties.width, 0);
  data.writeUInt32BE(properties.height, 4);
  data[8] = properties.depth;
  data[9] = properties.color;
  data[10] = properties.compression;
  data[11] = properties.filter;
  data[12] = properties.interlace;
  return chunk('IHDR', data);
}

function png(parts = [header(), chunk('IDAT', deflateSync(Buffer.from([0, 255, 64, 16, 255]))), chunk('IEND')]) {
  return Buffer.concat([signature].concat(parts));
}

function handle(bytes, reportedSize) {
  let position = 0;
  return {
    reads: [], closed: false,
    seekToEnd() { position = reportedSize === undefined ? bytes.length : reportedSize; },
    offset() { return position; },
    seekTo(next) { position = next; },
    read(length) {
      this.reads.push({ position, length });
      const data = bytes.subarray(position, position + length);
      position += data.length;
      return new Uint8Array(data);
    },
    close() { this.closed = true; }
  };
}

test('valid screenshot PNG is checked without full-file reads or taking ownership of its handle', () => {
  const bytes = png();
  const file = handle(bytes);
  assert.deepEqual(inspectPng(file), { size: bytes.length, width: 1, height: 1 });
  assert.equal(file.closed, false);
  assert.ok(file.reads.every(read => read.length <= 17));
  assert.ok(!file.reads.some(read => read.position === 41));
});

test('PNG capture rejects missing/truncated completion, a false signature and trailing data', () => {
  const bytes = png();
  const falseSignature = Buffer.from(bytes);
  falseSignature[1] = 0;
  for (const broken of [
    bytes.subarray(0, 7), bytes.subarray(0, 30), bytes.subarray(0, bytes.length - 1),
    bytes.subarray(0, bytes.length - 12), falseSignature, Buffer.concat([bytes, Buffer.from([0])])
  ]) assert.throws(() => inspectPng(handle(broken)));
});

test('nonempty IDAT data is required; consecutive IDAT chunks can include empty chunks', () => {
  assert.throws(() => inspectPng(handle(png([header(), chunk('IDAT'), chunk('IEND')]))));
  const bytes = png([header(), chunk('IDAT'), chunk('IDAT', Buffer.from([1])), chunk('IDAT'), chunk('IEND')]);
  assert.equal(inspectPng(handle(bytes)).width, 1);
  assert.throws(() => inspectPng(handle(png([header(), chunk('IDAT', Buffer.from([1])), chunk('tEXt'), chunk('IDAT', Buffer.from([2])), chunk('IEND')]))));
});

test('IHDR and IEND CRCs must be correct, with a unique first 13-byte IHDR', () => {
  const badHeader = header();
  badHeader[24] ^= 1;
  const badEnd = chunk('IEND');
  badEnd[11] ^= 1;
  for (const parts of [
    [badHeader, chunk('IDAT', Buffer.from([1])), chunk('IEND')],
    [header(), chunk('IDAT', Buffer.from([1])), badEnd],
    [chunk('tEXt'), header(), chunk('IDAT', Buffer.from([1])), chunk('IEND')],
    [header(), header(), chunk('IDAT', Buffer.from([1])), chunk('IEND')],
    [chunk('IHDR', Buffer.alloc(12)), chunk('IDAT', Buffer.from([1])), chunk('IEND')],
    [header(), chunk('IDAT', Buffer.from([1])), chunk('IEND', Buffer.from([0]))]
  ]) assert.throws(() => inspectPng(handle(png(parts))));
});

test('IHDR validates dimensions, bit-depth/color combinations, compression and interlace', () => {
  for (const change of [
    { width: 0 }, { height: 0 }, { width: 131073 }, { width: 32768, height: 32768 },
    { depth: 3 }, { color: 1 }, { color: 2, depth: 4 }, { color: 3, depth: 16 },
    { compression: 1 }, { filter: 1 }, { interlace: 2 }
  ]) assert.throws(() => inspectPng(handle(png([header(change), chunk('IDAT', Buffer.from([1])), chunk('IEND')]))), JSON.stringify(change));
  for (const color of [0, 2, 4, 6]) {
    for (const depth of [8, 16]) {
      assert.equal(inspectPng(handle(png([header({ color, depth, interlace: 1 }), chunk('IDAT', Buffer.from([1])), chunk('IEND')]))).height, 1);
    }
  }
});

test('indexed images require a suitable unique PLTE before IDAT', () => {
  const imageData = chunk('IDAT', Buffer.from([1]));
  const palette = chunk('PLTE', Buffer.from([255, 0, 0]));
  assert.equal(inspectPng(handle(png([header({ color: 3, depth: 1 }), palette, imageData, chunk('IEND')]))).width, 1);
  for (const parts of [
    [header({ color: 3 }), imageData, chunk('IEND')],
    [header({ color: 3, depth: 1 }), chunk('PLTE', Buffer.alloc(9)), imageData, chunk('IEND')],
    [header({ color: 3 }), chunk('PLTE', Buffer.alloc(4)), imageData, chunk('IEND')],
    [header({ color: 3 }), palette, palette, imageData, chunk('IEND')],
    [header({ color: 0 }), palette, imageData, chunk('IEND')],
    [header(), imageData, palette, chunk('IEND')]
  ]) assert.throws(() => inspectPng(handle(png(parts))));
});

test('oversized files, unsafe chunk lengths and invalid handles fail before big reads', () => {
  const bytes = png();
  const large = handle(bytes, 128 * 1024 * 1024 + 1);
  assert.throws(() => inspectPng(large));
  assert.deepEqual(large.reads, []);
  assert.throws(() => inspectPng(handle(bytes), { maxBytes: bytes.length - 1 }));
  assert.equal(inspectPng(handle(bytes), { maxBytes: bytes.length }).size, bytes.length);
  assert.throws(() => inspectPng(handle(bytes), { maxBytes: NaN }));
  assert.throws(() => inspectPng({}));
  const hugeChunk = Buffer.from(bytes);
  hugeChunk.writeUInt32BE(0x7fffffff, 33);
  const invalidChunk = Buffer.from(bytes);
  invalidChunk.writeUInt32BE(0xffffffff, 33);
  const badName = Buffer.from(bytes);
  badName[37] = 0;
  for (const corrupt of [hugeChunk, invalidChunk, badName]) assert.throws(() => inspectPng(handle(corrupt)));
  assert.throws(() => inspectPng(handle(bytes, bytes.length + 10)));
});

test('hostile numbers of small chunks have a finite inspection budget', () => {
  const parts = [header()];
  for (let index = 0; index < 10000; index += 1) parts.push(chunk('tEXt'));
  parts.push(chunk('IDAT', Buffer.from([1])), chunk('IEND'));
  const file = handle(png(parts));
  assert.throws(() => inspectPng(file), /数量/);
  assert.ok(file.reads.length <= 10002);
});

test('base64 output matches known padding cases and independent Node encoding', () => {
  for (const [text, expected] of [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']]) {
    assert.equal(bytesToBase64(new Uint8Array(Buffer.from(text))), expected);
  }
  for (const length of [1, 2, 3, 4, 255, 256, 257, 16383, 16384, 16385]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
  assert.throws(() => bytesToBase64([1, 2, 3]));
  assert.throws(() => bytesToBase64(new Uint8Array(2 * 1024 * 1024 + 1)), /2 MiB/);
});
