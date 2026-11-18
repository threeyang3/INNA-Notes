/* IINA's WebView is separate from the JavaScriptCore plugin context. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clientId = 'ui-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let state = null;
  let editorId = null;
  let editorToken = null;
  let lastView = null;
  let pendingSave = false;
  let settingsDirty = false;
  let lastDraftSignature = '';
  const bridge = typeof iina === 'object' ? iina : null;

  function decode(envelope) {
    if (!envelope || typeof envelope.encoded !== 'string' || envelope.encoded.length > 32 * 1024 * 1024) return null;
    try { return JSON.parse(decodeURIComponent(envelope.encoded)); } catch (_) { return null; }
  }

  function send(type, fields) {
    if (!bridge || typeof bridge.postMessage !== 'function') return;
    const action = Object.assign({ type, clientId }, fields || {});
    if (state) action.sessionId = state.sessionId;
    if (state && state.active && action.id === undefined) action.id = state.active.id;
    if (state && state.active && ['edit', 'save', 'close', 'retry-image', 'retarget'].indexOf(type) >= 0) {
      action.editorToken = state.active.editorToken;
    }
    // IINA 1.5.0 embeds bridge JSON in a JS template literal. Encoding the
    // complete payload prevents backticks/${...} in user text being evaluated.
    bridge.postMessage('vn-action', { encoded: encodeURIComponent(JSON.stringify(action)) });
  }

  function editorFields() {
    return { text: $('note-text').value, includeImage: $('include-image').checked, subtitleMode: $('subtitle-mode').value };
  }

  function formatPosition(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    const ms = value % 1000;
    const seconds = Math.floor(value / 1000);
    const pad = (n, length) => String(n).padStart(length, '0');
    return pad(Math.floor(seconds / 3600), 2) + ':' + pad(Math.floor(seconds / 60) % 60, 2) + ':' + pad(seconds % 60, 2) + '.' + pad(ms, 3);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value || '';
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function showMessage(id, value) {
    $(id).textContent = typeof value === 'string' ? value : '';
    $(id).hidden = !$(id).textContent;
  }

  function shortcutLabel(value) {
    if (!value) return '使用「创建视频笔记」菜单';
    return value.split('+').map((part) => ({ Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }[part] || part.toUpperCase())).join(' ');
  }

  function renderEditor(active, resetFields) {
    $('empty-state').hidden = !!active;
    $('capture-editor').hidden = !active;
    if (!active) { editorId = null; editorToken = null; return; }
    $('video-title').textContent = active.title;
    $('video-title').title = active.title;
    $('capture-position').textContent = formatPosition(active.positionMs);
    $('captured-date').textContent = formatDate(active.capturedAt) + ' 捕获';
    if (resetFields) {
      $('note-text').value = active.text || '';
      $('include-image').checked = active.includeImage !== false;
      $('subtitle-mode').value = (active.requestedSubtitleMode || active.subtitleMode) === 'video' ? 'video' : 'subtitles';
      editorId = active.id;
      editorToken = typeof active.editorToken === 'string' ? active.editorToken : null;
    }
    const includeImage = $('include-image').checked;
    const busy = active.phase === 'saving';
    const saved = active.phase === 'saved';
    $('note-text').readOnly = busy || saved;
    $('include-image').disabled = busy || saved;
    $('subtitle-mode').disabled = !includeImage || busy || saved || active.imageStatus === 'capturing';
    $('preview-area').classList.toggle('no-image', !includeImage);
    const preview = typeof active.previewDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(active.previewDataUrl) ? active.previewDataUrl : '';
    const hasPreview = includeImage && !!preview && active.imageStatus === 'ready';
    $('capture-preview').hidden = !hasPreview;
    $('preview-placeholder').hidden = hasPreview;
    if (hasPreview) {
      if ($('capture-preview').getAttribute('src') !== preview) $('capture-preview').src = preview;
    } else {
      $('capture-preview').removeAttribute('src');
    }
    $('preview-mode').hidden = !hasPreview;
    $('preview-mode').textContent = active.subtitleMode === 'video' ? '不含字幕' : '包含字幕';
    let previewStatus = '尚未截取画面';
    let previewDetail = '';
    if (!includeImage) { previewStatus = '这条笔记仅保存文字与时间位置'; }
    else if (active.imageStatus === 'capturing') { previewStatus = '正在截取画面…'; previewDetail = '你可以先写下文字'; }
    else if (active.imageStatus === 'failed') { previewStatus = '截图未完成'; previewDetail = active.imageError || '可以重试截图，或取消「附上截图」后保存文字。'; }
    else if (active.imageStatus === 'ready' && !preview) { previewStatus = '截图已就绪'; previewDetail = '此图片未显示预览，仍可随笔记保存。'; }
    $('preview-status').textContent = previewStatus;
    $('preview-detail').textContent = previewDetail;
    const modeChanged = $('subtitle-mode').value !== active.subtitleMode;
    const needsRetry = !!active.needsRetry || modeChanged;
    $('retry-image').hidden = !includeImage || saved || (active.imageStatus !== 'failed' && active.imageStatus !== 'none' && !needsRetry);
    $('retry-image').disabled = busy || active.imageStatus === 'capturing';
    $('retry-image').querySelector('span').textContent = needsRetry ? '重新截图' : '重试截图';
    const warning = includeImage && needsRetry ? '字幕模式已改变。请回到原捕获位置后重新截图，或保留原模式。' : (includeImage && active.imageStatus === 'failed' ? '重试截图需要同一视频仍停在原捕获位置；不会自动跳转视频。' : '');
    showMessage('image-warning', warning);
    $('draft-status').textContent = active.draftWarning || (saved ? '已保存为独立 Markdown 与图片' : '输入会自动保留为本地草稿');
    $('draft-status').classList.toggle('warning', !!active.draftWarning);
    $('save-result').hidden = !saved;
    $('saved-path').textContent = active.savedPath || '';
    $('close-editor').textContent = saved ? '完成' : '保留草稿并关闭';
    $('close-editor').disabled = busy;
    $('close-editor').classList.toggle('primary-button', saved);
    $('close-editor').classList.toggle('secondary-button', !saved);
    $('save-note').hidden = saved;
    $('retarget-output').hidden = active.canRetarget !== true || busy || saved;
    $('retarget-output').disabled = active.canRetarget !== true || busy || saved;
    updateSaveButton();
  }

  function updateSaveButton() {
    const active = state && state.active;
    if (!active) return;
    const text = $('note-text').value;
    const includeImage = $('include-image').checked;
    const needsRetry = !!active.needsRetry || $('subtitle-mode').value !== active.subtitleMode;
    const imageReady = active.imageStatus === 'ready' && !needsRetry;
    const canSave = (includeImage ? imageReady : text.trim().length > 0) && (includeImage || text.trim().length > 0);
    $('save-note').disabled = !canSave || pendingSave || active.phase === 'saving' || active.phase === 'saved';
    $('save-label').textContent = active.phase === 'saving' || pendingSave ? '正在保存…' : (includeImage && !text.trim() ? '保存截图' : (!includeImage ? '保存文字' : '保存笔记'));
    $('character-count').textContent = text.length + ' 字';
  }

  function renderSettings(settings, reset) {
    $('settings-output').textContent = settings.outputPath || '插件数据目录';
    const captureOutput = (state && state.active && state.active.outputPath) || settings.outputPath || '插件数据目录';
    $('editor-output').textContent = captureOutput;
    $('editor-output').title = captureOutput;
    $('capture-shortcut').textContent = shortcutLabel(settings.shortcut);
    if (!reset && settingsDirty) return;
    $('default-subtitles').checked = settings.includeSubtitles !== false;
    $('auto-pause').checked = !!settings.autoPause;
    $('include-source-path').checked = settings.includeSourcePath !== false;
    $('shortcut-setting').value = settings.shortcut || '';
    settingsDirty = false;
  }

  function renderDrafts(drafts) {
    const entries = Array.isArray(drafts) ? drafts : [];
    $('draft-count').hidden = entries.length === 0;
    $('draft-count').textContent = String(entries.length);
    $('drafts-empty').hidden = entries.length > 0;
    const signature = JSON.stringify(entries);
    if (signature === lastDraftSignature) return;
    lastDraftSignature = signature;
    $('draft-list').replaceChildren();
    entries.forEach((draft) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'draft-card';
      const details = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = draft.title;
      const date = document.createElement('small'); date.textContent = formatDate(draft.capturedAt);
      details.appendChild(title); details.appendChild(date);
      const time = document.createElement('span'); time.className = 'draft-position'; time.textContent = formatPosition(draft.positionMs);
      button.appendChild(details); button.appendChild(time);
      button.setAttribute('aria-label', '继续草稿：' + draft.title + '，' + formatPosition(draft.positionMs));
      button.addEventListener('click', () => send('restore', { id: draft.id }));
      $('draft-list').appendChild(button);
    });
  }

  function receive(envelope) {
    const incoming = decode(envelope);
    if (!incoming || incoming.clientId !== clientId || typeof incoming.sessionId !== 'string') return;
    // Preview pixels cross the native bridge only when changed. Ordinary text
    // edits carry a small state update and retain this capture's existing image.
    if (incoming.active && state && state.active && incoming.active.id === state.active.id &&
        !Object.prototype.hasOwnProperty.call(incoming.active, 'previewDataUrl')) {
      incoming.active.previewDataUrl = state.active.previewDataUrl;
    }
    const first = !state;
    state = incoming;
    pendingSave = state.active && state.active.phase === 'saving';
    const view = ['editor', 'settings', 'drafts'].indexOf(state.view) >= 0 ? state.view : 'editor';
    $('editor-view').hidden = view !== 'editor';
    $('settings-view').hidden = view !== 'settings';
    $('drafts-view').hidden = view !== 'drafts';
    ['settings', 'drafts'].forEach((name) => {
      const button = $('open-' + name);
      if (view === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      button.disabled = !!(state.active && state.active.phase === 'saving');
    });
    // A restore can reopen the same capture ID with newer disk content. Only
    // a new editor token (or capture ID) replaces local form values; ordinary
    // asynchronous state messages for this editor leave typing untouched.
    const nextEditorToken = state.active && typeof state.active.editorToken === 'string' ? state.active.editorToken : null;
    const newEditor = !!state.active && (editorId !== state.active.id || editorToken !== nextEditorToken);
    renderEditor(state.active, first || newEditor);
    renderSettings(state.settings || {}, first || (view === 'settings' && lastView !== 'settings'));
    renderDrafts(state.drafts);
    showMessage('global-error', state.error);
    showMessage('global-notice', state.notice);
    if (view === 'editor' && state.active && state.active.phase !== 'saved' && (first || newEditor || state.focus)) {
      // Focus only when this instance explicitly opened/reopened the editor.
      $('note-text').focus();
    }
    lastView = view;
  }

  function edit() {
    if (!state || !state.active || state.active.phase !== 'editing') return;
    updateSaveButton();
    send('edit', editorFields());
  }

  $('note-text').addEventListener('input', edit);
  $('include-image').addEventListener('change', () => { edit(); if (state) renderEditor(state.active, false); });
  $('subtitle-mode').addEventListener('change', () => { edit(); if (state) renderEditor(state.active, false); });
  $('save-note').addEventListener('click', () => {
    if ($('save-note').disabled) return;
    pendingSave = true; updateSaveButton(); send('save', editorFields());
  });
  $('close-editor').addEventListener('click', () => send('close', editorFields()));
  $('retry-image').addEventListener('click', () => send('retry-image', editorFields()));
  $('retarget-output').addEventListener('click', () => {
    if ($('retarget-output').hidden || $('retarget-output').disabled) return;
    $('retarget-output').disabled = true;
    send('retarget', editorFields());
  });
  $('open-settings').addEventListener('click', () => { if (state && state.active && state.active.phase === 'editing') send('edit', editorFields()); send('settings'); });
  $('open-drafts').addEventListener('click', () => { if (state && state.active && state.active.phase === 'editing') send('edit', editorFields()); send('drafts'); });
  document.querySelectorAll('[data-back]').forEach((button) => button.addEventListener('click', () => send('back')));
  ['editor-show-output', 'settings-show-output'].forEach((id) => $(id).addEventListener('click', () => send('show-output')));
  $('select-directory').addEventListener('click', () => send('select-dir'));
  $('use-default').addEventListener('click', () => send('use-default'));
  ['default-subtitles', 'auto-pause', 'include-source-path', 'shortcut-setting'].forEach((id) => $(id).addEventListener('input', () => { settingsDirty = true; }));
  $('save-settings').addEventListener('click', () => {
    settingsDirty = false;
    send('settings-change', { settings: { includeSubtitles: $('default-subtitles').checked, autoPause: $('auto-pause').checked, includeSourcePath: $('include-source-path').checked, shortcut: $('shortcut-setting').value.trim() } });
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && event.metaKey && state && state.view === 'editor' && state.active) { event.preventDefault(); $('save-note').click(); }
    if (event.key === 'Escape' && state) {
      event.preventDefault();
      if (state.view !== 'editor') send('back');
      else if (!state.active || state.active.phase !== 'saving') send('close', editorFields());
    }
  });
  window.addEventListener('pagehide', () => { if (state && state.active && state.active.phase === 'editing') send('edit', editorFields()); });
  $('capture-preview').addEventListener('error', () => {
    $('capture-preview').hidden = true; $('preview-placeholder').hidden = false;
    $('preview-status').textContent = '预览暂时无法显示';
    $('preview-detail').textContent = '保存前仍会检查截图文件是否完整。';
    $('preview-mode').hidden = true;
  });

  if (bridge && typeof bridge.onMessage === 'function') {
    // Registered exactly once per document. Reload asks the plugin for state;
    // it never asks the plugin to register another handler or create a capture.
    bridge.onMessage('vn-state', receive);
    send('ready');
  } else {
    showMessage('global-error', '此面板需要由 IINA Video Notes 插件打开。');
    $('open-settings').disabled = true; $('open-drafts').disabled = true;
  }
}());
