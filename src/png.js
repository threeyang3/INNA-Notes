'use strict';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = 10000;
const MAX_DIMENSION = 131072;
const MAX_PIXELS = 268435456;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function invalid(reason) {
  throw new Error('PNG 截图尚未完整或格式无效：' + reason);
}

function uint32(bytes, offset) {
  return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
}

function readExact(handle, length) {
  const bytes = handle.read(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid('文件被截断。');
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Bounded structural inspection using the official IINA FileHandle API.
 * The caller owns/ closes the handle. Reads at most 17 bytes at a time and seeks
 * over compressed payloads. This verifies IHDR and IEND CRCs, not pixel decoding
 * or IDAT/ancillary CRCs. See https://www.w3.org/TR/png/ (sections 5 and 11.2).
 */
function inspectPng(handle, options) {
  const opts = options || {};
  const maxBytes = opts.maxBytes === undefined ? MAX_BYTES : opts.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('PNG 文件大小限制无效。');
  if (!handle || typeof handle.seekToEnd !== 'function' || typeof handle.offset !== 'function' ||
      typeof handle.seekTo !== 'function' || typeof handle.read !== 'function') {
    throw new Error('需要可读取的 IINA FileHandle。');
  }
  handle.seekToEnd();
  const size = handle.offset();
  if (!Number.isSafeInteger(size) || size < 58) invalid('文件过短。');
  if (size > maxBytes) invalid('文件超过允许的大小。');
  handle.seekTo(0);
  const signature = readExact(handle, 8);
  if (PNG_SIGNATURE.some((byte, index) => signature[index] !== byte)) invalid('文件签名不匹配。');

  let position = 8;
  let count = 0;
  let width;
  let height;
  let color;
  let depth;
  let sawPalette = false;
  let sawData = false;
  let sawNonemptyData = false;
  let dataEnded = false;
  while (position < size && count < MAX_CHUNKS) {
    count += 1;
    if (size - position < 12) invalid('数据块头或校验码缺失。');
    handle.seekTo(position);
    const header = readExact(handle, 8);
    const length = uint32(header, 0);
    if (length > 0x7fffffff || length > size - position - 12) invalid('数据块长度越界。');
    let type = '';
    for (let index = 4; index < 8; index += 1) {
      const byte = header[index];
      if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) invalid('数据块名称无效。');
      type += String.fromCharCode(byte);
    }
    if (header[6] < 65 || header[6] > 90) invalid('数据块保留位无效。');
    const next = position + length + 12;
    if (count === 1 && type !== 'IHDR') invalid('缺少首个 IHDR 数据块。');
    if (type === 'IHDR') {
      if (count !== 1 || length !== 13) invalid('IHDR 必须唯一且长度为 13。');
      const data = readExact(handle, 17);
      const crcInput = new Uint8Array(17);
      crcInput.set(header.subarray(4), 0);
      crcInput.set(data.subarray(0, 13), 4);
      if (crc32(crcInput) !== uint32(data, 13)) invalid('IHDR 校验失败。');
      width = uint32(data, 0);
      height = uint32(data, 4);
      depth = data[8];
      color = data[9];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
        invalid('图像尺寸无效或超过支持上限。');
      }
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowedDepths[color] || allowedDepths[color].indexOf(depth) < 0) invalid('色彩类型与位深不兼容。');
      if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) invalid('压缩、滤波或隔行设置无效。');
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || color === 0 || color === 4 || length < 3 || length > 768 || length % 3 !== 0) {
        invalid('调色板数据块无效。');
      }
      if (color === 3 && length / 3 > Math.pow(2, depth)) invalid('调色板大于位深允许的范围。');
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !sawPalette)) invalid('图像数据块顺序无效。');
      sawData = true;
      if (length > 0) sawNonemptyData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !sawNonemptyData || next !== size) invalid('缺少有效图像数据或末尾 IEND。');
      const checksum = readExact(handle, 4);
      if (uint32(checksum, 0) !== 0xae426082) invalid('IEND 校验失败。');
      return { size, width, height };
    } else {
      if (header[4] >= 65 && header[4] <= 90) invalid('存在无法识别的关键数据块。');
      if (sawData) dataEnded = true;
    }
    position = next;
  }
  if (count >= MAX_CHUNKS) invalid('数据块数量过多。');
  invalid('缺少完整的 IEND。');
}

/** Small UI previews only; export/copy paths must remain binary. */
function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('预览数据必须是 Uint8Array。');
  if (bytes.length > MAX_PREVIEW_BYTES) throw new Error('截图超过 2 MiB，跳过内嵌预览。');
  const chunks = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    chunk += BASE64[first >>> 2] + BASE64[((first & 3) << 4) | (second >>> 4)] +
      (hasSecond ? BASE64[((second & 15) << 2) | (third >>> 6)] : '=') +
      (hasThird ? BASE64[third & 63] : '=');
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join('');
}

module.exports = { inspectPng, bytesToBase64 };
