'use strict';
// Desktop bridge: builds the renderer's API object from the app's bridge-shape over Electron IPC.
// The web shell builds the same object from the same shape in kit/renderer/webbridge.js.
//
//   // app/preload.js
//   require('../kit/electron/preload').expose(require('./renderer/bridge-shape.js'), 'api');
//
// The BrowserWindow must set `sandbox: false`: a sandboxed preload cannot require a project file
// (it dies silently and the page shows "Failed to fetch").
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const listen = (ch) => (fn) => { const l = (_e, p) => fn(p); ipcRenderer.on(ch, l); return () => ipcRenderer.removeListener(ch, l); };

function build(node) {
  if (typeof node === 'string') return node.startsWith('!') ? listen(node.slice(1)) : invoke(node);
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = build(v);
  return out;
}

// Exposed as window.__<name>; kit/renderer/webbridge.js copies it to window.<name>. contextBridge globals are
// non-configurable, and a page-level `const api = window.api` would otherwise throw "already declared".
function expose(shape, name = 'api') {
  const api = build(shape);
  api.isWeb = false;
  contextBridge.exposeInMainWorld('__' + name, api);
}

module.exports = { expose, build };
