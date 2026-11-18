'use strict';

const PROTOCOL = 'media-video-capture/v1';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,100}$/;

function isCaptureId(value) {
  // In JavaScript, `$` can match before a final newline; require the whole match.
  const match = typeof value === 'string' ? ID_PATTERN.exec(value) : null;
  return !!match && match[0] === value;
}

function fail(message) {
  throw new Error(message);
}

/** POSIX path validation. Never interpret a backslash, percent sign, or shell syntax. */
function normalizeAbsolutePath(value) {
  if (typeof value !== 'string' || value[0] !== '/' || /[\u0000\r\n]/.test(value)) {
    fail('需要有效的绝对本地路径（不含空字符或换行）。');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) fail('路径不能包含上级目录跳转。');
  const normalized = '/' + segments.filter(segment => segment !== '' && segment !== '.').join('/');
  return normalized;
}

function encodePathSegment(segment) {
  // encodeURIComponent leaves these characters unescaped; encode them for a portable URI.
  return encodeURIComponent(segment).replace(/[!'()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function toFileUri(path) {
  const normalized = normalizeAbsolutePath(path);
  return 'file://' + normalized.split('/').map(encodePathSegment).join('/');
}

/** For standard, encoded file URIs only. IINA core.status.url is already decoded. */
function fromLocalSource(source) {
  if (typeof source !== 'string' || !source) fail('没有有效的本地视频来源。');
  let path;
  if (source[0] === '/') {
    path = source;
  } else {
    const match = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(source);
    if (!match) fail('仅支持本地文件，不接受网络、查询参数或远程主机来源。');
    // Encoded separators must not introduce hidden path segments or traversal.
    if (/%2f/i.test(match[1])) fail('文件 URI 包含编码的目录分隔符。');
    try {
      path = decodeURIComponent(match[1]);
    } catch (_) {
      fail('本地文件 URI 编码无效。');
    }
  }
  path = normalizeAbsolutePath(path);
  if (path === '/') fail('视频来源必须指向文件。');
  return { sourcePath: path, sourceUri: toFileUri(path) };
}

function validMilliseconds(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || parts[0] !== value) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hours = Number(parts[4]);
  const minutes = Number(parts[5]);
  const seconds = Number(parts[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hours > 23 || minutes > 59 || seconds > 59) return false;
  if (parts[8] !== 'Z') {
    const offset = parts[8].slice(1).split(':').map(Number);
    if (offset[0] > 23 || offset[1] > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') fail('捕获记录无效。');
  if (!isCaptureId(snapshot.captureId)) fail('捕获 ID 无效。');
  if (!isValidTimestamp(snapshot.capturedAt)) fail('捕获时间无效。');
  if (typeof snapshot.videoTitle !== 'string' || !snapshot.videoTitle.trim()) fail('视频标题尚未就绪。');
  if (!validMilliseconds(snapshot.positionMs)) fail('视频位置必须是非负整数毫秒。');
  if (snapshot.durationMs !== undefined && (!validMilliseconds(snapshot.durationMs) || snapshot.durationMs === 0)) {
    fail('视频总时长必须是正整数毫秒，未知时应省略。');
  }
  if (typeof snapshot.wasPaused !== 'boolean') fail('捕获时的播放状态无效。');
  const path = normalizeAbsolutePath(snapshot.sourcePath);
  if (path === '/' || path !== snapshot.sourcePath || toFileUri(path) !== snapshot.sourceUri) {
    fail('视频路径与来源 URI 不一致。');
  }
  return snapshot;
}

function yamlString(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function serializeCapture(snapshot, options) {
  validateSnapshot(snapshot);
  const opts = options || {};
  const text = opts.text === undefined ? '' : opts.text;
  if (typeof text !== 'string') fail('笔记正文必须是文字。');
  if (opts.includeSourcePath !== undefined && typeof opts.includeSourcePath !== 'boolean') {
    fail('来源隐私选项无效。');
  }
  const image = opts.imageRelativePath;
  if (image !== undefined && image !== 'assets/' + snapshot.captureId + '.png') {
    fail('截图引用必须指向本条捕获的 assets PNG 文件。');
  }
  if (!image && !text.trim()) fail('请填写文字或保留一张有效截图。');
  const fields = [
    'capture_protocol: ' + PROTOCOL,
    'capture_id: ' + yamlString(snapshot.captureId),
    'capture_player: iina',
    'captured_at: ' + yamlString(snapshot.capturedAt),
    'video_title: ' + yamlString(snapshot.videoTitle),
    'video_position_ms: ' + snapshot.positionMs
  ];
  if (snapshot.durationMs !== undefined) fields.push('video_duration_ms: ' + snapshot.durationMs);
  fields.push('video_was_paused: ' + snapshot.wasPaused);
  if (opts.includeSourcePath !== false) {
    fields.push('video_source_uri: ' + yamlString(snapshot.sourceUri));
  } else {
    fields.push('video_source_redacted: true');
  }
  if (image) fields.push('capture_image: ' + yamlString(image));
  let body = image ? '![](' + image + ')' + (text ? '\n\n' : '') : '';
  body += text;
  return '---\n' + fields.join('\n') + '\n---\n\n' + body + (body.endsWith('\n') ? '' : '\n');
}

function formatPosition(milliseconds) {
  if (!validMilliseconds(milliseconds)) fail('视频位置必须是非负整数毫秒。');
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const remainder = milliseconds % 1000;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' +
    String(seconds).padStart(2, '0') + '.' + String(remainder).padStart(3, '0');
}

module.exports = {
  PROTOCOL,
  isCaptureId,
  normalizeAbsolutePath,
  toFileUri,
  fromLocalSource,
  validateSnapshot,
  serializeCapture,
  formatPosition
};
