'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, staticRequires, createBundle } = require('../scripts/build');

test('runtime dependencies are static relative modules, including extensionless imports', () => {
  const source = 'const a = require("./capture"); const b = require("../src/protocol.js"); require("./capture");';
  assert.deepEqual(staticRequires(source, 'fixture.js'), ['./capture', '../src/protocol.js']);
});

test('runtime cannot accidentally acquire Node or dynamic loader dependencies', () => {
  for (const source of [
    'require("node:fs")', 'require("fs")', 'require("/absolute/module.js")',
    'require(name)', 'const load = require; load("./a")',
    'require("./" + name)', 'require(`./${name}`)', 'require("./a", options)',
    'import("node:fs")', 'import { foo } from "./x.js"', 'export const value = 1;'
  ]) assert.throws(() => staticRequires(source, 'fixture.js'), source);
});

test('commented, quoted and regex require text is ignored; template expressions are scanned', () => {
  const source = [
    '// require("node:fs")',
    '/* require("bad") */',
    'const text = "require(\"node:fs\")";',
    'const pattern = /require\\(.*\\)/g;',
    'const result = `literal require("bad") ${require("./actual.js").value}`;',
    'const nested = `${({value: require("./second")}).value}`;'
  ].join('\n');
  assert.deepEqual(staticRequires(source, 'fixture.js'), ['./actual.js', './second']);
  assert.throws(() => staticRequires('const value = `${require(name)}`;', 'fixture.js'), /dynamic/);
});

test('all existing runtime sources use bundleable local dependencies', () => {
  for (const filename of fs.readdirSync(path.join(ROOT, 'src')).filter(value => value.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(ROOT, 'src', filename), 'utf8');
    const dependencies = staticRequires(source, filename);
    assert.ok(dependencies.every(value => value.startsWith('./') || value.startsWith('../')), filename);
  }
});

test('the actual bundled entry starts with IINA APIs and no Node or browser globals', async () => {
  const menus = [];
  const events = [];
  const errors = [];
  const calls = [];
  const iina = {
    console: { error(message) { errors.push(message); } },
    preferences: { get() { return undefined; } },
    core: { getVersion() { return { iina: '1.5.0', mpv: 'test', build: 'test' }; } },
    menu: {
      removeAllItems() { menus.length = 0; },
      item(title, action, options) { return { title, action, options }; },
      addItem(item) { menus.push(item); },
      forceUpdate() { throw new Error("PlayerCore is still initializing"); }
    },
    event: { on(name, callback) { events.push({ name, callback }); return String(events.length); } },
    utils: {
      resolvePath() { return '/plugin-data'; },
      async exec(binary, args, cwd) {
        calls.push({ binary, args, cwd });
        if (binary === '/bin/pwd') return { status: 0, stdout: cwd + '\n', stderr: '' };
        if (binary === '/usr/bin/stat') return { status: 0, stdout: 'Directory\n', stderr: '' };
        throw new Error('Unexpected startup command: ' + binary);
      }
    }
  };
  const context = { iina, setTimeout, clearTimeout };
  for (const name of ['require', 'process', 'Buffer', 'window', 'document', 'fetch']) assert.equal(context[name], undefined);
  vm.runInNewContext(createBundle().bundle, context, { timeout: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(menus.length, 4);
  assert.equal(menus[0].title, '创建视频笔记');
  assert.ok(events.some(event => event.name === 'iina.window-will-close'));
  assert.ok(calls.some(call => call.binary === '/bin/pwd'));
  assert.ok(calls.filter(call => call.binary === '/usr/bin/stat').length >= 5);
});
