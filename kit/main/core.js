'use strict';
// The core skeleton every Bracket app builds its service on. Nothing in here touches Electron or
// HTTP: the shells (kit/server/shell.js, kit/electron/shell.js) host whatever this returns.
//
//   const core = createCore({ app, dataDir, log, send, defaults, schema, migrations, counts, disks });
//   core.h('items:list', () => core.db.all('SELECT * FROM items'));       // add a handler
//   core.daily('backup', () => core.settings.get().backup.time, () => …);  // a job once a day at HH:MM
//   core.every('poll', 30000, () => …);                                    // a job on an interval
//   core.start(); core.shutdown();
//
// The shells call `handlers.get(channel)(...args)` for requests and `send(channel, payload)` for
// events to the UI. Base handlers the kit provides: settings:get/set/replace, sys:stats, db:stats,
// log:tail, notify:test, prefs:get/set (per-machine on the desktop; the web shell overrides them
// per account).
const fs = require('fs');
const path = require('path');
const { Settings, deepMerge } = require('./settings');
const { Db } = require('./db');
const { createNotifier } = require('./notify');
const sysmon = require('./sysmon');
const { dayKey } = require('./csv');

function createCore({ app = {}, dataDir, log = () => {}, send = () => {}, defaults = {}, schema = '', migrations = [], counts = [], disks = null, busy = null, busyLabel = 'job' }) {
  const slug = app.slug || 'bracket';
  // The kit's own defaults, deep-merged with the app's so `notify: { events }` in an app keeps the kit's e-mail block.
  const KIT_DEFAULTS = { ui: { prefs: {} }, notify: { webhookUrl: '', email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' }, events: {}, dailyTime: '08:00' }, githubToken: '' };
  const settings = new Settings(dataDir, deepMerge(KIT_DEFAULTS, defaults));
  const db = new Db(path.join(dataDir, `${slug}.db`), { schema, migrations, log, counts });
  const notifier = createNotifier(() => settings.get().notify, log, { app: app.name || slug });
  const notify = (event, title, text, data) => notifier.send(event, title, text, data).catch(e => log('notify: ' + e.message));
  const logFile = path.join(dataDir, `${slug}.log`);
  const sysCtx = { userData: dataDir, db, busy: () => !!(busy && busy()), disks: disks || (() => []), busyLabel };
  const handlers = new Map();
  const h = (ch, fn) => { handlers.set(ch, fn); return fn; };

  // ---- jobs: once a day at HH:MM (local, remembered in kv so a restart never repeats one) or every N ms
  const dailyJobs = [], intervalJobs = [];
  let minuteTimer = null;
  function dueToday(key, hhmm, now) {
    const [hh, mm] = String(hhmm || '').split(':').map(Number);
    if (isNaN(hh)) return false;
    const at = new Date(now); at.setHours(hh, mm || 0, 0, 0);
    return now >= at.getTime() && db.kvGet(key, '') !== dayKey(now);
  }
  /** Run `fn` once a day at the HH:MM that `timeOf()` returns (a settings getter). Failures are logged and retried next day. */
  function daily(name, timeOf, fn) { dailyJobs.push({ name, timeOf, fn }); }
  /** Run `fn` every `ms` (or the number `msOf()` returns) while the core runs. */
  function every(name, msOf, fn) { intervalJobs.push({ name, msOf: typeof msOf === 'function' ? msOf : () => msOf, fn, timer: null }); }
  async function minute(now = Date.now()) {
    for (const j of dailyJobs) {
      if (!dueToday('job.' + j.name, j.timeOf(), now)) continue;
      db.kvSet('job.' + j.name, dayKey(now));
      try { await j.fn(now); db.jobDone(j.name, true); } catch (e) { db.jobDone(j.name, false, e.message); log(`job ${j.name}: ${e.message}`); }
    }
  }
  const settingsChanged = [];
  /** Called with (before, after) whenever settings are saved; use it to restart timers whose config changed. */
  const onSettings = (fn) => settingsChanged.push(fn);
  const applySettings = (before, after) => { for (const fn of settingsChanged) { try { fn(before, after); } catch (e) { log('settings hook: ' + e.message); } } };

  // ---- base handlers ----------------------------------------------------------------------
  h('settings:get', () => settings.get());
  h('settings:set', (patch) => { const before = structuredClone(settings.get()); const after = settings.set(patch || {}); applySettings(before, after); return after; });
  h('settings:replace', (next) => { const before = structuredClone(settings.get()); const after = settings.replace(next || {}); applySettings(before, after); return after; });
  h('sys:stats', () => sysmon.stats(sysCtx));
  h('db:stats', () => db.stats());
  h('log:tail', (n = 300) => { try { const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n'); return lines.slice(-Math.min(Number(n) || 300, 3000)); } catch { return []; } });
  h('notify:test', () => notifier.send('test', `${app.name || slug} test notification`, `If you can read this, ${app.name || slug} notifications work.`));
  h('prefs:get', () => (settings.get().ui || {}).prefs || {});
  h('prefs:set', (patch) => { const prefs = { ...((settings.get().ui || {}).prefs || {}), ...(patch || {}) }; for (const k of Object.keys(prefs)) if (prefs[k] === null) delete prefs[k]; settings.set({ ui: { prefs } }); return prefs; });

  function start() {
    sysmon.start(sysCtx);
    for (const j of intervalJobs) { const tick = () => Promise.resolve().then(() => j.fn()).catch(e => log(`job ${j.name}: ${e.message}`)); j.timer = setInterval(tick, Math.max(1000, Number(j.msOf()) || 60000)); setTimeout(tick, 3000); }
    minuteTimer = setInterval(() => minute().catch(e => log('minute: ' + e.message)), 60000);
    setTimeout(() => minute().catch(e => log('minute: ' + e.message)), 20000);
  }
  function shutdown() { clearInterval(minuteTimer); for (const j of intervalJobs) clearInterval(j.timer); sysmon.stop(); db.close(); }
  /** Restart one interval job (after its settings changed). */
  function restart(name) { const j = intervalJobs.find(x => x.name === name); if (!j || !j.timer) return; clearInterval(j.timer); const tick = () => Promise.resolve().then(() => j.fn()).catch(e => log(`job ${j.name}: ${e.message}`)); j.timer = setInterval(tick, Math.max(1000, Number(j.msOf()) || 60000)); tick(); }

  return { app, slug, dataDir, logFile, settings, db, notifier, notify, handlers, h, daily, every, minute, onSettings, start, shutdown, restart, send, log };
}

module.exports = { createCore };
