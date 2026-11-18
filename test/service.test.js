'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path').posix;
const { NotesSession } = require('../src/service.js');
const { Timers } = require('../src/timers.js');
const { toFileUri } = require('../src/protocol.js');
const { MemoryFiles } = require('./helpers/memory-files.js');
const { FakeClock, FakeIina, flushPromises } = require('./helpers/fake-iina.js');

async function environment(t, options = {}) {
  const files = options.files || new MemoryFiles(options.fileOptions);
  const clock = options.clock || new FakeClock();
  const host = new FakeIina(files, clock, options);
  const timers = new Timers(clock.set.bind(clock), clock.clear.bind(clock));
  const session = new NotesSession(host.api, timers, files);
  await session.start();
  t.after(() => session.dispose());
  return { files, clock, host, timers, session };
}

function editAction(env, changes = {}) {
  const record = env.session.active.record;
  return Object.assign({ type: 'edit', id: record.snapshot.captureId,
    clientId: env.session.clientId, sessionId: env.session.sessionId,
    editorToken: env.session.active.editorToken,
    text: record.text, includeImage: record.includeImage,
    subtitleMode: record.subtitleMode }, changes);
}
function capture(env) {
  env.host.invokeMenu('创建视频笔记');
  env.host.ready();
  assert.ok(env.session.active, env.session.error);
  return env.session.active;
}
async function captureReady(env) {
  const view = capture(env);
  await env.clock.advance(200);
  assert.equal(view.record.image.status, 'ready', view.record.image.error);
  return view;
}
function exportsOf(files, extension) {
  return Array.from(files.files.keys()).filter(filename =>
    filename.startsWith(files.defaultRoot + '/') && filename.endsWith(extension));
}

test('local MKV / MP4 / MOV: asynchronous raw capture, stable timestamp, UI edit and complete export', async t => {
  for (const extension of ['mkv', 'mp4', 'mov']) await t.test(extension, async t => {
    const source = '/电影/日本語 第 1 集 %20 # [test] `quote` ${time-pos}.' + extension;
    const env = await environment(t, { path: source,
      title: '电影: "第一集"\n日本語', fileOptions: { dataRoot: '/IINA 数据 ${path} `draft`' } });
    const { session, host, files, clock } = env;
    const before = Date.now();
    const view = capture(env);
    const captured = view.record.snapshot;
    assert.ok(Object.isFrozen(captured));
    assert.ok(Date.parse(captured.capturedAt) >= before && Date.parse(captured.capturedAt) <= Date.now());
    assert.equal(captured.positionMs, 12345);
    assert.equal(captured.sourcePath, source);
    assert.equal(captured.sourceUri, toFileUri(source));
    assert.equal(captured.durationMs, 7200000);
    assert.equal(captured.wasPaused, false);
    assert.equal(host.calls.commands.length, 1);
    const command = host.calls.commands[0];
    assert.equal(command.name, 'async');
    assert.deepEqual(command.args.slice(0, 3), ['raw', 'no-osd', 'screenshot-to-file']);
    assert.equal(command.args[3], session.store.imagePath(view.record, 1));
    assert.equal(command.args[4], 'subtitles');
    assert.equal(view.record.image.status, 'capturing');
    assert.equal(files.exists(command.args[3]), false);
    assert.equal(host.latestState().focus, true);
    await clock.advance(100);
    assert.equal(view.record.image.status, 'capturing', 'one valid poll cannot declare success');
    await clock.advance(100);
    assert.equal(view.record.image.status, 'ready');
    assert.match(view.preview, /^data:image\/png;base64,/);
    host.native.set('time-pos', 125.999);
    const text = '感想：这是 `原话`，${literal}。\n\n第二段 [笔记](relative.md)';
    host.send(editAction(env, { text }));
    await flushPromises();
    host.send(editAction(env, { type: 'save' }));
    await flushPromises(400);
    assert.equal(view.phase, 'saved', session.error);
    const markdown = files.read(view.savedPath);
    assert.match(markdown, /^---\ncapture_protocol: media-video-capture\/v1\n/);
    assert.match(markdown, /video_position_ms: 12345\n/);
    assert.ok(markdown.includes('captured_at: ' + JSON.stringify(captured.capturedAt)));
    assert.ok(markdown.includes('video_source_uri: ' + JSON.stringify(toFileUri(source))));
    assert.ok(markdown.endsWith(text + '\n'));
    const imageRelative = JSON.parse(markdown.match(/^capture_image: (.+)$/m)[1]);
    assert.ok(markdown.includes('![](' + imageRelative + ')'));
    assert.deepEqual(files.bytes(path.join(path.dirname(view.savedPath), imageRelative)), host.png);
    assert.equal(exportsOf(files, '.md').length, 1);
    assert.equal(exportsOf(files, '.png').length, 1);
    assert.equal(host.calls.pauses, 0);
    assert.equal(host.calls.resumes, 0);
    assert.equal(host.calls.commands.length, 1, 'save never reloads or seeks the video');
    assert.equal(files.exists(session.store.draftPath(captured.captureId)), false);
  });
});

test('default preserves playback; originally paused video is never resumed', async t => {
  for (const options of [
    { preferences: { autoPause: false }, native: { pause: false } },
    { preferences: { autoPause: false }, native: { pause: true } },
    { preferences: { autoPause: true }, native: { pause: true } }
  ]) await t.test(JSON.stringify(options), async t => {
    const env = await environment(t, options);
    const view = await captureReady(env);
    assert.equal(view.record.snapshot.wasPaused, options.native.pause);
    await env.session.save(editAction(env, { text: '保持播放状态' }));
    assert.equal(view.phase, 'saved');
    assert.equal(env.host.calls.pauses, 0);
    assert.equal(env.host.calls.resumes, 0);
    assert.equal(env.host.native.get('pause'), options.native.pause);
  });
});

test('auto pause resumes only its acknowledged pause, without a seek or media reload', async t => {
  const env = await environment(t, { preferences: { autoPause: true } });
  const view = capture(env);
  assert.equal(env.host.calls.pauses, 1);
  assert.equal(env.session.pauseLease.acknowledged, false, 'native pause notification is queued');
  await env.clock.advance(1);
  assert.equal(env.session.pauseLease.acknowledged, true);
  await env.clock.advance(199);
  await env.session.save(editAction(env, { text: '保存后恢复' }));
  assert.equal(view.phase, 'saved');
  assert.equal(env.host.calls.resumes, 1);
  assert.equal(env.session.pauseLease, null);
  assert.equal(env.host.native.get('time-pos'), 12.345);
  assert.equal(env.host.calls.commands.length, 1);
});

test('missing acknowledgement, later user pause, user playback and seek each revoke automatic resume', async t => {
  for (const reason of ['no-ack', 'pause-again', 'play', 'seek', 'position-changed']) await t.test(reason, async t => {
    const env = await environment(t, { preferences: { autoPause: true }, autoPauseAck: reason !== 'no-ack' });
    await captureReady(env);
    if (reason === 'pause-again') env.host.userPause(true);
    if (reason === 'play') env.host.userPause(false);
    if (reason === 'seek') env.host.emit('mpv.seek');
    if (reason === 'position-changed') env.host.native.set('time-pos', 13);
    await env.session.save(editAction(env, { text: '用户控制播放' }));
    assert.equal(env.session.active.phase, 'saved');
    assert.equal(env.host.calls.resumes, 0);
  });
});

test('no file, missing native properties, switching, network source and incoherent path fail without fake capture', async t => {
  const cases = [
    ['idle', env => { env.host.status.idle = true; env.host.native.set('idle-active', true); }],
    ['time-pos null', env => env.host.native.set('time-pos', null)],
    ['pause null', env => env.host.native.set('pause', null)],
    ['idle-active null', env => env.host.native.set('idle-active', null)],
    ['no video track', env => env.host.native.set('video-params', null)],
    ['seeking', env => env.host.native.set('seeking', true)],
    ['file loading', env => env.host.emit('mpv.start-file')],
    ['remote', env => { env.host.status.isNetworkResource = true; env.host.status.url = 'https://example.invalid/token'; }],
    ['incoherent URL', env => { env.host.status.url = 'file:///另一个视频.mp4'; }],
    ['missing title', env => { env.host.status.title = null; }]
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const env = await environment(t);
    change(env); env.session.capture(); env.host.ready();
    assert.equal(env.session.active, null);
    assert.ok(env.host.latestState().error);
    assert.equal(env.host.calls.commands.length, 0);
    assert.equal(env.files.listPrivate('drafts').length, 0);
  });
});

test('unknown duration is omitted while genuine zero position stays zero', async t => {
  const env = await environment(t, { native: { duration: null, 'time-pos': 0 } });
  await captureReady(env);
  await env.session.save(editAction(env, { text: '开始处' }));
  const markdown = env.files.read(env.session.active.savedPath);
  assert.match(markdown, /video_position_ms: 0\n/);
  assert.doesNotMatch(markdown, /video_duration_ms:/);
});

test('subtitle preference selects video-only frames; changing mode requires a fresh capture at the same pause position', async t => {
  const env = await environment(t, { preferences: { includeSubtitles: false }, native: { pause: true } });
  const view = await captureReady(env);
  assert.equal(env.host.calls.commands[0].args[4], 'video');
  await env.session.save(editAction(env, { text: '新字幕模式', subtitleMode: 'subtitles' }));
  assert.equal(view.phase, 'editing');
  assert.match(env.session.error, /字幕模式/);
  assert.equal(exportsOf(env.files, '.md').length, 0);
  await env.session.retryImage(editAction(env, { subtitleMode: 'subtitles' }));
  assert.equal(env.host.calls.commands.length, 2);
  assert.equal(env.host.calls.commands[1].args[4], 'subtitles');
  assert.notEqual(env.host.calls.commands[0].args[3], env.host.calls.commands[1].args[3]);
  await env.clock.advance(200);
  assert.equal(view.record.image.status, 'ready');
  await env.session.save(editAction(env));
  assert.equal(view.phase, 'saved');
});

test('image timeout or malformed PNG retains text and timestamp and allows text-only save', async t => {
  for (const screenshotMode of ['timeout', 'partial', 'throw']) await t.test(screenshotMode, async t => {
    const env = await environment(t, { screenshotMode });
    const view = capture(env);
    env.session.applyEdit(editAction(env, { text: '即使没有图片也要保留这段文字' }));
    await env.clock.advance(6000);
    assert.equal(view.record.image.status, 'failed');
    assert.ok(view.record.image.error);
    assert.equal(env.session.operations.size, 0);
    await env.session.save(editAction(env));
    assert.equal(view.phase, 'editing');
    assert.equal(exportsOf(env.files, '.md').length, 0);
    await env.session.save(editAction(env, { includeImage: false }));
    assert.equal(view.phase, 'saved');
    const markdown = env.files.read(view.savedPath);
    assert.match(markdown, /video_position_ms: 12345/);
    assert.match(markdown, /即使没有图片也要保留这段文字/);
    assert.doesNotMatch(markdown, /capture_image:/);
    assert.equal(exportsOf(env.files, '.png').length, 0);
  });
});

test('preview failure preserves the validated original and still saves an image-only note', async t => {
  const env = await environment(t);
  env.files.failNext('preview', () => true, new Error('sips unavailable'));
  const view = await captureReady(env);
  assert.equal(view.preview, null);
  assert.equal(view.record.image.status, 'ready');
  await env.session.save(editAction(env, { text: '' }));
  assert.equal(view.phase, 'saved');
  assert.deepEqual(env.files.bytes(exportsOf(env.files, '.png')[0]), env.host.png);
});

test('file change or seek before confirmation prevents a late frame attaching to the earlier timestamp', async t => {
  for (const change of ['file', 'seek']) await t.test(change, async t => {
    const env = await environment(t, { screenshotDelay: 150 });
    const view = capture(env), original = view.record.snapshot;
    env.session.applyEdit(editAction(env, { text: '这是原视频的感想' }));
    await env.clock.advance(50);
    if (change === 'file') env.host.setFile('/新电影/第二部.mp4');
    else { env.host.native.set('time-pos', 77); env.host.emit('mpv.seek'); }
    await env.clock.advance(200);
    assert.equal(view.record.image.status, 'failed');
    assert.equal(view.record.image.invalidated, true);
    assert.equal(view.record.snapshot.sourcePath, original.sourcePath);
    assert.equal(view.record.snapshot.positionMs, 12345);
    await env.session.save(editAction(env));
    assert.equal(view.phase, 'editing');
    assert.equal(exportsOf(env.files, '.md').length, 0);
    await env.session.save(editAction(env, { includeImage: false }));
    assert.equal(view.phase, 'saved');
    assert.ok(env.files.read(view.savedPath).includes(JSON.stringify(original.sourceUri)));
  });
});

test('file change during slow preview does not invalidate an already confirmed frame', async t => {
  const env = await environment(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.files.hooks.preview = () => gate;
  const view = capture(env);
  await env.clock.advance(200);
  assert.equal(view.record.image.status, 'ready');
  assert.equal(view.previewPending, true);
  assert.equal(env.session.operations.has(view), false);
  env.host.setFile('/另一个视频.mov');
  assert.equal(view.record.image.invalidated, false);
  await env.session.save(editAction(env, { text: '已经确认的原画面' }));
  assert.equal(view.phase, 'saved');
  release(); await flushPromises();
  assert.equal(view.record.image.status, 'ready');
  assert.deepEqual(env.files.bytes(exportsOf(env.files, '.png')[0]), env.host.png);
  assert.equal(env.files.exists(env.session.store.draftPath(view.record.snapshot.captureId)), false);
});

test('two players share storage while keeping source, editor, commands and ownership separate', async t => {
  const files = new MemoryFiles();
  const a = await environment(t, { files, path: '/Movies/A.mkv' });
  const b = await environment(t, { files, path: '/电影/B.mp4', native: { 'time-pos': 99.123 } });
  const av = await captureReady(a), bv = await captureReady(b);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  assert.notEqual(av.record.snapshot.captureId, bv.record.snapshot.captureId);
  a.host.send(editAction(a, { text: 'A 自己的文字' }));
  b.host.send(editAction(b, { text: 'B 自己的文字' }));
  await flushPromises();
  b.host.send(editAction(a, { text: '跨窗口错误消息', clientId: b.session.clientId }));
  await flushPromises();
  assert.equal(bv.record.text, 'B 自己的文字');
  await Promise.all([a.session.save(editAction(a)), b.session.save(editAction(b))]);
  assert.equal(av.phase, 'saved'); assert.equal(bv.phase, 'saved');
  const am = files.read(av.savedPath), bm = files.read(bv.savedPath);
  assert.match(am, /A 自己的文字/); assert.doesNotMatch(am, /B 自己的文字/);
  assert.match(bm, /B 自己的文字/); assert.doesNotMatch(bm, /A 自己的文字/);
  assert.match(am, /video_position_ms: 12345/); assert.match(bm, /video_position_ms: 99123/);
  assert.equal(a.host.calls.commands.length, 1); assert.equal(b.host.calls.commands.length, 1);
  assert.equal(exportsOf(files, '.md').length, 2);
});

test('repeated shortcut preserves draft and text across playback and file changes', async t => {
  const env = await environment(t);
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  env.session.applyEdit(editAction(env, { text: '尚未保存的正文' }));
  env.host.setFile('/新的文件.mp4');
  env.host.invokeMenu('创建视频笔记');
  assert.equal(env.session.active, view);
  assert.equal(view.record.snapshot.captureId, id);
  assert.equal(view.record.text, '尚未保存的正文');
  assert.equal(view.record.snapshot.sourcePath, '/电影/第一集 100%20 [日本語] #1.mkv');
  assert.equal(env.host.calls.commands.length, 1);
  assert.match(env.session.notice, /继续当前草稿/);
});

test('duplicate save messages create one image and one Markdown, then a new capture gets a new ID', async t => {
  const env = await environment(t);
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  const action = editAction(env, { type: 'save', text: '只保存一次' });
  env.host.send(action); env.host.send(action);
  await flushPromises(400);
  assert.equal(view.phase, 'saved');
  env.host.send(action); await flushPromises();
  assert.equal(exportsOf(env.files, '.md').length, 1);
  assert.equal(exportsOf(env.files, '.png').length, 1);
  assert.equal(env.files.calls.filter(call => call.op === 'publishFile').length, 2);
  env.session.capture();
  assert.notEqual(env.session.active.record.snapshot.captureId, id);
  assert.equal(env.session.active.record.text, '');
});

test('WebView reload keeps exactly one handler, re-sends the preview, and rejects old clients', async t => {
  const env = await environment(t);
  const view = await captureReady(env);
  const initialRegistration = env.host.calls.onMessage.length;
  env.host.send(editAction(env, { text: '先前正文' })); await flushPromises();
  assert.equal(Object.hasOwn(env.host.latestState().active, 'previewDataUrl'), false,
    'ordinary edits do not re-send a full image');
  const oldClientId = env.session.clientId;
  env.host.ready('reloaded-webview');
  const refreshed = env.host.latestState();
  assert.equal(refreshed.active.previewDataUrl, view.preview, 'new WebView receives its first preview');
  assert.equal(refreshed.active.text, '先前正文');
  env.host.send(editAction(env, { clientId: oldClientId, text: '过期页面的修改' }));
  await flushPromises();
  assert.equal(view.record.text, '先前正文');
  env.session.showSettings(); env.session.open('editor'); env.host.ready('reloaded-webview');
  assert.equal(env.host.calls.loadFile.length, 1);
  assert.equal(env.host.calls.onMessage.length, initialRegistration);
  assert.equal(env.host.messages.size, 1);
});

test('restoring the same capture ID rotates its editor token and rejects stale or missing tokens for every editor mutation', async t => {
  const env = await environment(t, { native: { pause: true } });
  const previous = await captureReady(env);
  const oldToken = previous.editorToken;
  const id = previous.record.snapshot.captureId;
  env.session.close(editAction(env, { type: 'close', text: '恢复之前的文字' }), false);
  await env.session.restore({ id });
  const current = env.session.active;
  assert.equal(current.record.snapshot.captureId, id);
  assert.equal(typeof current.editorToken, 'string');
  assert.notEqual(current.editorToken, oldToken);
  assert.equal(env.host.latestState().active.editorToken, current.editorToken);
  env.host.send(editAction(env, { text: '新编辑会话的正文' }));
  await flushPromises();
  for (const token of [oldToken, undefined]) {
    for (const type of ['edit', 'save', 'close', 'retry-image', 'retarget']) {
      env.host.send(editAction(env, { type, editorToken: token, text: '旧编辑会话迟到的覆盖' }));
      await flushPromises();
      assert.equal(env.session.active, current, type + ' must not close or replace the current editor');
      assert.equal(current.phase, 'editing');
      assert.equal(current.record.text, '新编辑会话的正文');
      assert.equal(env.session.store.read(id).text, '新编辑会话的正文');
      assert.equal(exportsOf(env.files, '.md').length, 0);
      assert.equal(env.host.calls.commands.length, 1);
    }
  }
  env.host.send(editAction(env, { text: '最新 token 仍可编辑' }));
  await flushPromises();
  assert.equal(current.record.text, '最新 token 仍可编辑');
});

test('image published then Markdown failure keeps body, screenshot and ID for one successful retry', async t => {
  const env = await environment(t);
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC: disk full'));
  await env.session.save(editAction(env, { text: '失败也不能丢失这段文字' }));
  assert.equal(view.phase, 'editing');
  assert.match(env.session.error, /ENOSPC/);
  assert.equal(view.record.text, '失败也不能丢失这段文字');
  assert.equal(exportsOf(env.files, '.md').length, 0);
  assert.equal(exportsOf(env.files, '.png').length, 1);
  assert.equal(env.files.exists(env.session.store.draftPath(id)), true);
  const binaryCopies = env.files.calls.filter(call => call.op === 'copyBinary').length;
  await env.session.save(editAction(env));
  assert.equal(view.phase, 'saved');
  assert.equal(view.record.snapshot.captureId, id);
  assert.equal(env.files.calls.filter(call => call.op === 'copyBinary').length, binaryCopies);
  assert.equal(exportsOf(env.files, '.md').length, 1);
});

test('closing protects drafts, and a failed draft write keeps editor text available', async t => {
  const env = await environment(t);
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  const action = editAction(env, { type: 'close', text: '关闭前的最后一个字符' });
  env.files.failNext('writeText', call => call.path.endsWith('.json'), new Error('EACCES: drafts denied'));
  env.files.failNext('writeText', call => call.path.endsWith('.json'), new Error('EACCES: drafts denied'));
  env.session.close(action, false);
  assert.equal(env.session.active, view);
  assert.equal(view.record.text, action.text);
  assert.equal(env.host.visible, true);
  assert.match(env.session.error, /EACCES/);
  env.session.close(editAction(env, { type: 'close' }), false);
  assert.equal(env.session.active, null);
  assert.equal(env.host.visible, false);
  assert.equal(env.session.store.read(id).text, action.text);
  assert.equal(env.timers.ids.size, 0, 'closed editor has no periodic monitor');
  await env.session.restore({ id });
  assert.equal(env.session.active.record.snapshot.captureId, id);
  assert.equal(env.session.active.record.text, action.text);
  assert.equal(env.session.active.record.image.status, 'ready');
});

test('native close protects its draft; pooled player close stops active work but retains listeners for reuse', async t => {
  const env = await environment(t, { preferences: { autoPause: true } });
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  env.session.applyEdit(editAction(env, { text: '红色关闭按钮也应保留' }));
  env.host.visible = false;
  await env.clock.advance(300);
  assert.equal(env.session.active, null);
  assert.equal(env.session.store.read(id).text, '红色关闭按钮也应保留');
  assert.equal(env.host.calls.resumes, 1);
  assert.equal(env.timers.ids.size, 0);
  env.host.screenshotMode = 'timeout'; env.session.capture();
  await env.clock.advance(100);
  assert.ok(env.timers.ids.size > 0);
  const pending = env.session.active;
  const pendingId = pending.record.snapshot.captureId;
  const listeners = env.host.listenerCount();
  env.host.emit('iina.window-will-close');
  assert.equal(env.session.disposed, false, 'IINA can reuse the same PlayerCore and plugin instance');
  assert.equal(env.session.active, null);
  assert.equal(env.host.visible, false);
  assert.equal(env.session.loading, true);
  assert.equal(env.host.listenerCount(), listeners, 'idle event registrations must survive window close');
  assert.equal(pending.record.image.invalidated, true);
  await env.clock.advance(100);
  assert.equal(env.timers.ids.size, 0);
  assert.equal(env.session.operations.size, 0);
  assert.equal(env.session.store.read(pendingId).image.status, 'failed');
  const messages = env.host.calls.postMessage.length;
  await env.clock.advance(10000);
  assert.equal(env.host.calls.postMessage.length, messages);
  assert.equal(env.timers.ids.size, 0, 'a closed pooled player has no continuing polling');
  assert.equal(env.host.calls.resumes, 1, 'suspending does not act on a closing player');
  env.host.screenshotMode = 'success';
  env.host.native.set('pause', false);
  env.host.setFile('/复用播放器/新视频.mp4');
  const next = await captureReady(env);
  assert.equal(next.record.snapshot.sourcePath, '/复用播放器/新视频.mp4');
  assert.notEqual(next.record.snapshot.captureId, pendingId);
  assert.equal(env.host.listenerCount(), listeners);
  assert.equal(env.host.calls.loadFile.length, 1, 'the existing WebView bridge is reusable too');
  env.session.dispose();
  assert.equal(env.timers.ids.size, 0);
  assert.equal(env.host.listenerCount(), 0, 'actual destruction still removes all registrations');
});

test('an older export finishing after pooled player reuse cannot release the new note pause lease', async t => {
  const env = await environment(t, { preferences: { autoPause: true } });
  const oldView = await captureReady(env);
  const oldId = oldView.record.snapshot.captureId;
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  env.files.hooks.copyBinary = async call => {
    if (call.source.includes(oldId)) { reached(); await gate; }
  };
  const oldSaving = env.session.save(editAction(env, { text: '上一个窗口尚未完成的导出' }));
  await entered;
  assert.equal(oldView.phase, 'saving');
  env.host.emit('iina.window-will-close');
  assert.equal(env.session.active, null);
  assert.equal(env.session.pauseLease, null);
  env.host.native.set('pause', false);
  env.host.setFile('/复用播放器/下一部.mkv');
  const newView = await captureReady(env);
  env.session.applyEdit(editAction(env, { text: '新笔记自己的正文与暂停状态' }));
  const newLease = env.session.pauseLease;
  assert.equal(newLease.id, newView.record.snapshot.captureId);
  assert.equal(newLease.acknowledged, true);
  assert.equal(env.host.calls.pauses, 2);
  assert.equal(env.host.calls.resumes, 0);
  release(); await oldSaving;
  assert.equal(oldView.phase, 'saved');
  assert.equal(env.session.active, newView);
  assert.equal(env.session.pauseLease, newLease, 'old export completion must not even clear the newer lease');
  assert.equal(env.host.calls.resumes, 0);
  assert.equal(env.host.native.get('pause'), true);
  assert.equal(newView.record.text, '新笔记自己的正文与暂停状态');
  assert.equal(newView.phase, 'editing');
  assert.equal(env.session.error, '');
  await env.session.save(editAction(env));
  assert.equal(newView.phase, 'saved');
  assert.equal(env.host.calls.resumes, 1, 'only saving the new note restores its own pause');
  assert.equal(exportsOf(env.files, '.md').length, 2);
  assert.ok(env.files.handles.every(handle => handle.closed));
});

test('native close during an in-flight save ends monitoring, restores owned pause and keeps failures recoverable', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'write fails after close' : 'write succeeds after close', async t => {
    const env = await environment(t, { preferences: { autoPause: true } });
    const view = await captureReady(env), id = view.record.snapshot.captureId;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    env.files.hooks.copyBinary = () => gate;
    if (fails) env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
    const saving = env.session.save(editAction(env, { text: '保存中关闭面板' }));
    await flushPromises();
    assert.equal(view.phase, 'saving');
    env.host.visible = false;
    await env.clock.advance(500);
    assert.equal(env.host.calls.resumes, 1);
    assert.equal(env.timers.ids.size, 0);
    release(); await saving;
    assert.equal(env.host.calls.resumes, 1);
    assert.equal(view.phase, fails ? 'editing' : 'saved');
    if (fails) {
      assert.match(env.session.error, /ENOSPC/);
      assert.ok(env.host.calls.osd.some(message => message.includes('保存失败')));
      assert.equal(env.session.store.read(id).text, '保存中关闭面板');
      env.host.invokeMenu('创建视频笔记');
      assert.equal(env.session.active, view);
      assert.equal(env.host.visible, true);
    } else {
      assert.equal(exportsOf(env.files, '.md').length, 1);
      assert.equal(env.files.exists(env.session.store.draftPath(id)), false);
    }
  });
});

test('text-only save while screenshot is still pending is final and cleans the private draft after bounded timeout', async t => {
  const env = await environment(t, { screenshotMode: 'timeout' });
  const view = capture(env), id = view.record.snapshot.captureId;
  await env.session.save(editAction(env, { text: '现在就保存文字', includeImage: false }));
  assert.equal(view.phase, 'saved');
  assert.equal(env.files.exists(view.savedPath), true);
  assert.equal(env.files.exists(env.session.store.draftPath(id)), true, 'in-flight capture retains its working record');
  await env.clock.advance(6000);
  assert.equal(view.phase, 'saved');
  assert.equal(env.files.exists(env.session.store.draftPath(id)), false);
  assert.equal(exportsOf(env.files, '.md').length, 1);
  assert.doesNotMatch(env.files.read(view.savedPath), /capture_image:/);
});

test('settings authorize a chosen directory, preserve older outputs, omit source path when requested and update shortcut', async t => {
  const env = await environment(t);
  const first = await captureReady(env);
  await env.session.save(editAction(env, { text: '原保存位置' }));
  const oldPath = first.savedPath;
  const inbox = env.files.addDirectory('/Obsidian Vault/Video Captures/IINA');
  env.host.chooseFileResult = inbox;
  await env.session.chooseDirectory();
  assert.deepEqual(env.host.calls.chosenFiles[0].options, { chooseDir: true });
  assert.deepEqual(env.host.preferences.get('authorizedRoots'), [inbox]);
  env.session.updateSettings({ includeSubtitles: false, autoPause: false,
    includeSourcePath: false, shortcut: 'Ctrl+Alt+n' });
  assert.equal(env.host.menuItems[0].options.keyBinding, 'Ctrl+Alt+n');
  const next = await captureReady(env);
  await env.session.save(editAction(env, { text: '隐私设置' }));
  assert.ok(next.savedPath.startsWith(inbox + '/'));
  assert.equal(env.files.exists(oldPath), true);
  assert.doesNotMatch(env.files.read(next.savedPath), /video_source_uri:/);
  env.session.showOutput();
  assert.equal(env.host.calls.finder.at(-1), inbox);
  assert.equal(env.host.calls.commands.at(-1).args[4], 'video');
  assert.ok(env.host.calls.sync > 0);
});

test('unselected output paths fail safely; canceling a picker does not authorize or alter settings', async t => {
  const root = '/Unauthorized Inbox';
  const env = await environment(t, { preferences: { outputPath: root } });
  env.files.addDirectory(root);
  await captureReady(env);
  await env.session.save(editAction(env, { text: '目录需要授权' }));
  assert.equal(env.session.active.phase, 'editing');
  assert.match(env.session.error, /授权/);
  assert.equal(Array.from(env.files.files.keys()).some(filename => filename.startsWith(root + '/')), false);
  env.session.showOutput();
  assert.equal(env.host.calls.finder.length, 0);
  await env.session.chooseDirectory();
  assert.equal(env.host.preferences.get('outputPath'), root);
  assert.equal(env.host.preferences.get('authorizedRoots'), undefined);
});

test('explicit retarget protects in-flight edits, keeps latest fields and old assets, and waits for a separate Save', async t => {
  const env = await environment(t);
  const view = await captureReady(env), id = view.record.snapshot.captureId;
  const oldRoot = env.files.defaultRoot;
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
  await env.session.save(editAction(env, { text: '第一次保存的正文' }));
  assert.equal(view.phase, 'editing');
  const oldImage = oldRoot + '/assets/' + id + '.png';
  const original = env.files.bytes(oldImage);
  const newRoot = env.files.addDirectory('/另一个 Vault/Video Captures/IINA');
  env.host.chooseFileResult = newRoot;
  await env.session.chooseDirectory();
  assert.equal(view.record.plan.root, oldRoot, 'choosing a directory alone does not change an existing publication plan');
  assert.equal(env.host.latestState().active.canRetarget, true);
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const prepareOutput = env.files.prepareOutput.bind(env.files);
  env.files.prepareOutput = async root => {
    if (root === newRoot) { entered(); await gate; }
    return prepareOutput(root);
  };
  env.host.send(editAction(env, { type: 'retarget', text: '换目录时刚输入的正文' }));
  await reached;
  assert.equal(view.phase, 'saving');
  env.host.send(editAction(env, { type: 'edit', text: '进行中不应插入的修改' }));
  env.host.send(editAction(env, { type: 'save', text: '进行中不应保存的修改' }));
  await flushPromises();
  assert.equal(view.record.text, '换目录时刚输入的正文');
  assert.equal(exportsOf(env.files, '.md').length, 0);
  release(); await flushPromises(300);
  assert.equal(view.phase, 'editing');
  assert.equal(view.record.plan.root, newRoot);
  assert.equal(env.session.store.read(id).text, '换目录时刚输入的正文');
  assert.equal(env.session.store.read(id).plan.root, newRoot);
  assert.equal(env.files.exists(newRoot + '/' + id + '.md'), false);
  assert.deepEqual(env.files.bytes(oldImage), original);
  assert.equal(env.host.latestState().active.canRetarget, false);
  assert.match(env.session.notice, /点击保存/);
  env.host.send(editAction(env, { type: 'save' }));
  await flushPromises(400);
  assert.equal(view.phase, 'saved');
  assert.equal(view.savedPath, newRoot + '/' + id + '.md');
  assert.match(env.files.read(view.savedPath), /换目录时刚输入的正文/);
  assert.equal(env.files.exists(oldRoot + '/' + id + '.md'), false);
  assert.deepEqual(env.files.bytes(oldImage), original);
});

test('an inaccessible old destination keeps the draft and latest editor text after a failed retarget', async t => {
  const env = await environment(t);
  const view = await captureReady(env);
  const oldRoot = env.files.defaultRoot;
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
  await env.session.save(editAction(env, { text: '第一次保存' }));
  env.host.chooseFileResult = env.files.addDirectory('/New Inbox');
  await env.session.chooseDirectory();
  env.files.failNext('checkedPath', call => call.root === oldRoot, new Error('EACCES: old directory unavailable'));
  env.host.send(editAction(env, { type: 'retarget', text: '失败前刚输入的文字也要保留' }));
  await flushPromises(300);
  assert.equal(view.phase, 'editing');
  assert.equal(view.record.plan.root, oldRoot);
  assert.equal(view.record.text, '失败前刚输入的文字也要保留');
  assert.match(env.session.error, /EACCES/);
  assert.equal(env.session.store.read(view.record.snapshot.captureId).text, view.record.text);
  assert.equal(exportsOf(env.files, '.md').length, 0);
  assert.equal(env.files.exists('/New Inbox/' + view.record.snapshot.captureId + '.md'), false);
});

test('recovered draft keeps original identity and rejects screenshot retry from another player session', async t => {
  const files = new MemoryFiles();
  const original = await environment(t, { files });
  const view = await captureReady(original), id = view.record.snapshot.captureId;
  original.session.close(editAction(original, { type: 'close', text: '另一个窗口恢复' }), false);
  const restored = await environment(t, { files, native: { pause: true } });
  await restored.session.restore({ id });
  assert.equal(restored.host.calls.ask.length, 1);
  assert.equal(restored.session.active.record.snapshot.captureId, id);
  assert.equal(restored.session.active.record.text, '另一个窗口恢复');
  await assert.rejects(restored.session.retryImage(editAction(restored)), /原播放会话已结束/);
  assert.equal(restored.host.calls.commands.length, 0);
  await restored.session.save(editAction(restored));
  assert.equal(restored.session.active.phase, 'saved');
});

test('minimum IINA version is enforced and manifest declares only the needed local permissions', async t => {
  const env = await environment(t, { version: '1.4.2' });
  assert.equal(env.session.ready, false);
  env.session.capture(); env.host.ready();
  assert.match(env.host.latestState().error, /1\.5\.0/);
  assert.equal(env.host.calls.commands.length, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../Info.json'), 'utf8'));
  assert.deepEqual(manifest.permissions.slice().sort(), ['file-system', 'show-alert', 'show-osd']);
  assert.equal(manifest.entry, 'dist/main.js');
  assert.equal(manifest.preferencesPage, 'ui/preferences.html');
  assert.equal(env.host.menuItems.length, 4);
  assert.equal(env.host.menuItems[0].options.keyBinding, 'Meta+Shift+n');
});
