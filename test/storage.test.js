'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const { DraftStore } = require('../src/storage.js');
const { toFileUri } = require('../src/protocol.js');
const { MemoryFiles, makePng } = require('./helpers/memory-files.js');

const SESSION_A = 'session_alpha_001';
const SESSION_B = 'session_bravo_002';
const ROOT_A = '/我的 Vault/Video Captures/IINA';
const ROOT_B = '/日本語 Notes/收件箱 ';
const SOURCE = '/Movies/日本語 中文 "quoted" %20 # [final].mkv';

function snapshot(id = 'capture_20261118_001', extra = {}) {
  return Object.freeze(Object.assign({
    captureId: id, capturedAt: '2026-11-18T18:00:00.125+08:00',
    videoTitle: '日本語：片名 "重看"', positionMs: 1938125, durationMs: 7200000,
    sourcePath: SOURCE, sourceUri: toFileUri(SOURCE), wasPaused: false
  }, extra));
}

function setup(options = {}) {
  const files = new MemoryFiles();
  files.addDirectory(ROOT_A); files.addDirectory(ROOT_B);
  const authorized = new Set([files.defaultRoot, ROOT_A, ROOT_B]);
  const settings = { outputPath: options.root === undefined ? ROOT_A : options.root, includeSourcePath: true, includeSubtitles: true };
  const store = new DraftStore(files, SESSION_A, root => authorized.has(root));
  return { files, authorized, settings, store };
}

function draft(env, options = {}) {
  const record = env.store.create(snapshot(options.id, options.snapshot), 4, env.settings);
  record.text = options.text === undefined ? '这是字幕出现时的感想。\n\n- 第二行包含 Markdown。' : options.text;
  record.includeImage = options.includeImage !== false;
  if (record.includeImage) {
    record.image = { attempt: 1, status: 'ready', mode: 'subtitles', error: '' };
    env.files.put(env.store.imagePath(record, 1), options.bytes || makePng());
  }
  env.store.persist(record);
  return record;
}

function exportedFiles(files) {
  return Array.from(files.files.keys()).filter(filename => filename.endsWith('.md'));
}
function publications(files, suffix) {
  return files.calls.filter(call => call.op === 'publishFile' && (!suffix || call.path.endsWith(suffix)));
}
function copies(files) { return files.calls.filter(call => call.op === 'copyBinary'); }
function assertProtected(env, record) {
  assert.ok(env.files.exists(env.store.draftPath(record.snapshot.captureId)));
  const saved = env.store.read(record.snapshot.captureId);
  assert.equal(saved.text, record.text);
  assert.equal(saved.snapshot.captureId, record.snapshot.captureId);
  assert.equal(saved.snapshot.positionMs, record.snapshot.positionMs);
  return saved;
}

test('standalone default output publishes image before Markdown with usable relative image bytes', async () => {
  const env = setup({ root: '' });
  const record = draft(env);
  const originalBytes = env.files.bytes(env.store.imagePath(record, 1));
  const location = await env.store.publish(record, env.settings);
  assert.equal(location, env.files.defaultRoot + '/' + record.snapshot.captureId + '.md');
  const markdown = env.files.read(location);
  assert.match(markdown, /capture_protocol: media-video-capture\/v1/);
  assert.match(markdown, /video_position_ms: 1938125/);
  assert.match(markdown, /captured_at: "2026-11-18T18:00:00.125\+08:00"/);
  assert.ok(markdown.includes(record.text));
  assert.ok(markdown.includes(JSON.stringify(toFileUri(SOURCE))));
  const relative = /^capture_image: "([^"]+)"$/m.exec(markdown)[1];
  assert.ok(markdown.includes('![](' + relative + ')'));
  const imagePath = path.join(path.dirname(location), relative);
  assert.deepEqual(env.files.bytes(imagePath), originalBytes);
  assert.equal(env.files.inspectImage(imagePath).width, 1);
  assert.deepEqual(publications(env.files).map(call => path.extname(call.path)), ['.png', '.md']);
  assert.ok(!Array.from(env.files.files.keys()).some(filename => filename.endsWith('.pending')));
  assert.ok(env.files.handles.every(handle => handle.closed));
});

test('image-only and text-only records each complete independently without Obsidian or MediaCore', async () => {
  const imageEnv = setup();
  const imageDraft = draft(imageEnv, { text: '' });
  const imageMd = imageEnv.files.read(await imageEnv.store.publish(imageDraft, imageEnv.settings));
  assert.match(imageMd, /!\[\]\(assets\/capture_20261118_001\.png\)/);

  const textEnv = setup();
  const textDraft = draft(textEnv, { includeImage: false, snapshot: { durationMs: undefined } });
  const textMd = textEnv.files.read(await textEnv.store.publish(textDraft, Object.assign({}, textEnv.settings, { includeSourcePath: false })));
  assert.ok(textMd.includes(textDraft.text));
  assert.doesNotMatch(textMd, /capture_image:|!\[\]|video_duration_ms:|video_source_uri:/);
  assert.match(textMd, /video_source_redacted: true/);
  assert.equal(copies(textEnv.files).length, 0);
  assert.equal(publications(textEnv.files, '.png').length, 0);
});

test('an empty text-only note cannot publish an empty success', async () => {
  const env = setup();
  const record = draft(env, { includeImage: false, text: '  \n' });
  await assert.rejects(env.store.publish(record, env.settings), /文字|截图/);
  assert.deepEqual(exportedFiles(env.files), []);
  assertProtected(env, record);
});

test('missing, incomplete, failed and wrong-subtitle screenshots never publish Markdown', async t => {
  for (const mode of ['missing', 'incomplete', 'failed', 'capturing', 'changed-mode']) {
    await t.test(mode, async () => {
      const env = setup();
      const record = draft(env);
      const image = env.store.imagePath(record, 1);
      if (mode === 'missing') env.files.files.delete(image);
      if (mode === 'incomplete') env.files.put(image, makePng().subarray(0, 35));
      if (mode === 'failed' || mode === 'capturing') record.image.status = mode;
      if (mode === 'changed-mode') record.subtitleMode = 'video';
      env.store.persist(record);
      await assert.rejects(env.store.publish(record, env.settings));
      assert.deepEqual(exportedFiles(env.files), []);
      assert.equal(publications(env.files, '.png').length, 0);
      assertProtected(env, record);
    });
  }
});

test('a failed screenshot can be explicitly omitted while preserving original text and timestamp', async () => {
  const env = setup();
  const record = draft(env);
  record.image.status = 'failed'; record.image.error = 'Screenshot timed out';
  record.includeImage = false;
  env.store.persist(record);
  const markdown = env.files.read(await env.store.publish(record, env.settings));
  assert.ok(markdown.includes(record.text));
  assert.match(markdown, /video_position_ms: 1938125/);
  assert.doesNotMatch(markdown, /capture_image:/);
  assert.equal(copies(env.files).length, 0);
});

test('image published then Markdown write failure retries same identity without recopying', async () => {
  const env = setup();
  const record = draft(env);
  const id = record.snapshot.captureId;
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC: disk full'));
  await assert.rejects(env.store.publish(record, env.settings), /ENOSPC/);
  assert.ok(env.files.exists(ROOT_A + '/assets/' + id + '.png'));
  assert.ok(!env.files.exists(ROOT_A + '/' + id + '.md'));
  const durable = assertProtected(env, record);
  assert.equal(durable.plan.root, ROOT_A);
  assert.equal(durable.plan.text, record.text);
  assert.equal(copies(env.files).length, 1);
  assert.ok(!Array.from(env.files.files.keys()).some(filename => filename.endsWith('.pending')));

  // Model a restart and a different player recovering the durable draft.
  const restoredStore = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
  const restored = await restoredStore.adopt(id);
  const result = await restoredStore.publish(restored, env.settings);
  assert.equal(result, ROOT_A + '/' + id + '.md');
  assert.equal(copies(env.files).length, 1);
  assert.equal(publications(env.files, '.png').length, 1);
  assert.deepEqual(exportedFiles(env.files), [result]);
});

test('losing the image publish acknowledgment leaves a recoverable image and no premature Markdown', async () => {
  const env = setup();
  const record = draft(env);
  env.files.failNext('afterPublishFile', call => call.path.endsWith('.png'), new Error('EIO: lost image receipt'));
  await assert.rejects(env.store.publish(record, env.settings), /lost image receipt/);
  assert.deepEqual(exportedFiles(env.files), []);
  assert.ok(env.files.exists(ROOT_A + '/assets/' + record.snapshot.captureId + '.png'));
  assertProtected(env, record);
  await env.store.publish(record, env.settings);
  assert.equal(copies(env.files).length, 1);
  assert.equal(exportedFiles(env.files).length, 1);
});

test('Markdown commit followed by lost read-back receipt is idempotent on retry', async () => {
  const env = setup();
  const record = draft(env);
  const final = ROOT_A + '/' + record.snapshot.captureId + '.md';
  env.files.failNext('read', call => call.path === final, new Error('EIO: lost Markdown receipt'));
  await assert.rejects(env.store.publish(record, env.settings), /lost Markdown receipt/);
  assert.ok(env.files.exists(final));
  const previousMarkdown = env.files.bytes(final);
  assertProtected(env, record);
  const count = publications(env.files).length;
  assert.equal(await env.store.publish(record, env.settings), final);
  assert.equal(await env.store.publish(record, env.settings), final);
  assert.equal(publications(env.files).length, count);
  assert.equal(copies(env.files).length, 1);
  assert.deepEqual(env.files.bytes(final), previousMarkdown);
  assert.deepEqual(exportedFiles(env.files), [final]);
});

test('manual Markdown changes and post-publication edits are preserved, never overwritten', async t => {
  for (const kind of ['external-markdown', 'new-draft-text', 'changed-image-selection']) {
    await t.test(kind, async () => {
      const env = setup();
      const record = draft(env);
      const final = await env.store.publish(record, env.settings);
      if (kind === 'external-markdown') env.files.put(final, '# Manually edited in Obsidian\n');
      if (kind === 'new-draft-text') record.text += '\n新增的一句话，不能丢失。';
      if (kind === 'changed-image-selection') record.includeImage = false;
      const previous = env.files.bytes(final);
      const count = publications(env.files).length;
      await assert.rejects(env.store.publish(record, env.settings), /覆盖|正文/);
      assert.deepEqual(env.files.bytes(final), previous);
      assert.equal(publications(env.files).length, count);
      assert.ok(env.files.exists(env.store.draftPath(record.snapshot.captureId)));
    });
  }
});

test('an unrelated preexisting Markdown or conflicting image is not overwritten', async t => {
  await t.test('Markdown without a matching durable plan', async () => {
    const env = setup(); const record = draft(env);
    const final = env.files.put(ROOT_A + '/' + record.snapshot.captureId + '.md', '# Existing user note\n');
    await assert.rejects(env.store.publish(record, env.settings), /覆盖/);
    assert.equal(env.files.read(final), '# Existing user note\n');
    assert.equal(publications(env.files).length, 0);
  });
  await t.test('image already published with different bytes', async () => {
    const env = setup(); const record = draft(env);
    const image = env.files.put(ROOT_A + '/assets/' + record.snapshot.captureId + '.png', makePng([0, 0, 0, 255]));
    const previous = env.files.bytes(image);
    await assert.rejects(env.store.publish(record, env.settings), /截图内容不同/);
    assert.deepEqual(env.files.bytes(image), previous);
    assert.deepEqual(exportedFiles(env.files), []);
    assertProtected(env, record);
  });
});

test('idempotent retry refuses a missing exported image instead of reporting a broken note as success', async () => {
  const env = setup(); const record = draft(env);
  await env.store.publish(record, env.settings);
  env.files.files.delete(ROOT_A + '/assets/' + record.snapshot.captureId + '.png');
  await assert.rejects(env.store.publish(record, env.settings), /截图缺失/);
  assert.equal(exportedFiles(env.files).length, 1);
  assertProtected(env, record);
});

test('two players keep independent drafts, snapshots and output identities', async () => {
  const env = setup();
  const first = draft(env, { id: 'capture_player_alpha', text: '甲窗口', snapshot: { positionMs: 1000 } });
  const otherStore = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
  const second = draft(Object.assign({}, env, { store: otherStore }), {
    id: 'capture_player_bravo', text: '乙窗口', snapshot: { positionMs: 9000, sourcePath: '/Movies/另一部.mp4', sourceUri: toFileUri('/Movies/另一部.mp4') }
  });
  const a = await env.store.publish(first, env.settings);
  const b = await otherStore.publish(second, env.settings);
  assert.notEqual(a, b);
  assert.match(env.files.read(a), /video_position_ms: 1000/);
  assert.match(env.files.read(b), /video_position_ms: 9000/);
  assert.ok(!env.files.read(a).includes('乙窗口'));
  assert.ok(!env.files.read(b).includes('甲窗口'));
  assert.equal(env.store.read(first.snapshot.captureId).ownerSession, SESSION_A);
  assert.equal(otherStore.read(second.snapshot.captureId).ownerSession, SESSION_B);
});

test('adoption invalidates the previous owner revision and old-window cleanup cannot remove the new draft', async () => {
  const env = setup(); const old = draft(env);
  const otherStore = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
  const adopted = await otherStore.adopt(old.snapshot.captureId);
  assert.ok(adopted.revision > old.revision);
  assert.ok(Object.isFrozen(adopted.snapshot));
  adopted.text = '恢复窗口中的新正文'; otherStore.persist(adopted);
  old.text = '旧窗口迟到的修改';
  assert.throws(() => env.store.persist(old), /其他播放器/);
  env.store.finish(old);
  assert.equal(otherStore.read(old.snapshot.captureId).text, adopted.text);
  assert.ok(env.files.exists(otherStore.imagePath(adopted, 1)));
});

test('an actively publishing draft cannot be silently adopted by a second player', async () => {
  const env = setup(); const record = draft(env);
  let copyReached;
  const reached = new Promise(resolve => { copyReached = resolve; });
  let releaseCopy;
  const release = new Promise(resolve => { releaseCopy = resolve; });
  env.files.hooks.copyBinary = async () => { copyReached(); await release; };
  const publishing = env.store.publish(record, env.settings);
  await reached;
  const otherStore = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
  try {
    await assert.rejects(otherStore.adopt(record.snapshot.captureId), /保存|发布|进行/);
  } finally { releaseCopy(); }
  await publishing;
  assert.equal(env.store.read(record.snapshot.captureId).ownerSession, SESSION_A);
});

test('an interrupted publishing marker requires explicit recovery before a new session can save', async () => {
  const env = setup(); const record = draft(env);
  // Simulate process termination after the in-progress marker became durable.
  record.publishing = true;
  env.store.persist(record);
  const restarted = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
  await assert.rejects(restarted.adopt(record.snapshot.captureId), /保存|关闭原窗口/);
  const recovered = await restarted.adopt(record.snapshot.captureId, true);
  assert.equal(recovered.publishing, false);
  assert.equal(recovered.ownerSession, SESSION_B);
  assert.deepEqual(recovered.snapshot, record.snapshot);
  assert.equal(recovered.text, record.text);
  const result = await restarted.publish(recovered, env.settings);
  assert.equal(result, ROOT_A + '/' + record.snapshot.captureId + '.md');
  assert.equal(exportedFiles(env.files).length, 1);
});

test('a pending publication retains its original root while newly captured notes use the new directory', async () => {
  const env = setup(); const old = draft(env);
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
  await assert.rejects(env.store.publish(old, env.settings), /ENOSPC/);
  const savedImage = env.files.bytes(ROOT_A + '/assets/' + old.snapshot.captureId + '.png');
  env.settings.outputPath = ROOT_B;
  const fresh = draft(env, { id: 'capture_new_destination', text: '新目录中的记录', includeImage: false });
  const oldOutput = await env.store.publish(old, env.settings);
  const newOutput = await env.store.publish(fresh, env.settings);
  assert.equal(oldOutput, ROOT_A + '/' + old.snapshot.captureId + '.md');
  assert.equal(newOutput, ROOT_B + '/' + fresh.snapshot.captureId + '.md');
  assert.ok(!env.files.exists(ROOT_B + '/' + old.snapshot.captureId + '.md'));
  assert.deepEqual(env.files.bytes(ROOT_A + '/assets/' + old.snapshot.captureId + '.png'), savedImage);
});

test('revoked old output authorization prevents retry until that exact directory is approved again', async () => {
  const env = setup(); const record = draft(env);
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
  await assert.rejects(env.store.publish(record, env.settings));
  env.authorized.delete(ROOT_A); env.settings.outputPath = ROOT_B;
  await assert.rejects(env.store.publish(record, env.settings), /授权/);
  assert.deepEqual(exportedFiles(env.files), []);
  assert.equal(assertProtected(env, record).plan.root, ROOT_A);
  env.authorized.add(ROOT_A);
  assert.equal(await env.store.publish(record, env.settings), ROOT_A + '/' + record.snapshot.captureId + '.md');
});

test('explicit retarget changes only an unpublished plan, preserving ID, text and old assets until the user saves', async () => {
  const env = setup(); const record = draft(env);
  const id = record.snapshot.captureId;
  env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
  await assert.rejects(env.store.publish(record, env.settings), /ENOSPC/);
  const oldImage = ROOT_A + '/assets/' + id + '.png';
  const original = env.files.bytes(oldImage);
  const originalText = record.text;
  const publicationCount = publications(env.files).length;
  const deletions = env.files.calls.filter(call => call.op === 'removePrivate' || call.op === 'removeStaging').length;
  await env.store.retarget(record, ROOT_B);
  assert.equal(record.snapshot.captureId, id);
  assert.equal(record.text, originalText);
  assert.equal(record.plan.root, ROOT_B);
  assert.equal(assertProtected(env, record).plan.root, ROOT_B);
  assert.deepEqual(env.files.bytes(oldImage), original);
  assert.deepEqual(exportedFiles(env.files), [], 'retarget does not publish Markdown');
  assert.equal(publications(env.files).length, publicationCount);
  assert.equal(env.files.calls.filter(call => call.op === 'removePrivate' || call.op === 'removeStaging').length, deletions);
  const output = await env.store.publish(record, env.settings);
  assert.equal(output, ROOT_B + '/' + id + '.md');
  assert.deepEqual(env.files.bytes(ROOT_B + '/assets/' + id + '.png'), original);
  assert.deepEqual(env.files.bytes(oldImage), original, 'old exported assets are never removed');
  assert.equal(env.files.exists(ROOT_A + '/' + id + '.md'), false);
});

test('retarget refuses an existing old Markdown, inaccessible old root, publishing draft and changed ownership', async t => {
  for (const failure of ['old-markdown', 'old-root-unreadable', 'publishing', 'owner-changed', 'unauthorized-new-root']) {
    await t.test(failure, async () => {
      const env = setup(); const record = draft(env);
      const id = record.snapshot.captureId;
      env.files.failNext('writeText', call => call.path.endsWith('.md.pending'), new Error('ENOSPC'));
      await assert.rejects(env.store.publish(record, env.settings));
      const oldImage = ROOT_A + '/assets/' + id + '.png';
      const original = env.files.bytes(oldImage);
      const existingText = '# An already committed or manually recovered note\n';
      if (failure === 'old-markdown') env.files.put(ROOT_A + '/' + id + '.md', existingText);
      if (failure === 'old-root-unreadable') {
        env.files.failNext('checkedPath', call => call.root === ROOT_A, new Error('EACCES: old folder inaccessible'));
      }
      if (failure === 'publishing') { record.publishing = true; env.store.persist(record); }
      if (failure === 'owner-changed') {
        const other = new DraftStore(env.files, SESSION_B, root => env.authorized.has(root));
        await other.adopt(id);
      }
      if (failure === 'unauthorized-new-root') env.authorized.delete(ROOT_B);
      const expected = { 'old-markdown': /已经存在|重复/, 'old-root-unreadable': /EACCES/,
        publishing: /正在保存/, 'owner-changed': /其他窗口/, 'unauthorized-new-root': /选择新目录|授权/ }[failure];
      await assert.rejects(env.store.retarget(record, ROOT_B), expected);
      assert.equal(record.plan.root, ROOT_A);
      assert.equal(env.store.read(id).plan.root, ROOT_A);
      assert.deepEqual(env.files.bytes(oldImage), original);
      assert.equal(env.files.exists(ROOT_B + '/' + id + '.md'), false);
      if (failure === 'old-markdown') assert.equal(env.files.read(ROOT_A + '/' + id + '.md'), existingText);
    });
  }
});

test('permission, disk space and unsupported hard-link failures retain the draft and source image', async t => {
  const failures = [
    ['prepareOutput', () => true, 'EACCES'],
    ['copyBinary', () => true, 'ENOSPC'],
    ['publishFile', call => call.path.endsWith('.png'), 'ENOTSUP'],
    ['publishFile', call => call.path.endsWith('.md'), 'EACCES']
  ];
  for (const [op, predicate, code] of failures) {
    await t.test(op + ': ' + code, async () => {
      const env = setup(); const record = draft(env);
      const sourceImage = env.files.bytes(env.store.imagePath(record, 1));
      env.files.failNext(op, predicate, new Error(code));
      await assert.rejects(env.store.publish(record, env.settings), new RegExp(code));
      assert.deepEqual(exportedFiles(env.files), []);
      assertProtected(env, record);
      assert.deepEqual(env.files.bytes(env.store.imagePath(record, 1)), sourceImage);
      await env.store.publish(record, env.settings);
      assert.equal(exportedFiles(env.files).length, 1);
    });
  }
});

test('failure to persist the publication plan publishes neither image nor Markdown', async () => {
  const env = setup(); const record = draft(env);
  env.files.failNext('writeText', call => call.path === env.store.draftPath(record.snapshot.captureId), new Error('ENOSPC: draft storage'));
  await assert.rejects(env.store.publish(record, env.settings), /ENOSPC/);
  assert.equal(publications(env.files).length, 0);
  assert.deepEqual(exportedFiles(env.files), []);
  assertProtected(env, record);
  await env.store.publish(record, env.settings);
  assert.equal(exportedFiles(env.files).length, 1);
});

test('corrupt, mismatched and oversized draft files remain available for manual recovery', async () => {
  const env = setup(); const good = draft(env);
  const corrupt = env.files.put(env.files.privatePath('drafts/capture_corrupt_json.json'), '{"schema":');
  const mismatch = env.files.put(env.files.privatePath('drafts/capture_wrong_identity.json'), JSON.stringify(good));
  const oversized = env.files.put(env.files.privatePath('drafts/capture_oversized_file.json'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  const unrelated = env.files.put(env.files.privatePath('drafts/readme.txt'), 'Please keep');
  const filesBefore = new Map(Array.from(env.files.files.entries()).map(([name, data]) => [name, Buffer.from(data)]));
  const list = await env.store.list();
  assert.deepEqual(list.drafts.map(item => item.id), [good.snapshot.captureId]);
  assert.equal(list.unreadable, 3);
  for (const id of ['capture_corrupt_json', 'capture_wrong_identity', 'capture_oversized_file']) {
    await assert.rejects(env.store.adopt(id));
  }
  for (const filename of [corrupt, mismatch, oversized, unrelated]) {
    assert.deepEqual(env.files.bytes(filename), filesBefore.get(filename));
  }
  assert.ok(!env.files.calls.some(call => call.op === 'removePrivate'));
  assert.ok(env.files.handles.every(handle => handle.closed));
});

test('finish removes only this capture private drafts/previews; exports and original video survive', async () => {
  const env = setup(); const record = draft(env);
  const video = env.files.put(SOURCE, Buffer.from('original video must remain untouched'));
  const other = env.files.put(ROOT_A + '/unrelated.md', '# User document');
  env.files.put(env.files.privatePath('previews/' + record.snapshot.captureId + '-1.png'), makePng());
  const unrelatedDraft = env.files.put(env.files.privatePath('drafts/capture_unrelated_999.json'), '{"keep":true}');
  const final = await env.store.publish(record, env.settings);
  const image = ROOT_A + '/assets/' + record.snapshot.captureId + '.png';
  const retained = new Map([final, image, video, other, unrelatedDraft].map(filename => [filename, env.files.bytes(filename)]));
  const beforeFinish = env.files.calls.length;
  env.store.finish(record);
  assert.ok(!env.files.exists(env.store.draftPath(record.snapshot.captureId)));
  assert.ok(!env.files.exists(env.store.imagePath(record, 1)));
  const removals = env.files.calls.slice(beforeFinish).filter(call => call.op === 'removePrivate' || call.op === 'removeStaging');
  assert.ok(removals.length >= 2);
  assert.ok(removals.every(call => call.op === 'removePrivate' && call.path.startsWith(env.files.dataRoot + '/')));
  for (const [filename, bytes] of retained) assert.deepEqual(env.files.bytes(filename), bytes);
  // Source files can move or disappear later without removing the independent export.
  env.files.files.delete(video);
  assert.deepEqual(env.files.bytes(final), retained.get(final));
  assert.deepEqual(env.files.bytes(image), retained.get(image));
});

test('temporary cleanup failure does not turn a complete export into a failed note', async () => {
  const env = setup(); const record = draft(env);
  env.files.failNext('removeStaging', () => true, new Error('EACCES: temporary cleanup'));
  const final = await env.store.publish(record, env.settings);
  assert.ok(env.files.exists(final));
  assert.equal(exportedFiles(env.files).length, 1);
  const leftovers = Array.from(env.files.files.keys()).filter(filename => filename.includes('/.iina-staging/'));
  assert.equal(leftovers.length, 1);
  assert.ok(leftovers[0].endsWith('.pending'));
});
