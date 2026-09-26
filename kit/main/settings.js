'use strict';
// Settings live in <data>/settings.json: the app's defaults deep-merged with whatever was saved.
// Secrets may live in here too (API keys, SMTP passwords); the web shell redacts the paths the app
// names in `secrets` for every role and maps the placeholder back when a form is saved.
const fs = require('fs');
const path = require('path');

class Settings {
  /** @param {string} dataDir  @param {object} defaults  the app's full default tree */
  constructor(dataDir, defaults = {}) {
    this.file = path.join(dataDir, 'settings.json');
    this.defaults = defaults;
    this.data = this._load();
  }
  _load() {
    try { return deepMerge(structuredClone(this.defaults), JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { return structuredClone(this.defaults); }
  }
  get() { return this.data; }
  set(patch) { this.data = deepMerge(this.data, patch); this.save(); return this.data; }
  replace(next) { this.data = deepMerge(structuredClone(this.defaults), next); this.save(); return this.data; }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
  }
}

/** Objects merge key by key; arrays and scalars replace. `undefined` in the patch keeps the base. */
function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const k of Object.keys(patch)) out[k] = deepMerge(out[k], patch[k]);
    return out;
  }
  return patch === undefined ? base : patch;
}

/** Read / write a dotted path such as 'notify.email.pass'. */
const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, dotted, value) { const keys = dotted.split('.'); let o = obj; for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } o[keys[keys.length - 1]] = value; }

module.exports = { Settings, deepMerge, getPath, setPath };
