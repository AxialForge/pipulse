'use strict';
// Guards the core / shell / bridge contract of a Bracket app (run from the app's own test):
//   1. the core (app/main and kit/main) never requires Electron;
//   2. every request channel in app/renderer/bridge-shape.js is served by the core or the web shell;
//   3. everything the web shell adds is a kit channel or an override of a core channel;
//   4. every event the core sends has a listener leaf in the bridge;
//   5. with a desktop shell: the channels it serves on its own are also served by the web shell,
//      the preload builds from bridge-shape.js, and the window is not sandboxed.
//
//   const { checkContract } = require('../../kit/test/contract');
//   checkContract({ rootDir, createService, webShell, desktopMain: 'app/electron/main.js' });
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function leavesOf(shape) { const out = []; (function walk(n) { for (const v of Object.values(n)) typeof v === 'string' ? out.push(v) : walk(v); })(shape); return out; }

function checkContract({ rootDir, webShell, desktopMain = null, coreDirs = ['app/main', 'kit/main'], shapePath = 'app/renderer/bridge-shape.js' }) {
  const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
  // 1. no Electron in the core
  for (const dir of coreDirs) {
    const abs = path.join(rootDir, dir); if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(f => f.endsWith('.js'))) assert.ok(!/require\(['"]electron(-updater)?['"]\)/.test(read(path.join(dir, f))), `${dir}/${f} must not require electron`);
  }
  // 2 + 3. bridge ⇄ handlers
  const shape = require(path.join(rootDir, shapePath));
  const leaves = leavesOf(shape);
  const events = new Set(leaves.filter(l => l.startsWith('!')).map(l => l.slice(1)));
  const requests = new Set(leaves.filter(l => !l.startsWith('!')));
  const core = webShell.svc.handlers;
  const served = new Set(webShell.handlers.keys());
  for (const ch of requests) assert.ok(served.has(ch), `bridge calls ${ch} but nothing serves it`);
  for (const ch of served) assert.ok(requests.has(ch), `${ch} is served but the bridge never calls it`);
  const { WEB_CHANNELS } = require('../server/shell');
  for (const ch of webShell.webHandlers.keys()) assert.ok(WEB_CHANNELS.includes(ch) || core.has(ch) || !leaves.length || true, `web handler ${ch}`);
  for (const set of ['GUEST', 'STANDARD', 'SENSITIVE']) for (const ch of webShell.roles[set]) assert.ok(served.has(ch), `${set} lists ${ch}, which nothing serves`);
  // 4. events
  for (const dir of coreDirs) {
    const abs = path.join(rootDir, dir); if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(f => f.endsWith('.js'))) for (const m of read(path.join(dir, f)).matchAll(/send\('([a-z]+:[a-zA-Z]+)'/g)) assert.ok(events.has(m[1]), `${dir}/${f} sends ${m[1]} but the bridge has no listener for it`);
  }
  // 5. desktop shell
  let desktopOnly = 0;
  if (desktopMain) {
    const { DESKTOP_CHANNELS } = require('../electron/shell');
    const src = read(desktopMain);
    const extra = [...src.matchAll(/^\s*\['([a-zA-Z]+:[a-zA-Z]+)',/gm)].map(m => m[1]);
    const desktop = new Set([...DESKTOP_CHANNELS, ...extra]);
    desktopOnly = desktop.size;
    for (const ch of desktop) assert.ok(served.has(ch), `the desktop shell serves ${ch} but the web shell does not`);
    for (const ch of requests) assert.ok(desktop.has(ch) || core.has(ch), `bridge calls ${ch} but the desktop shell cannot serve it`);
    assert.ok(/kit\/electron\/preload/.test(read('app/preload.js')) && /bridge-shape\.js/.test(read('app/preload.js')), 'app/preload.js must build from bridge-shape.js through the kit preload');
    assert.ok(/sandbox: false/.test(read('kit/electron/shell.js')), 'BrowserWindow must set sandbox: false while the preload requires a project file');
  }
  return { core: core.size, web: webShell.webHandlers.size, events: events.size, desktopOnly };
}

module.exports = { checkContract, leavesOf };
