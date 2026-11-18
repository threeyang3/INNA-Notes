"use strict";

const { createSnapshot } = require("./capture.js");
const { DraftStore, randomId, MAX_TEXT } = require("./storage.js");
const { NativeFiles } = require("./native.js");
const { normalizeAbsolutePath, formatPosition } = require("./protocol.js");

const DEFAULTS = { outputPath: "", includeSubtitles: true, autoPause: false, includeSourcePath: true, shortcut: "Meta+Shift+n" };
function errorMessage(error) { return error && error.message ? error.message : String(error); }
function encode(payload) { return { encoded: encodeURIComponent(JSON.stringify(payload)) }; }
function decode(envelope) {
  if (!envelope || typeof envelope.encoded !== "string" || envelope.encoded.length > 2 * 1024 * 1024) throw new Error("面板消息无效或过大。");
  const value = JSON.parse(decodeURIComponent(envelope.encoded));
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw new Error("面板消息无效。");
  return value;
}

class NotesSession {
  constructor(api, timers, files) {
    this.api = api; this.timers = timers;
    this.files = files || new NativeFiles(api, ms => timers.delay(ms));
    this.sessionId = randomId("session");
    this.store = new DraftStore(this.files, this.sessionId, root => this.isAuthorized(root));
    this.settings = Object.assign({}, DEFAULTS);
    this.active = null; this.epoch = 0; this.loading = false; this.disposed = false;
    this.ready = false; this.uiInitialized = false; this.clientId = null;
    this.view = "editor"; this.error = ""; this.notice = ""; this.drafts = [];
    this.listeners = []; this.monitor = null; this.pauseLease = null; this.operations = new Set();
    this.lastPreview = undefined; this.lastPreviewId = null;
    this.restoreGeneration = 0;
  }

  async start() {
    this.readSettings(); this.installMenus(); this.installEvents();
    try {
      const version = String(this.api.core.getVersion().iina || "").split(".").map(Number);
      if (!Number.isFinite(version[0]) || version[0] < 1 || (version[0] === 1 && (!Number.isFinite(version[1]) || version[1] < 5))) {
        throw new Error("此版本需要 IINA 1.5.0 或更新版本。请升级后重新启用插件。");
      }
      await this.files.initialize();
      if (!this.disposed) this.ready = true;
    } catch (error) { this.error = "初始化失败：" + errorMessage(error); }
    this.sendState(false);
  }

  readSettings() {
    const next = {};
    for (const key of Object.keys(DEFAULTS)) {
      const value = this.api.preferences.get(key);
      next[key] = typeof value === typeof DEFAULTS[key] ? value : DEFAULTS[key];
    }
    if (next.outputPath) {
      try { next.outputPath = normalizeAbsolutePath(next.outputPath); }
      catch (_) { next.outputPath = ""; }
    }
    if (!this.validShortcut(next.shortcut)) next.shortcut = DEFAULTS.shortcut;
    this.settings = next;
  }
  validShortcut(value) {
    return typeof value === "string" && !/[\r\n\0]/.test(value) &&
      (value === "" || /^(?:(?:Meta|Ctrl|Alt|Shift)\+){1,4}[A-Za-z0-9]$/.test(value));
  }
  isAuthorized(root) {
    if (root === this.files.defaultRoot) return true;
    const roots = this.api.preferences.get("authorizedRoots");
    return Array.isArray(roots) && roots.includes(root);
  }
  installMenus() {
    const menu = this.api.menu;
    menu.removeAllItems();
    menu.addItem(menu.item("创建视频笔记", () => this.capture(), { keyBinding: this.settings.shortcut }));
    menu.addItem(menu.item("未保存的视频笔记…", () => this.run(() => this.showDrafts())));
    menu.addItem(menu.item("视频笔记设置…", () => this.showSettings()));
    menu.addItem(menu.item("查看视频笔记输出目录", () => this.showOutput()));
    menu.forceUpdate();
  }
  listen(name, callback) { this.listeners.push([name, this.api.event.on(name, callback)]); }
  installEvents() {
    const changeFile = () => {
      this.loading = true; this.epoch++; this.pauseLease = null;
      for (const view of this.operations) {
        view.invalidated = true;
        view.record.image.invalidated = true;
        this.persist(view);
      }
    };
    this.listen("mpv.start-file", changeFile);
    this.listen("mpv.end-file", changeFile);
    this.listen("iina.file-loaded", () => { this.loading = false; });
    this.listen("mpv.file-loaded", () => { this.loading = false; });
    this.listen("mpv.seek", () => {
      this.pauseLease = null;
      for (const view of this.operations) {
        view.invalidated = true; view.record.image.invalidated = true; this.persist(view);
      }
    });
    this.listen("mpv.pause.changed", value => this.observePause(value));
    // IINA pools idle PlayerCore instances. Window close is NOT plugin teardown.
    this.listen("iina.window-will-close", () => this.suspend());
  }

  nativeStatus() {
    const status = this.api.core.status;
    const path = this.api.mpv.getString("path");
    const url = status.url;
    if (status.isNetworkResource !== false || typeof url !== "string" || !url.startsWith("file://")) {
      throw new Error("本轮只支持已经载入的本地视频，不支持网络或在线视频。");
    }
    const position = this.api.mpv.getNative("time-pos");
    const paused = this.api.mpv.getNative("pause");
    const video = this.api.mpv.getNative("video-params");
    if (this.loading || this.api.mpv.getNative("idle-active") !== false ||
        this.api.mpv.getNative("seeking") === true || !video || !(video.w > 0) || !(video.h > 0)) {
      throw new Error("请先载入本地视频，并等待加载或跳转完成。");
    }
    const result = { path, url, position, paused, title: status.title,
      duration: this.api.mpv.getNative("duration"), idle: status.idle, isNetworkResource: status.isNetworkResource };
    if (path !== this.api.mpv.getString("path") || url !== status.url ||
        (url !== "file://" + path && url !== "file://localhost" + path)) throw new Error("视频来源状态尚未一致，请等待加载完成后再试。");
    return result;
  }

  capture() {
    if (this.disposed) return;
    this.readSettings(); this.installMenus();
    if (!this.ready) { this.error = this.error || "插件正在准备本地目录，请稍后再试。"; this.open("editor"); return; }
    if (this.active && this.active.phase !== "saved") {
      this.notice = "继续当前草稿。要捕获新的位置，请先保存，或保留草稿并关闭面板。";
      this.open("editor"); return;
    }
    try {
      let id;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = randomId("capture");
        if (!this.files.exists(this.store.draftPath(candidate))) { id = candidate; break; }
      }
      if (!id) throw new Error("无法分配唯一捕获 ID，请重试。");
      const snapshot = createSnapshot(this.nativeStatus(), { id, now: new Date(), loading: this.loading });
      const record = this.store.create(snapshot, this.epoch, this.settings);
      this.restoreGeneration++;
      const view = { record, editorToken: randomId("editor"), phase: "editing", preview: null, draftWarning: "", savedPath: "", invalidated: false };
      this.active = view; this.error = ""; this.notice = "";
      this.takePause(snapshot);
      // No await between reading playback time and submitting the screenshot.
      this.beginImage(view);
      this.open("editor");
    } catch (error) { this.fail(error); this.open("editor"); }
  }

  beginImage(view) {
    const record = view.record;
    const attempt = record.image.attempt + 1;
    record.image = { attempt, mode: record.subtitleMode, status: "capturing", error: "", invalidated: false };
    view.preview = null; view.invalidated = false;
    try {
      const path = this.store.imagePath(record, attempt);
      if (this.files.exists(path)) throw new Error("截图文件已存在，已停止以避免覆盖。");
      this.api.mpv.command("async", ["raw", "no-osd", "screenshot-to-file", path, record.image.mode]);
      this.persist(view);
      this.operations.add(view);
      this.run(() => this.waitImage(view, attempt, path));
    } catch (error) {
      record.image.status = "failed"; record.image.error = errorMessage(error);
      this.persist(view); this.sendState(false);
    }
  }

  async waitImage(view, attempt, path) {
    let previousSize = -1;
    try {
      for (let check = 0; check < 60; check++) {
        await this.timers.delay(100);
        if (this.disposed || view.record.image.attempt !== attempt) return;
        if (view.invalidated || this.epoch !== view.record.originEpoch ||
            this.api.mpv.getString("path") !== view.record.snapshot.sourcePath) {
          view.record.image.invalidated = true;
          throw new Error("截图确认前视频或播放位置已改变，未把可能错配的画面附到旧时间戳。可保留文字。");
        }
        let info;
        try { if (this.files.exists(path)) info = this.files.inspectImage(path); }
        catch (_) { /* asynchronous writer may not have finished */ }
        if (!info) { previousSize = -1; continue; }
        if (previousSize !== info.size) { previousSize = info.size; continue; }
        view.record.image.status = "ready";
        if (view.phase !== "saved") this.persist(view);
        this.operations.delete(view);
        view.previewPending = true;
        this.sendState(false);
        try { view.preview = await this.files.preview(path, view.record.snapshot.captureId, attempt); }
        catch (_) { view.preview = null; }
        view.previewPending = false;
        if (view.phase === "saved") {
          try { this.store.finish(view.record); } catch (_) { /* cleanup cannot invalidate a confirmed screenshot */ }
        }
        else this.sendState(false);
        return;
      }
      throw new Error("6 秒内未确认完整 PNG。已保留时间与文字；请检查截图权限、磁盘空间和视频输出，再重试或保存文字。");
    } catch (error) {
      view.record.image.status = "failed";
      view.record.image.error = errorMessage(error);
      if (!this.disposed && view.phase !== "saved") this.persist(view);
      this.sendState(false);
    } finally {
      this.operations.delete(view);
      if (view.phase === "saved" && !view.previewPending) {
        try { this.store.finish(view.record); } catch (_) { /* final output is already durable */ }
      }
    }
  }

  persist(view) {
    try { this.store.persist(view.record); view.draftWarning = ""; return true; }
    catch (error) { view.draftWarning = "草稿尚未写入磁盘：" + errorMessage(error); return false; }
  }
  applyEdit(action) {
    const view = this.active;
    if (!view || action.id !== view.record.snapshot.captureId || view.phase !== "editing") return false;
    if (typeof action.text !== "string" || action.text.length > MAX_TEXT ||
        typeof action.includeImage !== "boolean" || !["subtitles", "video"].includes(action.subtitleMode)) {
      throw new Error("文字过长或面板输入无效。单条笔记最多 100,000 个字符。");
    }
    const record = view.record;
    const changed = record.text !== action.text || record.includeImage !== action.includeImage || record.subtitleMode !== action.subtitleMode;
    record.text = action.text; record.includeImage = action.includeImage; record.subtitleMode = action.subtitleMode;
    if (changed || view.draftWarning) this.persist(view);
    return true;
  }

  async retryImage(action) {
    if (!this.applyEdit(action)) return;
    const view = this.active, record = view.record;
    if (record.image.status === "capturing") return;
    if (view.previewPending) throw new Error("截图预览正在生成，请稍后再重试截图；正文可以继续编辑。");
    if (record.originSession !== this.sessionId || record.originEpoch !== this.epoch) {
      throw new Error("原播放会话已结束。可保存草稿中已经确认的截图或文字；需要新画面时请新建捕获。");
    }
    const status = this.nativeStatus();
    if (status.path !== record.snapshot.sourcePath || status.paused !== true ||
        typeof status.position !== "number" || Math.abs(Math.round(status.position * 1000) - record.snapshot.positionMs) > 50) {
      throw new Error("请手动将同一视频暂停在 " + formatPosition(record.snapshot.positionMs) + " 附近（±50 ms），再重试。插件不会自动跳转或重载视频。");
    }
    this.error = ""; this.beginImage(view); this.sendState(false);
  }
  async retarget(action) {
    if (!this.applyEdit(action)) return;
    const view = this.active;
    view.phase = "saving"; this.error = ""; this.sendState(false);
    try {
      this.readSettings();
      await this.store.retarget(view.record, this.settings.outputPath || this.files.defaultRoot);
      this.notice = "此草稿已改用当前保存目录。原目录内容保留；请点击保存完成发布。";
    } finally { view.phase = "editing"; this.sendState(false); }
  }

  async save(action) {
    if (!this.applyEdit(action)) return;
    const view = this.active;
    view.phase = "saving"; this.nativeClosedDuringSave = false;
    this.error = ""; this.notice = ""; this.sendState(false);
    try {
      this.readSettings();
      const path = await this.store.publish(view.record, Object.assign({}, this.settings));
      view.phase = "saved"; view.savedPath = path;
      this.releasePause(true, view.record.snapshot.captureId);
      try { if (!this.operations.has(view) && !view.previewPending) this.store.finish(view.record); }
      catch (_) { this.notice = "笔记已发布；本地草稿清理未完成，可稍后查看。"; }
      if (this.active === view) this.notice = this.notice || "已保存。Markdown 与图片可以独立阅读。";
      try { this.api.core.osd(this.active === view ? "视频笔记已保存" : "上一条视频笔记已保存"); } catch (_) { /* window may have closed */ }
    } catch (error) {
      view.phase = "editing";
      if (this.active === view) this.error = "保存未完成：" + errorMessage(error);
      if ((this.nativeClosedDuringSave || this.active !== view) && !this.disposed) {
        try { this.api.core.osd("视频笔记保存失败，草稿已保留；再次创建笔记可继续处理。"); } catch (_) { /* player closing */ }
      }
    }
    this.sendState(false);
  }

  takePause(snapshot) {
    this.pauseLease = null;
    if (!this.settings.autoPause || snapshot.wasPaused) return;
    this.pauseLease = { id: snapshot.captureId, path: snapshot.sourcePath, epoch: this.epoch, position: snapshot.positionMs,
      acknowledged: false, requestedAt: Date.now() };
    this.api.core.pause();
  }
  observePause(value) {
    const lease = this.pauseLease;
    if (!lease) return;
    const actual = this.api.mpv.getNative("pause");
    if (value !== true || actual !== true) { this.pauseLease = null; return; }
    if (!lease.acknowledged && Date.now() - lease.requestedAt <= 1500) lease.acknowledged = true;
    else this.pauseLease = null;
  }
  releasePause(restore, captureId) {
    if (captureId && this.pauseLease && this.pauseLease.id !== captureId) return;
    const lease = this.pauseLease; this.pauseLease = null;
    if (!restore || !lease || !lease.acknowledged || this.disposed || lease.epoch !== this.epoch) return;
    const position = this.api.mpv.getNative("time-pos");
    if (this.api.mpv.getNative("pause") === true && this.api.mpv.getString("path") === lease.path &&
        typeof position === "number" && Math.abs(position * 1000 - lease.position) <= 100) this.api.core.resume();
  }

  async showDrafts() {
    if (this.active && this.active.phase === "saving") return;
    if (!this.ready) { this.open("drafts"); return; }
    const result = await this.store.list();
    this.drafts = result.drafts;
    this.notice = result.unreadable ? result.unreadable + " 份草稿无法读取，原文件保留在数据目录中。" : "";
    this.open("drafts");
  }
  async restore(action) {
    if (this.active && this.active.phase === "saving") return;
    if (this.active && this.active.phase !== "saved" && !this.persist(this.active)) throw new Error(this.active.draftWarning);
    const previousView = this.active;
    const generation = ++this.restoreGeneration;
    const stillCurrent = () => !this.disposed && this.restoreGeneration === generation && this.active === previousView;
    const old = this.store.read(action.id);
    let allowInterrupted = false;
    if (old.publishing) {
      allowInterrupted = await Promise.resolve(this.api.utils.ask("这份草稿的上次保存没有结束记录。请确认原播放器窗口已关闭；如果仍在保存，请取消。要恢复吗？"));
      if (!allowInterrupted) return;
    } else if (old.ownerSession !== this.sessionId) {
      const yes = await Promise.resolve(this.api.utils.ask("将在当前播放器接管这份草稿。如果其他窗口仍在编辑它，请先关闭那个笔记面板。继续恢复？"));
      if (!yes) return;
    }
    if (!stillCurrent()) return;
    const record = await this.store.adopt(action.id, allowInterrupted);
    if (!stillCurrent()) return;
    this.releasePause(true);
    const view = { record, editorToken: randomId("editor"), phase: "editing", preview: null, draftWarning: "", savedPath: "", invalidated: false };
    if (record.image.status === "ready") {
      try {
        if (record.image.invalidated) throw new Error("上次截图时视频发生切换。");
        this.files.inspectImage(this.store.imagePath(record, record.image.attempt));
      } catch (error) { record.image.status = "failed"; record.image.error = errorMessage(error); }
    } else if (record.image.status === "capturing") {
      record.image.status = "failed"; record.image.error = "上次截图尚未确认完成，已保留文字与时间戳。";
    }
    this.active = view; this.persist(view); this.error = "";
    this.notice = "已恢复草稿，捕获 ID 和原时间戳保持不变。"; this.open("editor");
    if (record.image.status === "ready") {
      view.previewPending = true;
      try { view.preview = await this.files.preview(this.store.imagePath(record, record.image.attempt), record.snapshot.captureId, record.image.attempt); }
      catch (_) { /* valid image can still be exported */ }
      view.previewPending = false;
      this.sendState(false);
    }
  }

  showSettings() {
    if (this.active && this.active.phase === "saving") return;
    this.readSettings(); this.open("settings");
  }
  async chooseDirectory() {
    // IINA's cancelled chooser may not settle: never lock the editor behind it.
    const selected = await Promise.resolve(this.api.utils.chooseFile("选择 Video Captures / IINA 收件箱目录", { chooseDir: true }));
    if (!selected || this.disposed) return;
    const root = await this.files.canonicalRoot(selected);
    await this.files.prepareOutput(root);
    let roots = this.api.preferences.get("authorizedRoots");
    roots = Array.isArray(roots) ? roots.filter(value => typeof value === "string") : [];
    if (!roots.includes(root)) roots.push(root);
    this.api.preferences.set("authorizedRoots", roots);
    this.api.preferences.set("outputPath", root); this.api.preferences.sync();
    this.readSettings(); this.notice = "已更新保存位置。旧记录保留原处；已开始保存的草稿仍使用原目标目录。";
    this.error = ""; this.sendState(false);
  }
  updateSettings(settings) {
    if (!settings || typeof settings.includeSubtitles !== "boolean" || typeof settings.autoPause !== "boolean" ||
        typeof settings.includeSourcePath !== "boolean" || !this.validShortcut(settings.shortcut)) {
      throw new Error("设置无效。快捷键可用 Meta+Shift+n 等修饰键组合，留空则仅用菜单。");
    }
    for (const key of ["includeSubtitles", "autoPause", "includeSourcePath", "shortcut"]) this.api.preferences.set(key, settings[key]);
    this.api.preferences.sync(); this.readSettings(); this.installMenus();
    this.notice = "设置已保存。"; this.error = ""; this.sendState(false);
  }
  showOutput() {
    this.readSettings();
    const root = this.active && this.active.record.plan ? this.active.record.plan.root : this.settings.outputPath || this.files.defaultRoot;
    if (!this.isAuthorized(root)) { this.fail(new Error("请先在设置中选择保存目录。")); return; }
    try { this.api.file.showInFinder(root); } catch (error) { this.fail(error); }
  }

  ensureUI() {
    if (this.uiInitialized) return;
    const win = this.api.standaloneWindow;
    win.loadFile("ui/editor.html");
    // loadFile clears listeners in IINA 1.5: register afterwards, exactly once.
    win.onMessage("vn-action", envelope => {
      try {
        const action = decode(envelope);
        if (action.type === "ready") {
          if (typeof action.clientId !== "string" || action.clientId.length > 100) return;
          this.clientId = action.clientId; this.lastPreviewId = null; this.lastPreview = undefined;
          this.sendState(true); return;
        }
        if (action.clientId !== this.clientId || action.sessionId !== this.sessionId || this.disposed) return;
        this.run(() => this.action(action));
      } catch (error) { this.fail(error); }
    });
    win.setProperty({ title: "IINA Video Notes", resizable: true, hideTitleBar: false });
    win.setFrame(560, 760);
    this.uiInitialized = true;
  }
  open(view) {
    if (this.disposed) return;
    this.view = view; this.ensureUI(); this.api.standaloneWindow.open();
    this.sendState(view === "editor"); this.watchWindow();
  }
  watchWindow() {
    this.timers.clear(this.monitor);
    if (typeof this.api.standaloneWindow.isOpen !== "function") return;
    this.monitor = this.timers.set(() => {
      this.monitor = null;
      if (!this.api.standaloneWindow.isOpen()) this.close(null, true);
      else this.watchWindow();
    }, 500);
  }
  close(action, nativeClose) {
    if (this.active && this.active.phase === "saving") {
      if (nativeClose) {
        this.nativeClosedDuringSave = true; this.releasePause(true);
        this.timers.clear(this.monitor); this.monitor = null;
      }
      return;
    }
    this.restoreGeneration++;
    if (action && this.active && this.active.phase === "editing") this.applyEdit(action);
    if (this.active && this.active.phase !== "saved" && !this.persist(this.active)) {
      this.error = this.active.draftWarning; this.sendState(false);
      if (!nativeClose) return;
      // The native red button cannot be vetoed; keep the in-memory draft reachable.
    } else this.active = null;
    this.releasePause(true); this.timers.clear(this.monitor); this.monitor = null;
    if (!nativeClose) this.api.standaloneWindow.close();
  }
  async action(action) {
    if (this.active && this.active.phase === "saving") return;
    if (["edit", "save", "close", "retry-image", "retarget"].includes(action.type) && this.active &&
        (action.id !== this.active.record.snapshot.captureId ||
         action.editorToken !== this.active.editorToken)) return;
    switch (action.type) {
      case "edit": this.applyEdit(action); this.sendState(false); break;
      case "save": await this.save(action); break;
      case "close": this.close(action, false); break;
      case "retry-image": await this.retryImage(action); break;
      case "retarget": await this.retarget(action); break;
      case "settings": this.showSettings(); break;
      case "drafts": await this.showDrafts(); break;
      case "restore": await this.restore(action); break;
      case "back": this.open("editor"); break;
      case "select-dir": await this.chooseDirectory(); break;
      case "settings-change": this.updateSettings(action.settings); break;
      case "use-default":
        this.api.preferences.set("outputPath", ""); this.api.preferences.sync(); this.readSettings();
        this.notice = "新笔记将保存到插件数据目录；原记录不移动。"; this.sendState(false); break;
      case "show-output": this.showOutput(); break;
      default: throw new Error("未知面板操作。");
    }
  }
  sendState(focus) {
    if (!this.clientId || this.disposed) return;
    const view = this.active, record = view && view.record;
    const active = view ? {
      id: record.snapshot.captureId, editorToken: view.editorToken, title: record.snapshot.videoTitle, positionMs: record.snapshot.positionMs,
      capturedAt: record.snapshot.capturedAt, text: record.text, includeImage: record.includeImage,
      subtitleMode: record.image.mode, requestedSubtitleMode: record.subtitleMode, needsRetry: record.subtitleMode !== record.image.mode,
      imageStatus: record.image.status, imageError: record.image.error,
      phase: view.phase, draftWarning: view.draftWarning, savedPath: view.savedPath,
      canRetarget: view.phase === "editing" && !!record.plan && record.plan.root !== (this.settings.outputPath || this.files.defaultRoot),
      outputPath: record.plan ? record.plan.root : (this.settings.outputPath || this.files.defaultRoot)
    } : null;
    if (view && (this.lastPreviewId !== active.id || this.lastPreview !== view.preview)) {
      active.previewDataUrl = view.preview;
      this.lastPreviewId = active.id; this.lastPreview = view.preview;
    } else if (!view) { this.lastPreviewId = null; this.lastPreview = undefined; }
    const settings = Object.assign({}, this.settings, { outputPath: this.settings.outputPath || this.files.defaultRoot });
    this.api.standaloneWindow.postMessage("vn-state", encode({ clientId: this.clientId, sessionId: this.sessionId,
      view: this.view, active, settings, drafts: this.drafts, error: this.error, notice: this.notice, focus: !!focus }));
  }
  fail(error) { this.error = errorMessage(error); this.sendState(false); }
  run(callback) { Promise.resolve().then(callback).catch(error => this.fail(error)); }
  suspend() {
    if (this.disposed) return;
    this.restoreGeneration++; this.loading = true; this.epoch++; this.pauseLease = null;
    for (const view of this.operations) {
      view.invalidated = true; view.record.image.invalidated = true;
      this.persist(view);
    }
    const view = this.active;
    if (!view || view.phase === "saved" || this.persist(view)) this.active = null;
    // If a private write failed, retain that exact in-memory draft so the next
    // menu invocation can recover it instead of binding its text to a new video.
    this.timers.clear(this.monitor); this.monitor = null;
    if (this.uiInitialized) this.api.standaloneWindow.close();
    // Pending screenshot checks stop on their next (100ms) bounded check. A
    // started file export can finish safely without leaking open binary handles.
    // Idle event listeners stay registered so a pooled player can be reused.
  }
  dispose() {
    if (this.disposed) return;
    if (this.active && this.active.phase !== "saved") this.persist(this.active);
    this.restoreGeneration++;
    this.pauseLease = null; this.disposed = true; this.timers.stop();
    for (const [name, id] of this.listeners) { try { this.api.event.off(name, id); } catch (_) { /* teardown */ } }
    this.listeners = [];
  }
}

module.exports = { NotesSession, DEFAULTS, encode, decode };
