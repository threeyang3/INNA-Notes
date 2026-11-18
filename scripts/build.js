#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'src/main.js';
const OUTPUT = path.join(ROOT, 'dist/main.js');

// A deliberately small lexical scanner: ignore comments, quoted text and regex
// literals, but still inspect code inside template substitutions. No source eval.
function tokens(source) {
  const result = [];
  const parentheses = [];
  let index = 0;
  let regexAllowed = true;
  function scan(inTemplateExpression) {
    let braces = 0;
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) { index += 1; continue; }
      if (source.startsWith('//', index)) {
        while (index < source.length && source[index] !== '\n') index += 1;
        continue;
      }
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        if (end < 0) throw new Error('Unterminated source comment.');
        index = end + 2;
        continue;
      }
      if (inTemplateExpression && character === '}' && braces === 0) { index += 1; return; }
      if (character === '"' || character === "'") {
        const start = index++;
        while (index < source.length && source[index] !== character) {
          if (source[index] === '\\') index += 1;
          index += 1;
        }
        if (index >= source.length) throw new Error('Unterminated source string.');
        index += 1;
        result.push({ type: 'string', value: source.slice(start + 1, index - 1) });
        regexAllowed = false;
        continue;
      }
      if (character === '`') {
        result.push({ type: 'template', value: '`' });
        index += 1;
        while (index < source.length) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index] === '`') { index += 1; break; }
          if (source.startsWith('${', index)) {
            index += 2;
            regexAllowed = true;
            scan(true);
          } else index += 1;
        }
        regexAllowed = false;
        continue;
      }
      if (character === '/' && regexAllowed) {
        index += 1;
        let inClass = false;
        while (index < source.length) {
          const next = source[index++];
          if (next === '\\') { index += 1; continue; }
          if (next === '[') inClass = true;
          if (next === ']') inClass = false;
          if (next === '/' && !inClass) break;
        }
        while (/[a-z]/i.test(source[index] || '')) index += 1;
        result.push({ type: 'regex', value: '/' });
        regexAllowed = false;
        continue;
      }
      if (/[A-Za-z_$]/.test(character)) {
        const start = index++;
        while (/[A-Za-z0-9_$]/.test(source[index] || '')) index += 1;
        const value = source.slice(start, index);
        result.push({ type: 'identifier', value });
        regexAllowed = /^(return|throw|case|delete|void|typeof|instanceof|in|new|yield|await|else|do)$/.test(value);
        continue;
      }
      if (/[0-9]/.test(character)) {
        const start = index++;
        while (/[A-Za-z0-9_.]/.test(source[index] || '')) index += 1;
        result.push({ type: 'number', value: source.slice(start, index) });
        regexAllowed = false;
        continue;
      }
      const previous = result[result.length - 1];
      if (character === '(') parentheses.push(previous && /^(if|while|for|with|switch|catch)$/.test(previous.value));
      if (character === '{') braces += 1;
      if (character === '}') braces -= 1;
      result.push({ type: 'punctuation', value: character });
      index += 1;
      regexAllowed = character === ')' ? !!parentheses.pop() : !/[\]}]/.test(character);
      if ((character === '+' || character === '-') && source[index] === character) {
        result.push({ type: 'punctuation', value: character });
        index += 1;
        regexAllowed = false;
      }
    }
  }
  scan(false);
  return result;
}

function staticRequires(source, filename) {
  const parsed = tokens(source);
  const dependencies = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const token = parsed[index];
    if (token.type !== 'identifier') continue;
    if (token.value === 'import' || token.value === 'export') {
      throw new Error(filename + ': runtime modules must use static CommonJS, not import/export.');
    }
    if (token.value !== 'require') continue;
    const [open, argument, close] = parsed.slice(index + 1, index + 4);
    if (!open || open.value !== '(' || !argument || argument.type !== 'string' || !close || close.value !== ')') {
      throw new Error(filename + ': dynamic require is not supported.');
    }
    const specifier = argument.value;
    if (!/^\.\.?\//.test(specifier) || /[\\\u0000\r\n]/.test(specifier)) {
      throw new Error(filename + ': only literal relative JavaScript require paths are allowed: ' + specifier);
    }
    dependencies.push(specifier);
    index += 3;
  }
  return Array.from(new Set(dependencies));
}

function createBundle() {
  const modules = new Map();
  const sourceRoot = fs.realpathSync(path.join(ROOT, 'src')) + path.sep;
  function visit(id) {
    if (modules.has(id)) return;
    const absolute = path.join(ROOT, id);
    const resolved = fs.realpathSync(absolute);
    if (!resolved.startsWith(sourceRoot) || path.extname(resolved) !== '.js' || !fs.statSync(resolved).isFile()) {
      throw new Error('Runtime dependency is outside src/ or is not JavaScript: ' + id);
    }
    const source = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
    new vm.Script(source, { filename: id });
    const dependencies = {};
    modules.set(id, { source, dependencies });
    for (const specifier of staticRequires(source, id)) {
      let target = path.resolve(path.dirname(absolute), specifier);
      if (!path.extname(target)) target += '.js';
      const targetId = path.relative(ROOT, target).split(path.sep).join('/');
      if (targetId.startsWith('../')) throw new Error('Dependency escapes the repository: ' + specifier);
      dependencies[specifier] = targetId;
      visit(targetId);
    }
  }
  visit(ENTRY);
  const entries = Array.from(modules.entries()).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const factories = entries.map(([id, module]) => JSON.stringify(id) + ': function(module, exports, require) {\n' + module.source + '\n}').join(',\n');
  const dependencies = Object.fromEntries(entries.map(([id, module]) => [id, module.dependencies]));
  const bundle = '// Generated by scripts/build.js. Edit src/ and rebuild.\n' +
    '// Source SHA-256: ' + hash + '\n' +
    '(function () {\n"use strict";\nvar factories = {\n' + factories + '\n};\n' +
    'var dependencies = ' + JSON.stringify(dependencies, null, 2) + ';\n' +
    'var cache = Object.create(null);\n' +
    'function load(id) {\n' +
    '  if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id].exports;\n' +
    '  if (!Object.prototype.hasOwnProperty.call(factories, id)) throw new Error("Unknown module: " + id);\n' +
    '  var module = { exports: {} };\n' +
    '  cache[id] = module;\n' +
    '  factories[id](module, module.exports, function (name) {\n' +
    '    if (!Object.prototype.hasOwnProperty.call(dependencies[id], name)) throw new Error("Unknown dependency: " + name);\n' +
    '    return load(dependencies[id][name]);\n' +
    '  });\n' +
    '  return module.exports;\n' +
    '}\nload(' + JSON.stringify(ENTRY) + ');\n})();\n';
  new vm.Script(bundle, { filename: 'dist/main.js' });
  return { bundle, count: modules.size };
}

function build(options = {}) {
  const { bundle, count } = createBundle();
  if (options.verify) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== bundle) {
      throw new Error('dist/main.js is missing or stale. Run npm run build and commit the generated bundle.');
    }
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bundle);
  }
  return { file: OUTPUT, bytes: Buffer.byteLength(bundle), modules: count };
}

if (require.main === module) {
  try {
    if (process.argv.slice(2).some(argument => argument !== '--verify')) throw new Error('Usage: node scripts/build.js [--verify]');
    const verify = process.argv.includes('--verify');
    const result = build({ verify });
    console.log((verify ? 'Verified' : 'Built') + ' dist/main.js: ' + result.modules + ' modules, ' + result.bytes + ' bytes.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { ROOT, build, createBundle, staticRequires };
