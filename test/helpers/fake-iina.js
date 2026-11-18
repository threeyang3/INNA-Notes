'use strict';

const { makePng } = require('./memory-files.js');

async function flushPromises(rounds = 100) {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

// Uses real Promise scheduling with a manually advanced clock. The production
// Timers wrapper still runs, including its explicit native timer cleanup.
class FakeClock {
  constructor() {
    this.now = 0;
    this.sequence = 0;
    this.pending = new Map();
    this.scheduled = [];
    this.cleared = [];
  }
  set(callback, milliseconds) {
    const id = 'timer-' + (++this.sequence);
    const timer = { id, callback, due: this.now + milliseconds, milliseconds };
    this.pending.set(id, timer);
    this.scheduled.push(timer);
    return id;
  }
  clear(id) { this.cleared.push(id); this.pending.delete(id); }
  async advance(milliseconds) {
    const target = this.now + milliseconds;
    await flushPromises();
    for (let iterations = 0; iterations < 10000; iterations++) {
      const next = Array.from(this.pending.values()).filter(timer => timer.due <= target)
        .sort((a, b) => a.due - b.due || Number(a.id.slice(6)) - Number(b.id.slice(6)))[0];
      if (!next) {
        this.now = target;
        await flushPromises();
        if (!Array.from(this.pending.values()).some(timer => timer.due <= target)) return;
        continue;
      }
      this.now = next.due;
      this.pending.delete(next.id);
      next.callback();
      await flushPromises();
    }
    throw new Error('Fake clock exceeded its bounded callback limit');
  }
}

class FakeIina {
  constructor(files, clock, options = {}) {
    this.files = files;
    this.clock = clock;
    this.path = options.path || '/电影/第一集 100%20 [日本語] #1.mkv';
    this.version = options.version || '1.5.0';
    this.status = { title: options.title || '第一集 — 日本語', url: 'file://' + this.path,
      idle: false, isNetworkResource: false };
    this.native = new Map([
      ['time-pos', 12.345], ['duration', 7200], ['pause', false],
      ['idle-active', false], ['seeking', false], ['video-params', { w: 1920, h: 1080 }]
    ]);
    for (const [key, value] of Object.entries(options.native || {})) this.native.set(key, value);
    this.preferences = new Map(Object.entries(options.preferences || {}));
    this.calls = { commands: [], pauses: 0, resumes: 0, osd: [], errors: [], finder: [],
      ask: [], chosenFiles: [], sync: 0, loadFile: [], onMessage: [], postMessage: [],
      setProperty: [], setFrame: [], open: 0, close: 0, menuUpdates: 0 };
    this.events = new Map();
    this.eventSequence = 0;
    this.messages = new Map();
    this.menuItems = [];
    this.visible = false;
    this.autoPauseAck = options.autoPauseAck !== false;
    this.screenshotMode = options.screenshotMode || 'success';
    this.screenshotDelay = options.screenshotDelay === undefined ? 25 : options.screenshotDelay;
    this.png = options.png || makePng();
    this.askResult = true;
    this.chooseFileResult = null;
    this.api = {
      core: {
        status: this.status,
        getVersion: () => ({ iina: this.version, mpv: 'test-double' }),
        pause: () => {
          this.calls.pauses++;
          this.native.set('pause', true);
          if (this.autoPauseAck) this.clock.set(() => this.emit('mpv.pause.changed', true), 1);
        },
        resume: () => { this.calls.resumes++; this.native.set('pause', false); },
        osd: text => this.calls.osd.push(text)
      },
      mpv: {
        getString: name => name === 'path' ? this.path : null,
        getNative: name => this.native.has(name) ? this.native.get(name) : null,
        command: (name, args) => this.command(name, args)
      },
      event: {
        on: (name, callback) => {
          const id = 'event-' + (++this.eventSequence);
          if (!this.events.has(name)) this.events.set(name, new Map());
          this.events.get(name).set(id, callback);
          return id;
        },
        off: (name, id) => { if (this.events.has(name)) this.events.get(name).delete(id); }
      },
      menu: {
        removeAllItems: () => { this.menuItems = []; },
        item: (title, callback, options) => ({ title, callback, options }),
        addItem: item => this.menuItems.push(item),
        forceUpdate: () => { this.calls.menuUpdates++; }
      },
      standaloneWindow: {
        loadFile: file => { this.calls.loadFile.push(file); this.messages.clear(); },
        onMessage: (name, callback) => { this.calls.onMessage.push(name); this.messages.set(name, callback); },
        postMessage: (name, payload) => this.calls.postMessage.push({ name, payload,
          state: JSON.parse(decodeURIComponent(payload.encoded)) }),
        setProperty: value => this.calls.setProperty.push(value),
        setFrame: (...args) => this.calls.setFrame.push(args),
        open: () => { this.visible = true; this.calls.open++; },
        close: () => { this.visible = false; this.calls.close++; },
        isOpen: () => this.visible
      },
      preferences: {
        get: key => this.preferences.get(key),
        set: (key, value) => this.preferences.set(key, value),
        sync: () => { this.calls.sync++; }
      },
      utils: {
        ask: question => { this.calls.ask.push(question); return this.askResult; },
        chooseFile: (message, options) => {
          this.calls.chosenFiles.push({ message, options });
          return Promise.resolve(this.chooseFileResult);
        }
      },
      file: { showInFinder: filename => this.calls.finder.push(filename) },
      console: { error: message => this.calls.errors.push(message) }
    };
  }
  command(name, args) {
    if (!Array.isArray(args)) throw new Error('mpv commands require an argv array');
    this.calls.commands.push({ name, args: args.slice() });
    if (name !== 'async' || args[0] !== 'raw' || args[1] !== 'no-osd' || args[2] !== 'screenshot-to-file') {
      throw new Error('Unexpected mpv command: ' + name);
    }
    if (this.screenshotMode === 'throw') throw new Error('mpv screenshot refused');
    if (this.screenshotMode === 'timeout') return;
    const target = args[3];
    const bytes = this.screenshotMode === 'partial' ? this.png.subarray(0, 35) : this.png;
    this.clock.set(() => this.files.put(target, bytes), this.screenshotDelay);
  }
  emit(name, value) {
    for (const callback of Array.from((this.events.get(name) || new Map()).values())) callback(value);
  }
  userPause(value) { this.native.set('pause', value); this.emit('mpv.pause.changed', value); }
  setFile(filename, title = '另一个视频') {
    this.emit('mpv.start-file');
    this.path = filename; this.status.url = 'file://' + filename; this.status.title = title;
    this.native.set('time-pos', 0);
    this.emit('mpv.file-loaded');
  }
  invokeMenu(title) {
    const menu = this.menuItems.find(item => item.title === title);
    if (!menu) throw new Error('Unknown menu item: ' + title);
    return menu.callback();
  }
  send(action) {
    const handler = this.messages.get('vn-action');
    if (!handler) throw new Error('The WebView bridge has not loaded');
    const value = Object.assign({}, action);
    const state = this.calls.postMessage.length ? this.latestState() : null;
    if (['edit', 'save', 'close', 'retry-image', 'retarget'].includes(value.type) &&
        !Object.hasOwn(value, 'editorToken') && state && state.active) {
      value.editorToken = state.active.editorToken;
    }
    handler({ encoded: encodeURIComponent(JSON.stringify(value)) });
  }
  ready(clientId = 'test-webview') { this.send({ type: 'ready', clientId }); }
  latestState() { return this.calls.postMessage.at(-1).state; }
  listenerCount() {
    return Array.from(this.events.values()).reduce((sum, entries) => sum + entries.size, 0);
  }
}

module.exports = { FakeClock, FakeIina, flushPromises };
