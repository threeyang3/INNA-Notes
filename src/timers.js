"use strict";

// IINA 1.5 retains completed timer callbacks until clearTimeout. Clear before
// calling user code, and keep an explicit set for permanent teardown cleanup.
function cancelled() {
  const error = new Error("笔记操作已停止；未完成的内容可从草稿恢复。");
  error.code = "IINA_VIDEO_NOTES_CANCELLED";
  return error;
}

class Timers {
  constructor(set, clear) {
    this.setNative = set; this.clearNative = clear;
    this.ids = new Set(); this.waiters = new Map(); this.stopped = false;
  }
  set(callback, milliseconds) {
    if (this.stopped) return null;
    const id = this.setNative(() => {
      this.clearNative(id);
      this.ids.delete(id);
      if (!this.stopped) callback();
    }, milliseconds);
    this.ids.add(id);
    return id;
  }
  clear(id) {
    if (id === null || id === undefined) return;
    this.clearNative(id);
    this.ids.delete(id);
    const reject = this.waiters.get(id);
    this.waiters.delete(id);
    if (reject) reject(cancelled());
  }
  delay(milliseconds) {
    if (this.stopped) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let id;
      try {
        id = this.set(() => {
          this.waiters.delete(id);
          resolve();
        }, milliseconds);
        if (id === null) reject(cancelled());
        else this.waiters.set(id, reject);
      } catch (error) { reject(error); }
    });
  }
  stop() {
    this.stopped = true;
    // Reject awaited delays as well as clearing the native callback. Otherwise a
    // binary copy awaiting its next chunk cannot run finally/close its handles.
    for (const id of Array.from(this.ids)) this.clear(id);
  }
}

module.exports = { Timers };
