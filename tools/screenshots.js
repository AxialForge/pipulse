#!/usr/bin/env node
'use strict';
/* Screenshots of every dashboard page for the README, from a running hub (normally the dev hub
   with tools/demo.py feeding it). Drives headless Edge or Chrome over the DevTools protocol with
   Node's built-in WebSocket: no npm packages.

     node tools/screenshots.js [--hub http://localhost:8750] [--out docs/screenshots] [--user admin]
     (password from PIPULSE_SHOT_PASSWORD)

   The install token is replaced with <token> before anything is captured, so no real secret ends
   up in a published image. Exits 3 when a page shows an error, like MediaLedger's release gate. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HUB = opt('--hub', 'http://localhost:8750').replace(/\/$/, '');
const OUT = path.resolve(opt('--out', path.join(__dirname, '..', 'docs', 'screenshots')));
const USER = opt('--user', 'admin');
const PASSWORD = process.env.PIPULSE_SHOT_PASSWORD;
const PORT = 9333;
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One entry per image: where to go, what to do first, and how tall the shot may grow.
const SHOTS = [
  { file: 'pis.png', hash: 'pis', w: 1280, maxH: 1000 },
  { file: 'pi-overview.png', hash: 'pi/demo02', w: 1280, maxH: 1150 },
  { file: 'pi-history.png', hash: 'pi/demo00/history', w: 1280, maxH: 1500, before: "localStorage.setItem('pipulse.range','7d')", wait: 2500 },
  { file: 'pi-services.png', hash: 'pi/demo00/services', w: 1280, maxH: 1100 },
  { file: 'limit.png', hash: 'pi/demo00/services', w: 1280, maxH: 800, after: "document.querySelector('button[data-limit]').click(); document.querySelector('.chip[data-p=\"gentle\"]').click();" },
  { file: 'glossary.png', hash: 'pi/demo02', w: 1280, maxH: 800, after: "document.querySelector('#piTiles .term[data-term=\"load\"]').click();" },
  { file: 'events.png', hash: 'events', w: 1280, maxH: 1000 },
  { file: 'add-a-pi.png', hash: 'add', w: 1280, maxH: 900, after: "const t=document.querySelector('#sshHosts'); t.value='192.168.1.210\\n192.168.1.211'; t.dispatchEvent(new Event('input'));" },
  { file: 'settings.png', hash: 'settings', w: 1280, maxH: 2600 },
  { file: 'security.png', hash: 'security', w: 1280, maxH: 1400 },
  { file: 'about.png', hash: 'about', w: 1280, maxH: 1400 },
  { file: 'phone.png', hash: 'pis', w: 390, maxH: 844, mobile: true },
];

function findBrowser() { const b = BROWSERS.find(p => fs.existsSync(p)); if (!b) throw new Error('No Edge or Chrome found'); return b; }

async function devtools() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); const t = (await r.json()).find(x => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('browser did not open its DevTools port');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { ok, fail } = pending.get(d.id); pending.delete(d.id); d.error ? fail(new Error(d.error.message)) : ok(d.result); } };
  const send = (method, params = {}) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((ok, fail) => { ws.onopen = () => ok({ send, close: () => ws.close() }); ws.onerror = fail; });
}

async function main() {
  if (!PASSWORD) throw new Error('Set PIPULSE_SHOT_PASSWORD to the dashboard password of the hub being captured');
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shots-'));
  const browser = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  let failed = false;
  try {
    const cdp = await connect(await devtools());
    const js = async (expression) => (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: HUB + '/' });
    await sleep(1500);
    const login = await js(`fetch('api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username: USER, password: PASSWORD })})}).then(r=>r.status)`);
    if (login !== 200) throw new Error(`sign-in failed (${login})`);
    for (const s of SHOTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.maxH, deviceScaleFactor: s.mobile ? 2 : 1.25, mobile: !!s.mobile });
      await cdp.send('Page.navigate', { url: `${HUB}/?shot=${Date.now()}#${s.hash}` });
      await sleep(1200);
      if (s.before) { await js(s.before); await cdp.send('Page.navigate', { url: `${HUB}/?shot=${Date.now()}#${s.hash}` }); await sleep(1200); }
      await sleep(s.wait || 900);
      if (s.after) { await js(s.after); await sleep(700); }
      // No secret in a published picture: blank the install token wherever it appears.
      await js(`document.querySelectorAll('#view *').forEach(n => { for (const c of n.childNodes) if (c.nodeType === 3 && /[?&]t=/.test(c.textContent)) c.textContent = c.textContent.replace(/([?&]t=)[A-Za-z0-9_-]+/g, '$1<token>'); })`);
      const err = await js(`(document.querySelector('#view .empty') || {}).textContent || ''`);
      if (/^Error/.test(err)) { console.error(`${s.file}: page error: ${err}`); failed = true; }
      if (!s.mobile && !s.fixed) { // grow to the page's height (up to maxH) so a whole page fits in one image
        const h = await js(`Math.max(document.querySelector('#view').scrollHeight, document.querySelector('.sidebar').scrollHeight)`);
        const height = Math.min(s.maxH, Math.max(700, h));
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height, deviceScaleFactor: 1.25, mobile: false });
        await sleep(400);
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, s.file), Buffer.from(data, 'base64'));
      console.log(`${s.file}  ${(Buffer.byteLength(data, 'base64') / 1024).toFixed(0)} KB`);
    }
    cdp.close();
  } finally {
    browser.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  if (failed) process.exit(3);
}

main().catch(e => { console.error(e.message); process.exit(1); });
