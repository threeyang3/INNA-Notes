"use strict";

const { isCaptureId, validateSnapshot, serializeCapture, normalizeAbsolutePath } = require("./protocol.js");
const { child } = require("./native.js");

const MAX_TEXT = 100000;
function randomId(prefix) {
  // These are collision-resistant local identities, not security tokens.
  return prefix + "-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

function validateRecord(value) {
  if (!value || value.schema !== 1 || !isCaptureId(value.ownerSession) ||
      !isCaptureId(value.originSession) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isSafeInteger(value.originEpoch) || value.originEpoch < 0) throw new Error("草稿格式不兼容或已经损坏。");
  validateSnapshot(value.snapshot);
  if (typeof value.text !== "string" || value.text.length > MAX_TEXT ||
      typeof value.includeImage !== "boolean" || !["video", "subtitles"].includes(value.subtitleMode)) {
    throw new Error("草稿正文或截图选项无效。");
  }
  const image = value.image;
  if (!image || !Number.isSafeInteger(image.attempt) || image.attempt < 0 || image.attempt > 10000 ||
      !["none", "capturing", "ready", "failed"].includes(image.status) ||
      (image.mode !== "video" && image.mode !== "subtitles")) throw new Error("草稿截图记录无效。");
  if (value.plan) {
    if (normalizeAbsolutePath(value.plan.root) !== value.plan.root || typeof value.plan.markdown !== "string" ||
        typeof value.plan.includeSourcePath !== "boolean" || typeof value.plan.includeImage !== "boolean" ||
        typeof value.plan.text !== "string" || value.plan.text.length > MAX_TEXT ||
        !Number.isSafeInteger(value.plan.imageAttempt) || value.plan.imageAttempt < 0) throw new Error("草稿发布记录无效。");
    const expected = serializeCapture(value.snapshot, {
      text: value.plan.text, includeSourcePath: value.plan.includeSourcePath,
      imageRelativePath: value.plan.includeImage ? "assets/" + value.snapshot.captureId + ".png" : undefined
    });
    if (expected !== value.plan.markdown) throw new Error("草稿发布内容校验失败。");
  }
  return value;
}

class DraftStore {
  constructor(files, sessionId, isAuthorized) {
    this.files = files;
    this.sessionId = sessionId;
    this.isAuthorized = isAuthorized;
  }
  draftPath(id) {
    if (!isCaptureId(id)) throw new Error("无效草稿 ID。");
    return this.files.privatePath("drafts/" + id + ".json");
  }
  imagePath(record, attempt) {
    const id = record.snapshot.captureId;
    if (!isCaptureId(id) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10000) throw new Error("无效截图身份。");
    return this.files.privatePath("captures/" + id + "-" + attempt + ".png");
  }
  create(snapshot, epoch, settings) {
    return {
      schema: 1, ownerSession: this.sessionId, originSession: this.sessionId,
      revision: 0, originEpoch: epoch, snapshot, text: "", includeImage: true,
      subtitleMode: settings.includeSubtitles ? "subtitles" : "video",
      image: { attempt: 0, mode: settings.includeSubtitles ? "subtitles" : "video", status: "none", error: "" },
      plan: null
    };
  }
  read(id) {
    const path = this.draftPath(id);
    const handle = this.files.handle(path, "read");
    try {
      handle.seekToEnd();
      if (handle.offset() > 2 * 1024 * 1024) throw new Error("草稿超过大小限制，未自动载入。");
    } finally { handle.close(); }
    const value = validateRecord(JSON.parse(this.files.read(path)));
    if (value.snapshot.captureId !== id) throw new Error("草稿文件与捕获 ID 不一致。");
    return value;
  }
  persist(record) {
    validateRecord(record);
    const path = this.draftPath(record.snapshot.captureId);
    if (this.files.exists(path)) {
      const previous = this.read(record.snapshot.captureId);
      if (previous.revision !== record.revision || previous.ownerSession !== this.sessionId) {
        throw new Error("这条草稿已由其他播放器窗口接管。当前文字仍在面板中，请先复制文字，再重新打开草稿。");
      }
    } else if (record.revision !== 0) {
      throw new Error("草稿文件已被移走；当前内容仍在面板中，请勿关闭窗口。");
    }
    const next = Object.assign({}, record, { ownerSession: this.sessionId, revision: record.revision + 1 });
    this.files.writeText(path, JSON.stringify(next));
    record.revision = next.revision;
  }
  async list() {
    const drafts = [];
    let unreadable = 0;
    const names = this.files.listPrivate("drafts");
    for (const filename of names) {
      if (!filename.endsWith(".json") || !isCaptureId(filename.slice(0, -5))) continue;
      try {
        const id = filename.slice(0, -5);
        if (await this.files.type(this.draftPath(id)) !== "Regular File") { unreadable++; continue; }
        const record = this.read(id);
        drafts.push({ id, title: record.snapshot.videoTitle, positionMs: record.snapshot.positionMs, capturedAt: record.snapshot.capturedAt });
      } catch (_) { unreadable++; }
    }
    drafts.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return { drafts, unreadable };
  }
  assertOwned(record) {
    const current = this.read(record.snapshot.captureId);
    if (current.ownerSession !== this.sessionId || current.revision !== record.revision) {
      throw new Error("草稿已被其他窗口修改，停止发布以保护新内容。");
    }
  }
  async adopt(id, allowInterrupted) {
    if (await this.files.type(this.draftPath(id)) !== "Regular File") throw new Error("草稿不是普通文件。");
    const record = this.read(id);
    if (record.publishing && !allowInterrupted) throw new Error("这条草稿可能正在其他窗口保存，请先关闭原窗口再恢复。");
    // No await between ownership comparison and atomic write. Previous owners
    // detect the new revision before their next write; no shared draft.json.
    record.ownerSession = this.sessionId;
    record.publishing = false;
    record.revision++;
    this.files.writeText(this.draftPath(id), JSON.stringify(record));
    Object.freeze(record.snapshot);
    return record;
  }

  async publish(record, settings) {
    validateRecord(record);
    const id = record.snapshot.captureId;
    const root = record.plan ? record.plan.root : (settings.outputPath || this.files.defaultRoot);
    if (!this.isAuthorized(root)) throw new Error("草稿的保存目录尚未授权，请通过设置重新选择该目录。");
    await this.files.prepareOutput(root);
    const finalMd = await this.files.checkedPath(root, id + ".md");
    // A previous attempt may have published successfully but lost its receipt.
    if (this.files.exists(finalMd)) {
      if (!record.plan || this.files.read(finalMd) !== record.plan.markdown) throw new Error("同一捕获 ID 的 Markdown 已存在且内容不同；不会覆盖它。");
      if (record.text !== record.plan.text || record.includeImage !== record.plan.includeImage) {
        throw new Error("上次尝试已成功发布，此后又编辑了正文。请先复制新增文字；已发布笔记不会被覆盖。");
      }
      if (record.plan.includeImage) await this.checkExistingImage(record, root, record.plan.imageAttempt);
      return finalMd;
    }
    if (record.includeImage && (record.image.status !== "ready" || record.image.mode !== record.subtitleMode)) {
      throw new Error("截图尚未就绪，或字幕模式已改变。请重试截图，或取消附上截图后保存文字。");
    }
    const markdown = serializeCapture(record.snapshot, {
      text: record.text, includeSourcePath: settings.includeSourcePath,
      imageRelativePath: record.includeImage ? "assets/" + id + ".png" : undefined
    });
    record.plan = { root, markdown, text: record.text, includeImage: record.includeImage,
      includeSourcePath: settings.includeSourcePath, imageAttempt: record.image.attempt };
    record.publishing = true;
    // Durable receipt BEFORE any published file; retries keep the same identity/root.
    this.persist(record);
    const token = randomId(id);
    const imageStage = ".iina-staging/" + token + ".png.pending";
    const mdStage = ".iina-staging/" + token + ".md.pending";
    try {
      if (record.includeImage) {
        const targetImage = await this.files.checkedPath(root, "assets/" + id + ".png");
        if (this.files.exists(targetImage)) {
          await this.checkExistingImage(record, root, record.image.attempt);
        } else {
          const stage = await this.files.checkedPath(root, imageStage);
          await this.files.copyBinary(this.imagePath(record, record.image.attempt), stage);
          await this.files.publishFile(root, imageStage, "assets/" + id + ".png");
        }
      }
      const stage = await this.files.checkedPath(root, mdStage);
      this.assertOwned(record);
      if (this.files.exists(stage)) throw new Error("临时 Markdown 已存在，拒绝覆盖。");
      this.files.writeText(stage, markdown);
      this.assertOwned(record);
      // Publishing Markdown is the only commit point, after the image is complete.
      await this.files.publishFile(root, mdStage, id + ".md");
      if (this.files.read(finalMd) !== markdown) throw new Error("Markdown 发布校验失败。");
      return finalMd;
    } finally {
      // Only temporary files created for this attempt. Failed cleanup is harmless;
      // .pending is not Markdown and is never consumed as a capture.
      for (const relative of [imageStage, mdStage]) {
        try { await this.files.removeStaging(root, relative); } catch (_) { /* retain safely */ }
      }
      record.publishing = false;
      try { this.persist(record); } catch (_) { /* receipt stays recoverable */ }
    }
  }

  async checkExistingImage(record, root, attempt) {
    const target = await this.files.checkedPath(root, "assets/" + record.snapshot.captureId + ".png");
    if (!this.files.exists(target)) throw new Error("已发布笔记的截图缺失，未把它当作成功重试。");
    this.files.inspectImage(target);
    if (!(await this.files.equalFiles(this.imagePath(record, attempt), target))) {
      throw new Error("同一捕获 ID 的截图内容不同；不会覆盖现有图片。");
    }
  }
  async retarget(record, newRoot) {
    if (!record.plan || record.plan.root === newRoot) return;
    if (record.publishing) throw new Error("正在保存的草稿不能更换目录。");
    if (!this.isAuthorized(newRoot)) throw new Error("请先通过设置选择新目录。");
    this.assertOwned(record);
    const previousRoot = record.plan.root;
    // A new destination is permitted only after checking the previous commit
    // point. An unreadable/disconnected old folder cannot prove non-publication.
    const previousMarkdown = await this.files.checkedPath(previousRoot, record.snapshot.captureId + ".md");
    if (this.files.exists(previousMarkdown)) throw new Error("原目录已经存在这条笔记，不能另存制造重复记录；请先查看原记录。");
    await this.files.prepareOutput(newRoot);
    this.assertOwned(record);
    record.plan.root = newRoot;
    try { this.persist(record); }
    catch (error) { record.plan.root = previousRoot; throw error; }
  }
  finish(record) {
    const id = record.snapshot.captureId;
    // Never remove another window's draft or any exported user file.
    if (this.files.exists(this.draftPath(id))) {
      const current = this.read(id);
      if (current.ownerSession !== this.sessionId || current.revision !== record.revision) return;
      this.files.removePrivate("drafts/" + id + ".json");
    }
    for (let attempt = 1; attempt <= record.image.attempt; attempt++) {
      try { this.files.removePrivate("captures/" + id + "-" + attempt + ".png"); } catch (_) { /* user can inspect data dir */ }
      try { this.files.removePrivate("previews/" + id + "-" + attempt + ".png"); } catch (_) { /* harmless leftover */ }
    }
  }
}

module.exports = { DraftStore, randomId, validateRecord, MAX_TEXT };
