'use strict';

const { isCaptureId, normalizeAbsolutePath, toFileUri, validateSnapshot } = require('./protocol');

function isoLocal(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('捕获日期无效。');
  const year = date.getFullYear();
  if (year < 0 || year > 9999) throw new Error('捕获日期超出支持范围。');
  const pad = (value, count) => String(value).padStart(count || 2, '0');
  const offset = -date.getTimezoneOffset();
  const absolute = Math.abs(offset);
  return pad(year, 4) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' +
    pad(date.getMilliseconds(), 3) + (offset >= 0 ? '+' : '-') +
    pad(Math.floor(absolute / 60)) + ':' + pad(absolute % 60);
}

function milliseconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const value = Math.round(seconds * 1000);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Freeze genuine playback state at trigger time. status.path must be the literal
 * absolute mpv `path`; IINA 1.5 core.status.url has already been percent-decoded.
 * The adapter reads mpv `time-pos` and verifies source stability before/after this.
 */
function createSnapshot(status, options) {
  const opts = options || {};
  if (opts.loading || !status || status.idle !== false) throw new Error('请先载入视频，等待文件切换完成。');
  if (status.isNetworkResource !== false || typeof status.url !== 'string' || !/^file:\/\/(?:localhost)?\//i.test(status.url)) {
    throw new Error('本轮只支持已经载入的本地视频文件。');
  }
  if (typeof status.title !== 'string' || !status.title.trim() || typeof status.paused !== 'boolean') {
    throw new Error('播放器状态尚未就绪，请稍后重试。');
  }
  if (!isCaptureId(opts.id)) throw new Error('无法生成有效的捕获 ID。');
  // Missing paths are not recovered by guessing from a title or the decoded URL.
  const sourcePath = normalizeAbsolutePath(status.path);
  if (sourcePath === '/') throw new Error('当前来源不是视频文件。');
  const positionMs = milliseconds(status.position);
  if (positionMs === undefined) throw new Error('无法读取有效的当前播放时间。');
  const snapshot = {
    captureId: opts.id,
    capturedAt: isoLocal(opts.now === undefined ? new Date() : opts.now),
    videoTitle: status.title,
    positionMs,
    sourceUri: toFileUri(sourcePath),
    sourcePath,
    wasPaused: status.paused
  };
  const durationMs = milliseconds(status.duration);
  if (durationMs !== undefined && durationMs > 0) snapshot.durationMs = durationMs;
  validateSnapshot(snapshot);
  return Object.freeze(snapshot);
}

module.exports = { createSnapshot, isoLocal };
