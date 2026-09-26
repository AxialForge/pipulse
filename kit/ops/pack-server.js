#!/usr/bin/env node
'use strict';
// Build the server package: dist/<slug>-server-<version>.tar.gz plus a versionless copy and a
// .sha256 file. Contains exactly what the Pi runs (kit, app core, renderer, server, installer,
// docs); no Electron, no node_modules, no dependencies at all.
//
//   node kit/ops/pack-server.js
//
// CI runs this on every tag and attaches the three files to the GitHub Release; the installer
// downloads and verifies them.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const meta = require(path.join(root, 'app', 'app.json'));
const slug = meta.slug || pkg.name;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-pack-'));
const top = path.join(stage, `${slug}-server`);
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const skip = (src) => /[\\/](\.git|node_modules|\.devdata|dist|build)([\\/]|$)/.test(src) || /[\\/]kit[\\/]electron([\\/]|$)/.test(src) || /[\\/]app[\\/]electron([\\/]|$)/.test(src) || /[\\/]app[\\/]preload\.js$/.test(src);
const copy = (rel, dest = rel) => { const from = path.join(root, rel); if (!fs.existsSync(from)) return; fs.cpSync(from, path.join(top, dest), { recursive: true, filter: (src) => !skip(src) }); };
copy('kit'); copy('app'); copy('LICENSE'); copy('CHANGELOG.md'); copy('server');
copy('docs/RASPBERRY-PI.md', 'README.md');
fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify({ name: `${slug}-server`, version: pkg.version, description: `${meta.name || slug} web server (Raspberry Pi / Linux)`, license: pkg.license, private: true, engines: pkg.engines, scripts: { start: 'node app/server/server.js' } }, null, 2) + '\n');

const named = path.join(dist, `${slug}-server-${pkg.version}.tar.gz`);
// tar runs inside the staging folder with a relative output name: GNU tar on Windows reads "C:" as a remote host.
execFileSync('tar', ['-czf', 'pkg.tar.gz', `${slug}-server`], { cwd: stage });
fs.copyFileSync(path.join(stage, 'pkg.tar.gz'), named);
fs.copyFileSync(named, path.join(dist, `${slug}-server.tar.gz`));
const sha = crypto.createHash('sha256').update(fs.readFileSync(named)).digest('hex');
fs.writeFileSync(path.join(dist, `${slug}-server.tar.gz.sha256`), `${sha}  ${slug}-server.tar.gz\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${path.relative(root, named)}  ${(fs.statSync(named).size / 1024).toFixed(0)} kB  sha256 ${sha.slice(0, 12)}…`);
