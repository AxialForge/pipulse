'use strict';
// The desktop shell: the same core as the web server, hosted in an Electron window. Everything
// that is not "be a window" lives in the core; this file owns the window, single-instance
// handling, the data folder, IPC registration, the desktop-only handlers (dialogs, shell, updates,
// security stubs) and the screenshot gate used as the release check.
//
//   // app/electron/main.js
//   require('../../kit/electron/shell').createDesktopShell({ app, createService, rootDir, screenshots: [['dashboard', '#dashboard'], …] });
//
// Flags: --profile=<dir> (separate data folder), --screenshots=<dir> [--size=WxH] (render every
// page, save PNGs, exit 3 on any renderer error), --url=<http://…> (render the web server's UI in
// the window, for documentation screenshots), --headless (run the core's `headless()` job and quit).
const path = require('path');
const fs = require('fs');
const os = require('os');

function createDesktopShell({ app: meta, createService, rootDir, window: winOpts = {}, screenshots = [], handlers: extraHandlers = null, updates = null, onReady = null, argv = process.argv }) {
  const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
  rootDir = rootDir || path.join(__dirname, '..', '..');
  const slug = meta.slug || 'bracket';
  const HEADLESS = argv.includes('--headless');
  const urlArg = (argv.find(a => a.startsWith('--url=')) || '').slice('--url='.length);
  const profileArg = argv.find(a => a.startsWith('--profile='));
  if (profileArg) app.setPath('userData', path.resolve(profileArg.slice('--profile='.length))); // Electron wants an absolute path
  const gotLock = app.requestSingleInstanceLock({ headless: HEADLESS });
  if (!gotLock) { app.quit(); return null; }

  let win = null;
  let updateStatus = { state: 'idle' };
  const userData = app.getPath('userData');
  const logFile = path.join(userData, `${slug}.log`);
  const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`; try { fs.appendFileSync(logFile, line); } catch { /* ignore */ } if (!app.isPackaged) process.stdout.write(line); };
  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  const svc = createService({ dataDir: userData, log, send, host: app });
  let updater = null;
  try { updater = require('./updater'); } catch { /* electron-updater not installed: manual updates only */ }

  function createWindow() {
    win = new BrowserWindow({
      width: 1400, height: 900, minWidth: 980, minHeight: 620, title: meta.name || slug, backgroundColor: '#0f1115', autoHideMenuBar: true,
      icon: path.join(rootDir, 'build', 'icon.png'),
      ...winOpts,
      // sandbox must be false: the preload requires the app's bridge-shape.js, which a sandboxed preload cannot load.
      webPreferences: { preload: urlArg ? undefined : path.join(rootDir, 'app', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, ...(winOpts.webPreferences || {}) },
    });
    if (urlArg) win.loadURL(urlArg); else win.loadFile(path.join(rootDir, 'app', 'renderer', 'index.html'));
    win.on('closed', () => { win = null; });
  }

  app.on('second-instance', (_e, argv2, _cwd, extra) => {
    const wantsHeadless = (extra && extra.headless) || (argv2 || []).includes('--headless');
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    else if (!wantsHeadless) createWindow();
    if (wantsHeadless && typeof svc.headless === 'function') svc.headless('task').catch(e => log('headless job failed: ' + e.message));
  });

  app.whenReady().then(async () => {
    if (typeof svc.init === 'function') svc.init();
    if (HEADLESS) {
      if (typeof svc.headless === 'function') { try { await svc.headless('task'); } catch (e) { log('headless job failed: ' + e.message); } }
      app.quit(); return;
    }
    createWindow();
    const shotArg = argv.find(a => a.startsWith('--screenshots='));
    if (shotArg) {
      // The pass is the release gate: besides the PNGs it fails (exit 3) when any page logged a renderer error or an uncaught exception.
      const pageErrors = [];
      // Electron ≥ 35 passes one event object ({ level: 'error', message, lineNumber, sourceId }); older versions pass positional args.
      const hook = () => { if (!win) return setTimeout(hook, 50); win.webContents.on('console-message', (e, level, message, line, source) => {
        const m = typeof e === 'object' && e && 'message' in e ? { bad: e.level === 'error' || e.level >= 3, message: e.message, line: e.lineNumber, source: e.sourceId } : { bad: level >= 3, message, line, source };
        if (m.bad) pageErrors.push(`${m.message} (${String(m.source).split('/').pop()}:${m.line}) at ${win.webContents.getURL().split('#')[1] || ''}`);
      }); };
      hook();
      captureScreenshots(shotArg.slice('--screenshots='.length)).then(() => {
        if (pageErrors.length) { for (const e of pageErrors) { log('screenshot gate: renderer error: ' + e); console.error('RENDERER ERROR: ' + e); } app.exit(3); } else app.quit();
      }).catch(e => { console.error('screenshot pass failed: ' + e.message); app.exit(4); });
      return;
    }
    if (typeof svc.start === 'function') svc.start();
    if (updater) {
      const enabled = updates && typeof updates.enabled === 'function' ? updates.enabled() : true;
      updater.start({ enabled, onStatus: st => { updateStatus = st; log('update: ' + JSON.stringify(st)); send('update:status', st); } });
    }
    if (typeof onReady === 'function') onReady({ win, svc, app });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // `--screenshots=<dir>`: render each view with the live data and save PNGs.
  async function captureScreenshots(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // An occluded window stops painting and capturePage() returns stale frames; keep it painting and in front for the run.
    win.webContents.setBackgroundThrottling(false); win.setAlwaysOnTop(true);
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await sleep(1500);
    const size = (argv.find(a => a.startsWith('--size=')) || '').slice('--size='.length);
    if (/^\d+x\d+$/.test(size)) { const [w, hh] = size.split('x').map(Number); win.setMinimumSize(200, 200); win.setContentSize(w, hh); await sleep(800); }
    const P = String(slug).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (urlArg) {
      // Web build: capture the sign-in dialog, sign in with <SLUG>_SHOT_PASSWORD, then the pages.
      await sleep(1500);
      const img0 = await win.webContents.capturePage(); if (!img0.isEmpty()) { fs.writeFileSync(path.join(dir, 'web-login.png'), img0.toPNG()); log('screenshot web-login'); }
      await win.webContents.executeJavaScript(`(() => { const f = document.querySelector('.webauth form'); if (!f) return false; f.elements.username.value = 'admin'; f.elements.password.value = ${JSON.stringify(process.env[`${P}_SHOT_PASSWORD`] || '')}; f.querySelector('button[type=submit]').click(); return true; })()`);
      await sleep(2500);
    }
    const settle = async (hash) => {
      await win.webContents.executeJavaScript(`(() => { document.querySelector('#view').textContent = 'Loading…'; if (location.hash === ${JSON.stringify(hash)}) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = ${JSON.stringify(hash)}; })()`);
      for (let i = 0; i < 100; i++) {
        const ok = await win.webContents.executeJavaScript(`location.hash === ${JSON.stringify(hash)} && !document.querySelector('#view')?.textContent.startsWith('Loading')`);
        if (ok) break;
        await sleep(100);
      }
      await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await sleep(400);
    };
    const capture = async (file) => {
      for (let i = 0; i < 5; i++) {
        const img = await win.webContents.capturePage();
        if (!img.isEmpty()) { fs.writeFileSync(file, img.toPNG()); return true; }
        await sleep(300);
      }
      log('screenshot FAILED (empty capture): ' + file); return false;
    };
    for (const [name, hash] of screenshots) {
      await settle(hash);
      if (await capture(path.join(dir, `${urlArg ? 'web-' : ''}${name}.png`))) log('screenshot ' + name);
    }
  }

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', () => { if (typeof svc.shutdown === 'function') svc.shutdown(); });

  // ---- IPC ---------------------------------------------------------------------
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));
  const repo = meta.repo || null;
  h('app:info', async () => ({
    version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, web: false, https: false,
    platform: `${os.type()} ${os.release()} (${os.arch()})`, hostname: os.hostname(), cpus: os.cpus().length, dataDir: userData, logFile, dbFile: svc.db ? svc.db.file : null,
    packaged: app.isPackaged, repo, updateStatus, db: svc.db ? svc.db.stats() : null, name: meta.name, slug,
  }));
  h('dialog:pickFolder', async (initial) => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: initial || undefined }); return r.canceled ? null : r.filePaths[0]; });
  h('dialog:pickFile', async (filters) => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: Array.isArray(filters) && filters.length ? filters : undefined }); return r.canceled ? null : r.filePaths[0]; });
  h('shell:open', (p) => shell.openPath(p));
  h('shell:openExternal', (u) => /^https:\/\//.test(u) ? shell.openExternal(u) : false);
  h('shell:showItem', (p) => shell.showItemInFolder(p));
  h('update:install', () => (updater ? updater.installNow() : { ok: false }));
  h('update:status', () => updateStatus);
  h('update:check', async () => {
    if (!app.isPackaged || !updater) return { state: 'error', message: 'Updates only run in the installed app.' };
    try { const { autoUpdater } = require('electron-updater'); await autoUpdater.checkForUpdates(); return updateStatus; }
    catch (e) { updateStatus = { state: 'error', message: updater.friendlyError(e) }; return updateStatus; }
  });
  // Security controls belong to the web server (sessions, 2FA, lockout). The desktop app has no login, so it only reports that.
  h('security:status', () => ({ available: false }));
  h('security:me', () => ({ available: false, guest: false, username: null, role: 'admin' })); // the desktop user owns the machine
  h('status:info', () => ({ available: false }));
  for (const ch of ['status:rotate', 'security:changePassword', 'security:totpSetup', 'security:totpEnable', 'security:totpDisable', 'security:setOptions', 'security:revoke', 'security:revokeOthers', 'security:users', 'security:addUser', 'security:setRole', 'security:resetPassword', 'security:deleteUser', 'security:tlsEnable']) h(ch, () => { throw new Error('Only available on the web server'); });
  const extra = typeof extraHandlers === 'function' ? extraHandlers({ win: () => win, svc, app, dialog, shell, log }) : (extraHandlers || new Map());
  for (const [ch, fn] of extra) h(ch, fn);
  // Everything else comes from the core, unchanged in name and signature.
  for (const [ch, fn] of svc.handlers) if (!extra.has(ch)) h(ch, fn);

  return { svc, log, userData, window: () => win };
}

// The channels this shell serves on its own; the contract test uses the list.
const DESKTOP_CHANNELS = ['app:info', 'dialog:pickFolder', 'dialog:pickFile', 'shell:open', 'shell:openExternal', 'shell:showItem', 'update:install', 'update:status', 'update:check', 'security:status', 'security:me', 'status:info', 'status:rotate', 'security:changePassword', 'security:totpSetup', 'security:totpEnable', 'security:totpDisable', 'security:setOptions', 'security:revoke', 'security:revokeOthers', 'security:users', 'security:addUser', 'security:setRole', 'security:resetPassword', 'security:deleteUser', 'security:tlsEnable'];

module.exports = { createDesktopShell, DESKTOP_CHANNELS };
