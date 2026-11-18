'use strict';

// These tests exercise the real WebView script using a small DOM/message stub.
// They do not stand in for layout, WKWebView, or actual IINA acceptance tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../ui/editor.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../ui/editor.js'), 'utf8');

function bootEditor() {
  const nodes = new Map();
  const messages = [];
  const handlers = {};
  const listeners = {};
  const windowListeners = {};
  let registrations = 0;
  const document = { activeElement: null };

  function element(id) {
    const node = { id, hidden: false, textContent: '', value: '', checked: false, disabled: false, children: [], attributes: {}, events: {}, classes: new Set() };
    node.classList = { toggle(name, enabled) { if (enabled) node.classes.add(name); else node.classes.delete(name); } };
    node.addEventListener = (name, handler) => { node.events[name] = handler; };
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    node.getAttribute = (name) => node.attributes[name] || null;
    node.removeAttribute = (name) => { delete node.attributes[name]; };
    Object.defineProperty(node, 'src', {
      get() { return node.attributes.src || ''; },
      set(value) { node.attributes.src = value; },
    });
    node.appendChild = (child) => node.children.push(child);
    node.replaceChildren = () => { node.children = []; };
    node.querySelector = () => { if (!node.span) node.span = element('span'); return node.span; };
    node.focus = () => { document.activeElement = node; };
    node.click = () => { if (!node.disabled && node.events.click) node.events.click(); };
    return node;
  }

  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element(match[1]));
  nodes.get('include-image').checked = true;
  nodes.get('subtitle-mode').value = 'subtitles';
  document.getElementById = (id) => { assert.ok(nodes.has(id), 'Missing HTML element: ' + id); return nodes.get(id); };
  document.querySelectorAll = () => [element('back-1'), element('back-2')];
  document.createElement = (tag) => element(tag);
  document.addEventListener = (name, handler) => { listeners[name] = handler; };

  const iina = {
    onMessage(name, handler) { registrations += 1; handlers[name] = handler; },
    postMessage(name, envelope) { messages.push({ name, envelope, payload: JSON.parse(decodeURIComponent(envelope.encoded)) }); },
  };
  vm.runInNewContext(script, { document, window: { addEventListener(name, handler) { windowListeners[name] = handler; } }, iina }, { filename: 'ui/editor.js' });
  const clientId = messages[0].payload.clientId;
  const state = {
    clientId,
    sessionId: 'session-001',
    view: 'editor',
    focus: true,
    active: { id: 'capture-0001', editorToken: 'editor-0001', title: '中文_日本語_video.mkv', positionMs: 1938123, capturedAt: '2026-11-18T20:00:00+08:00', text: '', includeImage: true, subtitleMode: 'subtitles', imageStatus: 'ready', phase: 'editing' },
    settings: { outputPath: '/Users/test/笔记收件箱', includeSubtitles: true, autoPause: false, includeSourcePath: true, shortcut: 'Meta+Shift+n' },
    drafts: [],
  };
  function push(value) { handlers['vn-state']({ encoded: encodeURIComponent(JSON.stringify(value)) }); }
  return { nodes, messages, handlers, listeners, windowListeners, document, registrations, state, push };
}

test('WebView encodes user input before sending it across the IINA message bridge', () => {
  const ui = bootEditor();
  ui.push(ui.state);
  const input = ui.nodes.get('note-text');
  input.value = '中文「日本語」 `code` ${globalThis.pwned = true}\n<script>bad()</script>\n引号 " \\';
  input.events.input();
  const message = ui.messages.at(-1);
  assert.equal(message.name, 'vn-action');
  assert.equal(message.payload.type, 'edit');
  assert.equal(message.payload.text, input.value);
  assert.equal(message.payload.id, ui.state.active.id);
  assert.equal(message.payload.sessionId, ui.state.sessionId);
  assert.equal(message.payload.editorToken, ui.state.active.editorToken);
  assert.ok(!message.envelope.encoded.includes('`'));
  assert.ok(!message.envelope.encoded.includes('${'));
  assert.ok(!message.envelope.encoded.includes('<script>'));
});

test('asynchronous screenshot/error states keep the text being edited for the same capture', () => {
  const ui = bootEditor();
  ui.push(ui.state);
  assert.equal(ui.document.activeElement.id, 'note-text');
  assert.equal(ui.nodes.get('capture-position').textContent, '00:32:18.123');
  const input = ui.nodes.get('note-text');
  input.value = '这段刚刚写下的文字还没有收到确认';
  input.events.input();
  ui.push({ ...ui.state, focus: false, active: { ...ui.state.active, text: 'outdated response', imageStatus: 'failed', imageError: '模拟截图失败' } });
  assert.equal(input.value, '这段刚刚写下的文字还没有收到确认');
  ui.push({ ...ui.state, focus: false, error: '模拟保存失败' });
  assert.equal(input.value, '这段刚刚写下的文字还没有收到确认');
  assert.equal(ui.nodes.get('global-error').textContent, '模拟保存失败');
  ui.push({ ...ui.state, active: { ...ui.state.active, id: 'capture-0002', text: '另一条草稿' } });
  assert.equal(input.value, '另一条草稿');
});

test('double save sends one save request and a failed response permits retry', () => {
  const ui = bootEditor();
  ui.push(ui.state);
  const button = ui.nodes.get('save-note');
  button.click();
  button.events.click();
  assert.equal(ui.messages.filter((message) => message.payload.type === 'save').length, 1);
  assert.equal(button.disabled, true);
  ui.push({ ...ui.state, focus: false, error: '磁盘空间不足' });
  button.click();
  assert.equal(ui.messages.filter((message) => message.payload.type === 'save').length, 2);
});

test('image failure allows an explicit text-only save and never silently drops the image', () => {
  const ui = bootEditor();
  ui.push({ ...ui.state, active: { ...ui.state.active, imageStatus: 'failed', imageError: '截图超时' } });
  const input = ui.nodes.get('note-text');
  input.value = '即使截图失败，也要保留时间位置和文字';
  input.events.input();
  assert.equal(ui.nodes.get('save-note').disabled, true);
  const include = ui.nodes.get('include-image');
  include.checked = false;
  include.events.change();
  assert.equal(ui.nodes.get('save-note').disabled, false);
  ui.nodes.get('save-note').click();
  const save = ui.messages.at(-1).payload;
  assert.equal(save.type, 'save');
  assert.equal(save.includeImage, false);
  assert.equal(save.text, input.value);
});

test('settings edits survive background updates and the capture shows its pinned output directory', () => {
  const ui = bootEditor();
  const state = { ...ui.state, focus: false, view: 'settings', active: { ...ui.state.active, outputPath: '/Users/test/原保存目录' } };
  ui.push(state);
  assert.equal(ui.nodes.get('editor-output').textContent, '/Users/test/原保存目录');
  assert.equal(ui.nodes.get('settings-output').textContent, state.settings.outputPath);
  const shortcut = ui.nodes.get('shortcut-setting');
  shortcut.value = 'Meta+Alt+n';
  shortcut.events.input();
  ui.push(state);
  assert.equal(shortcut.value, 'Meta+Alt+n');
  ui.nodes.get('save-settings').click();
  assert.equal(ui.messages.at(-1).payload.settings.shortcut, 'Meta+Alt+n');
});

test('draft titles are inserted as text and a new WebView document registers one ready handshake', () => {
  const ui = bootEditor();
  ui.push({ ...ui.state, view: 'drafts', drafts: [{ id: 'draft-00001', title: '<script>alert(1)</script>', positionMs: 12000, capturedAt: ui.state.active.capturedAt }] });
  const card = ui.nodes.get('draft-list').children[0];
  assert.equal(card.children[0].children[0].textContent, '<script>alert(1)</script>');
  card.click();
  assert.equal(ui.messages.at(-1).payload.id, 'draft-00001');
  assert.equal(ui.messages.at(-1).payload.type, 'restore');
  ui.handlers['vn-state']({ encoded: 'broken%payload' });
  ui.push({ ...ui.state, clientId: 'a-different-ui', active: { ...ui.state.active, title: 'stale window' } });
  assert.notEqual(ui.nodes.get('video-title').textContent, 'stale window');
  const reloaded = bootEditor();
  assert.equal(ui.registrations, 1);
  assert.equal(reloaded.registrations, 1);
  assert.equal(reloaded.messages.filter((message) => message.payload.type === 'ready').length, 1);
  assert.equal(reloaded.messages.filter((message) => message.payload.type === 'save').length, 0);
});

test('partial states retain only the same capture preview, while null and a new capture clear it', () => {
  const ui = bootEditor();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0v8AAAAASUVORK5CYII=';
  const image = ui.nodes.get('capture-preview');
  ui.push({ ...ui.state, active: { ...ui.state.active, previewDataUrl: png } });
  assert.equal(image.getAttribute('src'), png);
  assert.equal(image.hidden, false);

  // Ordinary edit acknowledgements omit the image bytes to keep the bridge small.
  ui.push({ ...ui.state, focus: false, active: { ...ui.state.active, text: 'small update' } });
  assert.equal(image.getAttribute('src'), png);
  assert.equal(image.hidden, false);

  // Explicit null is a state change, not the absence of a delta.
  ui.push({ ...ui.state, focus: false, active: { ...ui.state.active, previewDataUrl: null } });
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.hidden, true);
  ui.push({ ...ui.state, focus: false });
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.hidden, true);

  ui.push({ ...ui.state, active: { ...ui.state.active, previewDataUrl: png } });
  assert.equal(image.hidden, false);
  ui.push({ ...ui.state, active: { ...ui.state.active, id: 'capture-0002' } });
  assert.equal(image.getAttribute('src'), null);
  assert.equal(image.hidden, true);
});

test('restored and reloaded editors show the requested subtitle mode without mislabelling the existing image', () => {
  const ui = bootEditor();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0v8AAAAASUVORK5CYII=';
  const active = { ...ui.state.active, text: '原有草稿', subtitleMode: 'subtitles', requestedSubtitleMode: 'video', needsRetry: true, previewDataUrl: png };
  ui.push({ ...ui.state, active });
  assert.equal(ui.nodes.get('subtitle-mode').value, 'video');
  assert.equal(ui.nodes.get('preview-mode').textContent, '包含字幕');
  assert.equal(ui.nodes.get('capture-preview').hidden, false);
  assert.equal(ui.nodes.get('image-warning').hidden, false);
  assert.equal(ui.nodes.get('retry-image').hidden, false);
  assert.equal(ui.nodes.get('save-note').disabled, true);

  // An edit must send the selected/requested mode, never silently revert it to
  // the old screenshot mode after restoring a draft or reloading the WebView.
  const input = ui.nodes.get('note-text');
  input.value = '继续写下的文字'; input.events.input();
  assert.equal(ui.messages.at(-1).payload.subtitleMode, 'video');
  ui.push({ ...ui.state, focus: false, active: { ...active, text: 'stale response' } });
  assert.equal(input.value, '继续写下的文字');
  assert.equal(ui.nodes.get('subtitle-mode').value, 'video');

  // A subsequent successful capture makes the requested mode the real mode.
  ui.push({ ...ui.state, focus: false, active: { ...active, subtitleMode: 'video', requestedSubtitleMode: 'video', needsRetry: false } });
  assert.equal(ui.nodes.get('preview-mode').textContent, '不含字幕');
  assert.equal(ui.nodes.get('image-warning').hidden, true);
  assert.equal(ui.nodes.get('retry-image').hidden, true);
  assert.equal(ui.nodes.get('save-note').disabled, false);

  const reloaded = bootEditor();
  reloaded.push({ ...reloaded.state, active });
  assert.equal(reloaded.nodes.get('subtitle-mode').value, 'video');
  assert.equal(reloaded.nodes.get('preview-mode').textContent, '包含字幕');
  assert.equal(reloaded.nodes.get('image-warning').hidden, false);
  assert.equal(reloaded.nodes.get('save-note').disabled, true);
});

test('a new editor token refreshes a restored capture while same-token updates preserve typing', () => {
  const ui = bootEditor();
  const original = { ...ui.state.active, editorToken: 'editor-first', text: '最初恢复的正文' };
  ui.push({ ...ui.state, active: original });
  const input = ui.nodes.get('note-text');
  assert.equal(input.value, '最初恢复的正文');
  input.value = '尚在输入中的文字'; input.events.input();
  ui.push({ ...ui.state, focus: false, active: { ...original, text: '旧的异步回执' } });
  assert.equal(input.value, '尚在输入中的文字');

  // Another window may have updated this draft. Reopening its unchanged ID
  // with a new editor token must restore the actual text and form options.
  const restored = { ...original, editorToken: 'editor-restored', text: '另一窗口已保存的新正文', includeImage: false, requestedSubtitleMode: 'video', needsRetry: true };
  ui.push({ ...ui.state, focus: false, active: restored });
  assert.equal(input.value, '另一窗口已保存的新正文');
  assert.equal(ui.nodes.get('include-image').checked, false);
  assert.equal(ui.nodes.get('subtitle-mode').value, 'video');
  assert.equal(ui.document.activeElement.id, 'note-text');

  input.value = '恢复后继续写'; input.events.input();
  ui.push({ ...ui.state, focus: false, active: { ...restored, text: '另一窗口已保存的新正文', imageStatus: 'ready' } });
  assert.equal(input.value, '恢复后继续写');
  ui.push({ ...ui.state, focus: false, active: null });
  ui.push({ ...ui.state, active: { ...restored, text: '关闭后重新打开的内容' } });
  assert.equal(input.value, '关闭后重新打开的内容');
});

test('all editor mutations include the current editor token', () => {
  for (const type of ['edit', 'save', 'close', 'retry-image']) {
    const ui = bootEditor();
    const active = { ...ui.state.active, editorToken: 'editor-restored-latest', text: '最新草稿', imageStatus: type === 'retry-image' ? 'failed' : 'ready' };
    ui.push({ ...ui.state, active });
    if (type === 'edit') ui.nodes.get('note-text').events.input();
    else ui.nodes.get({ save: 'save-note', close: 'close-editor', 'retry-image': 'retry-image' }[type]).click();
    const action = ui.messages.at(-1).payload;
    assert.equal(action.type, type);
    assert.equal(action.editorToken, 'editor-restored-latest');
    assert.equal(action.id, active.id);
    assert.equal(action.sessionId, ui.state.sessionId);
    assert.equal(action.clientId, ui.state.clientId);
  }
});

test('a pinned draft changes destination only after an explicit retarget click with the latest form values', () => {
  const ui = bootEditor();
  const active = { ...ui.state.active, editorToken: 'editor-retarget', outputPath: '/Users/test/old-inbox', canRetarget: true };
  ui.push({ ...ui.state, active });
  const button = ui.nodes.get('retarget-output');
  assert.equal(button.hidden, false);
  assert.equal(ui.nodes.get('editor-output').textContent, '/Users/test/old-inbox');
  assert.equal(ui.messages.filter((message) => message.payload.type === 'retarget').length, 0);
  ui.push({ ...ui.state, focus: false, active });
  assert.equal(ui.messages.filter((message) => message.payload.type === 'retarget').length, 0);

  ui.nodes.get('note-text').value = '点击改存时的最新正文';
  ui.nodes.get('include-image').checked = false;
  ui.nodes.get('subtitle-mode').value = 'video';
  button.click();
  button.events.click();
  const retargets = ui.messages.filter((message) => message.payload.type === 'retarget');
  assert.equal(retargets.length, 1);
  const action = retargets[0].payload;
  assert.equal(action.text, '点击改存时的最新正文');
  assert.equal(action.includeImage, false);
  assert.equal(action.subtitleMode, 'video');
  assert.equal(action.editorToken, active.editorToken);
  assert.equal(action.id, active.id);
  assert.equal(action.sessionId, ui.state.sessionId);
  assert.equal(action.clientId, ui.state.clientId);

  ui.push({ ...ui.state, focus: false, active: { ...active, canRetarget: false } });
  assert.equal(button.hidden, true);
  button.events.click();
  assert.equal(ui.messages.filter((message) => message.payload.type === 'retarget').length, 1);
  ui.push({ ...ui.state, focus: false, active: { ...active, phase: 'saving' } });
  assert.equal(button.hidden, true);
});
