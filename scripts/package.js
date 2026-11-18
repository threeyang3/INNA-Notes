#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ROOT, build } = require('./build');
const { checkManifest, filesUnder } = require('./check');

function packagePlugin() {
  build();
  const info = checkManifest();
  // Only installable runtime files and user documentation belong in this archive.
  const files = ['Info.json', 'dist/main.js', 'README.md']
    .concat(filesUnder('ui').filter(file => /\.(?:html|css|js|svg|png)$/i.test(file)))
    .concat(filesUnder('docs').filter(file => /\.(?:md|txt|html|png|svg)$/i.test(file)))
    .concat(['LICENSE', 'LICENSE.md', 'LICENSE.txt'].filter(file => fs.existsSync(path.join(ROOT, file))))
    .sort();
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile() || !fs.realpathSync(absolute).startsWith(ROOT + path.sep)) {
      throw new Error('Package whitelist contains a missing, nonregular or escaped file: ' + file);
    }
  }
  const artifacts = path.join(ROOT, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const name = 'IINA-Video-Notes-' + info.version + '.iinaplgz';
  const output = path.join(artifacts, name);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'iina-video-notes-package-'));
  try {
    // Stable file times/modes and UTC make repeat packaging deterministic. The
    // repository's original files are untouched; the staging directory is removed.
    const timestamp = new Date('2000-01-01T00:00:00.000Z');
    for (const file of files) {
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
      fs.chmodSync(target, 0o644);
      fs.utimesSync(target, timestamp, timestamp);
    }
    // ZIP updates existing archives by default; remove exactly our generated
    // version first so removed files can never survive a later packaging pass.
    fs.rmSync(output, { force: true });
    const zip = spawnSync('zip', ['-X', '-q', output].concat(files), {
      cwd: staging, encoding: 'utf8', env: Object.assign({}, process.env, { TZ: 'UTC' })
    });
    if (zip.error) throw new Error('The system zip command is required (included with macOS): ' + zip.error.message);
    if (zip.status !== 0) throw new Error('zip failed: ' + (zip.stderr || zip.stdout));
    const bytes = fs.readFileSync(output);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(artifacts, 'SHA256SUMS'), checksum + '  ' + name + '\n');
    return { file: output, checksum, bytes: bytes.length, entries: files.length };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = packagePlugin();
    console.log('Packaged ' + path.relative(ROOT, result.file) + ': ' + result.entries + ' files, ' + result.bytes + ' bytes.');
    console.log('SHA-256: ' + result.checksum);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { packagePlugin };
