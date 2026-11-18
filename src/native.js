"use strict";

const { normalizeAbsolutePath, isCaptureId } = require("./protocol.js");
const { inspectPng, bytesToBase64 } = require("./png.js");

const CHUNK = 64 * 1024;
const MAX_IMAGE = 128 * 1024 * 1024;

function child(root, relative) {
  if (typeof relative !== "string" || !relative || relative[0] === "/" ||
      relative.split("/").some(part => !part || part === "." || part === "..") || /[\0\r\n]/.test(relative)) {
    throw new Error("无效的输出子路径。");
  }
  return normalizeAbsolutePath(root + "/" + relative);
}

// Only these fixed system tools are used, through IINA's official argv API.
// There is no shell, network request, video rewrite, ffmpeg, or Node runtime.
class NativeFiles {
  constructor(api, delay) {
    this.api = api;
    this.delay = delay;
    this.dataRoot = normalizeAbsolutePath(api.utils.resolvePath("@data/"));
    this.defaultRoot = child(this.dataRoot, "exports/IINA");
  }

  async run(binary, args, cwd) {
    const result = await this.api.utils.exec(binary, args, cwd);
    if (!result || result.status !== 0) {
      throw new Error("文件操作失败：请检查目录权限、可用空间和文件系统支持。" +
        (result && result.stderr ? " " + result.stderr.trim().slice(0, 300) : ""));
    }
    return result.stdout || "";
  }

  async type(path) {
    const result = await this.api.utils.exec("/usr/bin/stat", ["-f", "%HT", normalizeAbsolutePath(path)]);
    if (!result || result.status !== 0) return null;
    return result.stdout.trim();
  }

  async canonicalRoot(path) {
    path = normalizeAbsolutePath(path);
    const resolved = normalizeAbsolutePath((await this.run("/bin/pwd", ["-P"], path)).replace(/\n$/, ""));
    if (await this.type(resolved) !== "Directory") throw new Error("保存位置不是可用的文件夹。");
    return resolved;
  }

  async assertRoot(root) {
    if (await this.canonicalRoot(root) !== root) {
      throw new Error("保存目录已被移动或替换为符号链接，请重新选择目录。");
    }
  }

  async ensureDir(root, relative) {
    let current = root;
    for (const part of relative.split("/")) {
      current = child(current, part);
      let type = await this.type(current);
      if (type === null) {
        // No -p: every ancestor was checked, and a concurrent creator is rechecked.
        const result = await this.api.utils.exec("/bin/mkdir", [current]);
        type = await this.type(current);
        if ((!result || result.status !== 0) && type !== "Directory") {
          throw new Error("无法创建保存目录，请检查写入权限与磁盘空间。");
        }
      }
      if (type !== "Directory") throw new Error("输出目录中存在非文件夹或符号链接，已停止写入。");
    }
    return current;
  }

  async initialize() {
    // IINA creates @data itself. Resolve any user-authorized ancestor symlinks once.
    this.dataRoot = await this.canonicalRoot(this.dataRoot);
    for (const dir of ["drafts", "captures", "previews", "exports/IINA"]) await this.ensureDir(this.dataRoot, dir);
    this.defaultRoot = child(this.dataRoot, "exports/IINA");
  }

  privatePath(relative) { return child(this.dataRoot, relative); }
  apiPath(path) {
    // Preserve IINA's private-directory authority even when an ancestor is a symlink.
    return path === this.dataRoot ? "@data/" :
      path.startsWith(this.dataRoot + "/") ? "@data/" + path.slice(this.dataRoot.length + 1) : path;
  }
  exists(path) { return this.api.file.exists(this.apiPath(path)); }
  read(path) {
    const value = this.api.file.read(this.apiPath(path), {});
    if (typeof value !== "string") throw new Error("无法读取本地文件。");
    return value;
  }
  writeText(path, text) {
    this.api.file.write(this.apiPath(path), text);
    if (this.read(path) !== text) throw new Error("文件写入后校验失败；草稿仍保留。");
  }
  removePrivate(relative) {
    const path = this.privatePath(relative);
    if (this.exists(path)) this.api.file.delete(this.apiPath(path));
  }
  listPrivate(relative) {
    const entries = this.api.file.list(this.apiPath(this.privatePath(relative)), { includeSubDir: false });
    if (!Array.isArray(entries)) throw new Error("无法读取草稿目录。");
    // Never trust returned `path`, which differs between IINA implementations.
    return entries.filter(e => e && !e.isDir && typeof e.filename === "string").map(e => e.filename);
  }

  async prepareOutput(root) {
    root = normalizeAbsolutePath(root || this.defaultRoot);
    await this.assertRoot(root);
    await this.ensureDir(root, "assets");
    await this.ensureDir(root, ".iina-staging");
    return root;
  }

  async checkedPath(root, relative) {
    await this.assertRoot(root);
    const parts = relative.split("/");
    let path = root;
    for (let i = 0; i < parts.length; i++) {
      path = child(path, parts[i]);
      const type = await this.type(path);
      if (i < parts.length - 1 && type !== "Directory") throw new Error("输出子目录已改变，已停止写入。");
      if (i === parts.length - 1 && type !== null && type !== "Regular File") {
        throw new Error("目标路径不是普通文件，已停止写入。");
      }
    }
    return path;
  }

  handle(path, mode) {
    const handle = this.api.file.handle(this.apiPath(path), mode);
    if (!handle) throw new Error("无法打开文件，可能没有权限或磁盘不可用。");
    return handle;
  }

  inspectImage(path) {
    const handle = this.handle(path, "read");
    try { return inspectPng(handle, { maxBytes: MAX_IMAGE }); }
    finally { handle.close(); }
  }

  async copyBinary(source, target) {
    if (this.exists(target)) throw new Error("临时文件已存在，拒绝覆盖。");
    const info = this.inspectImage(source);
    // IINA 1.5 FileHandle.write uses Foundation's nonthrowing legacy writeData
    // bridge: ENOSPC may raise a native exception outside JS try/catch. Use the
    // official utils.exec argv API and macOS's binary cp instead. Failures stay
    // in the child process, and large PNGs avoid a per-byte JS/Swift write bridge.
    // -n never replaces an existing file. Both paths are generated/authorized.
    await this.run("/bin/cp", ["-n", source, target]);
    if (this.inspectImage(target).size !== info.size || !(await this.equalFiles(source, target))) {
      throw new Error("截图复制校验失败，保留原始截图以便重试。");
    }
  }

  async equalFiles(a, b) {
    const x = this.handle(a, "read");
    let y;
    try {
      y = this.handle(b, "read");
      x.seekToEnd(); y.seekToEnd();
      const size = x.offset();
      if (size !== y.offset() || size > MAX_IMAGE) return false;
      x.seekTo(0); y.seekTo(0);
      for (let offset = 0; offset < size; offset += CHUNK) {
        const length = Math.min(CHUNK, size - offset);
        const p = x.read(length);
        const q = y.read(length);
        if (!p || !q || p.length !== length || q.length !== length) return false;
        for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
        await this.delay(0);
      }
      return true;
    } finally { x.close(); if (y) y.close(); }
  }

  async publishFile(root, stagingRelative, finalRelative) {
    const staging = await this.checkedPath(root, stagingRelative);
    const target = await this.checkedPath(root, finalRelative);
    if (this.exists(target)) throw new Error("同名目标文件已存在，拒绝覆盖。");
    // A same-volume hard link is an atomic create-if-absent. No rename-overwrite race.
    // Deliberately fail closed on filesystems that cannot offer this operation.
    await this.run("/bin/ln", ["-h", staging, target]);
    if (await this.type(target) !== "Regular File") throw new Error("发布目标校验失败。");
    return target;
  }

  async removeStaging(root, relative) {
    if (!/^\.iina-staging\/[A-Za-z0-9_-]+\.(png|md)\.pending$/.test(relative)) return;
    const path = await this.checkedPath(root, relative);
    // Only our exact generated temporary filename; never recursive deletion.
    await this.run("/bin/rm", ["-f", path]);
  }

  async preview(path, captureId, attempt) {
    if (!isCaptureId(captureId) || !Number.isSafeInteger(attempt) || attempt < 1) return null;
    const target = await this.checkedPath(this.dataRoot, "previews/" + captureId + "-" + attempt + ".png");
    const info = this.inspectImage(path);
    let previewPath = path;
    if (info.size > 512 * 1024 || info.width > 1000 || info.height > 1000) {
      // sips is part of macOS; the full-resolution source is never modified.
      if (!this.exists(target)) {
        const result = await this.api.utils.exec("/usr/bin/sips", ["-Z", "960", path, "--out", target]);
        if (!result || result.status !== 0 || !this.exists(target)) return null;
      }
      previewPath = target;
    }
    if (this.inspectImage(previewPath).size > 2 * 1024 * 1024) return null;
    const handle = this.handle(previewPath, "read");
    try { return "data:image/png;base64," + bytesToBase64(handle.readToEnd()); }
    finally { handle.close(); }
  }
}

module.exports = { NativeFiles, child, MAX_IMAGE };
