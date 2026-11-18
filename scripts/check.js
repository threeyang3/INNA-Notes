#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, build } = require('./build');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function filesUnder(relative) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const child = relative + '/' + entry.name;
    requireCondition(!entry.isSymbolicLink(), 'Unexpected symlink: ' + child);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function checkManifest() {
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'Info.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const key of ['name', 'version', 'identifier', 'entry']) {
    requireCondition(typeof info[key] === 'string' && info[key].trim().length > 0, 'Info.json is missing ' + key + '.');
  }
  requireCondition(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(info.version), 'Info.json version must be semantic.');
  requireCondition(info.version === pkg.version, 'Info.json and package.json versions differ.');
  requireCondition(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(info.identifier), 'Info.json identifier must use reverse-domain form.');
  requireCondition(info.author && typeof info.author.name === 'string' && info.author.name.trim(), 'Info.json author.name is required.');
  requireCondition(info.entry === 'dist/main.js', 'IINA must load the committed dist/main.js bundle.');
  for (const key of ['entry', 'globalEntry', 'preferencesPage', 'helpPage']) {
    if (!info[key]) continue;
    const relative = info[key];
    requireCondition(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split('/').includes('..') && !relative.includes('\\'), 'Info.json ' + key + ' must reference a packaged local file.');
    const absolute = path.join(ROOT, relative);
    requireCondition(fs.existsSync(absolute) && fs.statSync(absolute).isFile(), 'Info.json references a missing file: ' + relative);
    requireCondition(fs.realpathSync(absolute).startsWith(ROOT + path.sep), 'Info.json reference escapes the project: ' + relative);
  }
  requireCondition(Array.isArray(info.permissions), 'Info.json permissions must be explicit.');
  const allowed = new Set(['file-system', 'show-alert', 'show-osd']);
  requireCondition(info.permissions.every(permission => allowed.has(permission)), 'Unexpected or network permission in Info.json.');
  requireCondition(new Set(info.permissions).size === info.permissions.length, 'Info.json has duplicate permissions.');
  for (const permission of allowed) requireCondition(info.permissions.includes(permission), 'Missing necessary permission: ' + permission);
  requireCondition(!info.allowedDomains || (Array.isArray(info.allowedDomains) && info.allowedDomains.length === 0), 'This local plugin must not request network domains.');
  requireCondition(Number.isSafeInteger(info.ghVersion) && info.ghVersion >= 1, 'Info.json ghVersion must be a positive integer.');
  requireCondition(!filesUnder('.github/workflows').some(file => /\.ya?ml$/i.test(file)), 'GitHub CI workflows are outside this project’s local-only validation policy.');
  return info;
}

function syntaxCheck(filename, source) {
  const result = spawnSync(process.execPath, source === undefined ? ['--check', filename] : ['--check'], {
    cwd: ROOT, encoding: 'utf8', input: source
  });
  if (result.error) throw result.error;
  requireCondition(result.status === 0, 'JavaScript syntax check failed for ' + filename + ':\n' + (result.stderr || result.stdout));
}

function check() {
  checkManifest();
  const files = ['src', 'ui', 'scripts', 'dist'].flatMap(filesUnder).filter(file => file.endsWith('.js'));
  for (const filename of files) syntaxCheck(filename);
  let inlineCount = 0;
  for (const filename of filesUnder('ui').filter(file => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, filename), 'utf8');
    const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
    for (const match of scripts) {
      const external = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
      if (external) {
        const resolved = path.resolve(ROOT, path.dirname(filename), external[1]);
        requireCondition(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(external[1]) && resolved.startsWith(ROOT + path.sep) && fs.existsSync(resolved), 'UI script must be a bundled local file: ' + external[1]);
      } else if (match[2].trim()) {
        inlineCount += 1;
        syntaxCheck(filename + ' inline script ' + inlineCount, match[2]);
      }
    }
  }
  const bundle = build({ verify: true });
  return { files: files.length, inlineScripts: inlineCount, modules: bundle.modules };
}

if (require.main === module) {
  try {
    const result = check();
    console.log('Checked manifest, permissions, no CI workflows, ' + result.files + ' JavaScript files, ' + result.inlineScripts + ' inline scripts, and ' + result.modules + ' bundled modules.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { check, checkManifest, filesUnder };
