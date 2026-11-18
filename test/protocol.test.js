'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROTOCOL, isCaptureId, normalizeAbsolutePath, toFileUri, fromLocalSource,
  validateSnapshot, serializeCapture, formatPosition
} = require('../src/protocol');

function snapshot(changes) {
  const path = '/Users/测试/映像「夜」 100% #1?.mkv';
  return Object.assign({
    captureId: 'capture_123456789',
    capturedAt: '2026-11-18T20:00:01.234+08:00',
    videoTitle: '映像「夜」 #1',
    positionMs: 1938123,
    durationMs: 7200000,
    sourcePath: path,
    sourceUri: toFileUri(path),
    wasPaused: false
  }, changes);
}

function fields(markdown) {
  assert.ok(markdown.startsWith('---\n'));
  const result = {};
  for (const line of markdown.slice(4, markdown.indexOf('\n---\n', 4)).split('\n')) {
    const colon = line.indexOf(':');
    const value = line.slice(colon + 2);
    result[line.slice(0, colon)] = value[0] === '"' ? JSON.parse(value) : value;
  }
  return result;
}

test('protocol exports one self-contained Markdown capture with a relative PNG', () => {
  const record = snapshot();
  const md = serializeCapture(record, { text: '这一幕让我想起海边。\n\n**保留 Markdown。**', imageRelativePath: 'assets/' + record.captureId + '.png' });
  const yaml = fields(md);
  assert.equal(yaml.capture_protocol, PROTOCOL);
  assert.equal(yaml.capture_id, record.captureId);
  assert.equal(yaml.capture_player, 'iina');
  assert.equal(yaml.captured_at, record.capturedAt);
  assert.equal(yaml.video_position_ms, '1938123');
  assert.equal(yaml.video_duration_ms, '7200000');
  assert.equal(yaml.video_source_uri, record.sourceUri);
  assert.equal(yaml.video_was_paused, 'false');
  assert.equal(yaml.capture_image, 'assets/capture_123456789.png');
  assert.ok(md.endsWith('![](assets/capture_123456789.png)\n\n这一幕让我想起海边。\n\n**保留 Markdown。**\n'));
  assert.ok(!md.includes('work_uid'));
  assert.ok(!md.includes('version_id'));
});

test('privacy mode omits the complete path without inventing a source URI', () => {
  const md = serializeCapture(snapshot(), { text: '文字笔记', includeSourcePath: false });
  assert.equal(fields(md).video_source_redacted, 'true');
  assert.ok(!md.includes('video_source_uri:'));
  assert.ok(!md.includes('/Users/'));
  assert.ok(!md.includes('file:///'));
  assert.ok(!md.includes('capture_image:'));
});

test('unknown duration is absent, while image-only and text-only notes are supported', () => {
  const record = snapshot({ durationMs: undefined });
  const imageOnly = serializeCapture(record, { imageRelativePath: 'assets/' + record.captureId + '.png' });
  assert.ok(!imageOnly.includes('video_duration_ms:'));
  assert.ok(imageOnly.endsWith('![](assets/capture_123456789.png)\n'));
  const textOnly = serializeCapture(record, { text: '---\n这是正文，而不是 frontmatter。' });
  assert.ok(textOnly.endsWith('---\n这是正文，而不是 frontmatter。\n'));
  assert.ok(!textOnly.includes('capture_image:'));
  assert.throws(() => serializeCapture(record, { text: ' \n\t' }), /文字或/);
});

test('YAML strings round-trip quotes, colon, hash, newlines, NEL and JS template syntax', () => {
  const title = '"quoted": #tag\n---\nback\\slash ` ${danger} \u0085 \u2028 \u2029 \ufeff';
  const md = serializeCapture(snapshot({ videoTitle: title }), { text: '`literal ${body}`\n[台词](relative.md)' });
  assert.equal(fields(md).video_title, title);
  assert.ok(md.includes('\\n---\\n'));
  assert.ok(md.includes('\\u0085'));
  assert.ok(md.includes('\\u2028'));
  assert.ok(md.includes('\\u2029'));
  assert.ok(!md.includes('\u0085'));
  assert.ok(md.endsWith('`literal ${body}`\n[台词](relative.md)\n'));
});

test('Unicode, reserved punctuation and a literal percent are encoded exactly once', () => {
  const path = '/Users/杨/映画 日本語/[01] #1? 100% "quote" !()*\'\\.mp4';
  const uri = toFileUri(path);
  assert.equal(uri, 'file:///Users/%E6%9D%A8/%E6%98%A0%E7%94%BB%20%E6%97%A5%E6%9C%AC%E8%AA%9E/%5B01%5D%20%231%3F%20100%25%20%22quote%22%20%21%28%29%2A%27%5C.mp4');
  assert.deepEqual(fromLocalSource(uri), { sourcePath: path, sourceUri: uri });
  assert.deepEqual(fromLocalSource(path), { sourcePath: path, sourceUri: uri });
  assert.equal(fromLocalSource('file://localhost/Users/test/video.mov').sourceUri, 'file:///Users/test/video.mov');
  assert.equal(toFileUri('/tmp/a%20b.mkv'), 'file:///tmp/a%2520b.mkv');
});

test('paths and source URIs cannot smuggle directory traversal, remote hosts or tokens', () => {
  for (const path of ['relative/file.mp4', '~/file.mp4', '/a/../secret', '/a/\u0000x', '/a/\nx', '/a/\rx']) {
    assert.throws(() => normalizeAbsolutePath(path));
  }
  assert.equal(normalizeAbsolutePath('//a///./b/'), '/a/b');
  assert.equal(normalizeAbsolutePath('/a/\\b'), '/a/\\b');
  for (const source of [
    'https://host/video.mp4?token=secret', 'smb://host/video.mp4', 'file://host/clip.mkv',
    'file:///tmp/video.mp4?token=secret', 'file:///tmp/video.mp4#fragment',
    'file:///tmp/%2e%2e/secret', 'file:///tmp/a%2f..%2fsecret', 'file:///tmp/%00secret',
    'file:///tmp/%not-encoded', 'file:relative.mp4', 'file:///'
  ]) assert.throws(() => fromLocalSource(source), source);
});

test('export rejects foreign image names, invalid types and corrupted snapshots', () => {
  for (const path of ['../escape.png', 'assets/other_id.png', '/tmp/capture.png', 'assets/capture_123456789.jpg', 'https://host/image.png', 'assets/a)![x](bad.png']) {
    assert.throws(() => serializeCapture(snapshot(), { text: 'note', imageRelativePath: path }));
  }
  for (const change of [
    { captureId: '../capture' }, { capturedAt: '2026-02-31T10:00:00+08:00' },
    { capturedAt: '2026-11-18T24:00:00+08:00' }, { capturedAt: '2026-11-18' },
    { capturedAt: '2026-11-18T10:00:00+08:00\n' },
    { positionMs: -1 }, { positionMs: 0.2 }, { positionMs: NaN },
    { durationMs: 0 }, { durationMs: Infinity }, { wasPaused: undefined },
    { sourceUri: 'https://secret/clip.mp4' }, { sourcePath: '/a/../clip.mp4' }, { videoTitle: ' ' }
  ]) assert.throws(() => validateSnapshot(snapshot(change)), JSON.stringify(change));
  assert.throws(() => serializeCapture(snapshot(), { text: {} }));
  assert.throws(() => serializeCapture(snapshot(), { text: 'note', includeSourcePath: 'false' }));
});

test('IDs and integer millisecond display are stable and do not wrap after 24 hours', () => {
  for (const id of ['capture_123', 'a1234567', '12345678', 'x'.repeat(101)]) assert.equal(isCaptureId(id), true);
  for (const id of ['', 'short', '../escape', 'a'.repeat(102), 'a1234567\n', 'a1234567\r\n', undefined]) assert.equal(isCaptureId(id), false);
  assert.equal(formatPosition(0), '00:00:00.000');
  assert.equal(formatPosition(1938123), '00:32:18.123');
  assert.equal(formatPosition(90061001), '25:01:01.001');
  assert.throws(() => formatPosition(12.5));
  assert.throws(() => formatPosition(-1));
  assert.throws(() => formatPosition(Number.MAX_SAFE_INTEGER + 1));
});
