'use strict';
// Host health and hardware monitor. Plain Node, no dependencies; shared by both shells.
//
// Reads what the OS exposes cheaply: CPU load (sampled from os.cpus() deltas), memory, disk space
// for the data folder and any folders the app names, network throughput (/proc/net/dev deltas on
// Linux), uptime, and on a Raspberry Pi the SoC temperature, clock and the firmware's throttling
// flags. Samples every SAMPLE_MS into an in-memory ring (about an hour) so a System page can draw
// history without a database table.
//
//   sysmon.start(ctx); sysmon.stats(ctx)
//   ctx = { userData, db, busy: () => bool, disks: () => [{ label, path }], busyLabel: 'scan' }
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const SAMPLE_MS = 5000;
const KEEP = Math.round(3600000 / SAMPLE_MS); // one hour

const isLinux = process.platform === 'linux';
const isPi = isLinux && (() => { try { return /raspberry pi/i.test(fs.readFileSync('/proc/device-tree/model', 'utf8')); } catch { return false; } })();
const piModel = isPi ? fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim() : null;

const run = (cmd, args) => new Promise(res => execFile(cmd, args, { timeout: 3000 }, (err, out) => res(err ? null : String(out).trim())));

// ---- CPU -----------------------------------------------------------------------------
let lastCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  const now = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  let pct = null, perCore = null;
  if (lastCpu && lastCpu.length === now.length) {
    perCore = now.map((c, i) => { const dt = c.total - lastCpu[i].total, di = c.idle - lastCpu[i].idle; return dt > 0 ? Math.round(100 * (1 - di / dt)) : 0; });
    pct = Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length);
  }
  lastCpu = now;
  return { pct, perCore, cores: cpus.length, model: cpus[0] ? cpus[0].model : null, load: os.loadavg().map(x => Math.round(x * 100) / 100) };
}

// ---- memory --------------------------------------------------------------------------
function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  if (isLinux) { try { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); if (m) available = Number(m[1]) * 1024; } catch { /* keep freemem */ } }
  let swap = null;
  if (isLinux) { try { const s = fs.readFileSync('/proc/meminfo', 'utf8'); const t = /SwapTotal:\s+(\d+)/.exec(s), f = /SwapFree:\s+(\d+)/.exec(s); if (t && Number(t[1])) swap = { total: Number(t[1]) * 1024, used: (Number(t[1]) - Number(f[1])) * 1024 }; } catch { /* none */ } }
  return { total, used: total - available, available, pct: Math.round(100 * (total - available) / total), swap, process: process.memoryUsage().rss };
}

// ---- disks ---------------------------------------------------------------------------
function disk(label, p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { label, path: p, ok: true, total, free, used: total - free, pct: total ? Math.round(100 * (total - free) / total) : 0 };
  } catch (e) { return { label, path: p, ok: false, error: e.code || e.message }; }
}

// ---- network -------------------------------------------------------------------------
let lastNet = null;
function network() {
  const ifaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter(a => !a.internal && a.family === 'IPv4').map(a => ({ name, address: a.address })));
  let rate = null;
  if (isLinux) {
    try {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      let rx = 0, tx = 0;
      for (const l of lines) { const m = /^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(l); if (m && m[1] !== 'lo') { rx += Number(m[2]); tx += Number(m[3]); } }
      const t = Date.now();
      if (lastNet) { const dt = (t - lastNet.t) / 1000; if (dt > 0) rate = { rxBps: Math.max(0, (rx - lastNet.rx) / dt), txBps: Math.max(0, (tx - lastNet.tx) / dt) }; }
      lastNet = { rx, tx, t };
    } catch { /* no /proc */ }
  }
  return { interfaces: ifaces, rate };
}

// ---- Raspberry Pi specifics ----------------------------------------------------------
const THROTTLE_BITS = [
  [0, 'under-voltage now'], [1, 'ARM frequency capped now'], [2, 'throttled now'], [3, 'soft temperature limit now'],
  [16, 'under-voltage has occurred'], [17, 'ARM frequency capping has occurred'], [18, 'throttling has occurred'], [19, 'soft temperature limit has occurred'],
];
async function pi() {
  let tempC = null;
  try { tempC = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch { /* not exposed */ }
  let clockMHz = null;
  try { clockMHz = Math.round(Number(fs.readFileSync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8')) / 1000); } catch { /* none */ }
  let throttled = null;
  const raw = await run('vcgencmd', ['get_throttled']);
  if (raw) { const m = /0x([0-9a-f]+)/i.exec(raw); if (m) { const v = parseInt(m[1], 16); throttled = { raw: '0x' + m[1], flags: THROTTLE_BITS.filter(([bit]) => v & (1 << bit)).map(([, text]) => text), now: !!(v & 0xf), ever: !!(v & 0xf0000) }; } }
  let voltage = null;
  const vr = await run('vcgencmd', ['measure_volts', 'core']); if (vr) { const m = /([\d.]+)V/.exec(vr); if (m) voltage = Number(m[1]); }
  return { model: piModel, tempC: tempC == null ? null : Math.round(tempC * 10) / 10, clockMHz, throttled, voltage };
}

// ---- health verdict ------------------------------------------------------------------
// Turns one sample into { level: 'ok'|'warn'|'bad', reasons: string[] }. Level is the worst of any triggered rule.
function healthOf(s, busyLabel = 'job') {
  const reasons = [];
  let level = 'ok';
  const bump = (l, why) => { reasons.push(why); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
  if (s.pi) {
    if (s.pi.tempC != null && s.pi.tempC >= 80) bump('bad', `SoC ${s.pi.tempC.toFixed(0)} °C`);
    else if (s.pi.tempC != null && s.pi.tempC >= 70) bump('warn', `SoC ${s.pi.tempC.toFixed(0)} °C`);
    if (s.pi.throttled && s.pi.throttled.now) bump('bad', 'throttled or under-voltage right now');
    else if (s.pi.throttled && s.pi.throttled.ever) bump('warn', 'throttling or under-voltage since boot: check the power supply');
  }
  if (s.memory.pct >= 95) bump('bad', `memory ${s.memory.pct}%`);
  else if (s.memory.pct >= 85) bump('warn', `memory ${s.memory.pct}%`);
  if (s.memory.swap && s.memory.swap.used > 256 * 1024 * 1024) bump('warn', 'swapping');
  if (s.cpu.load && s.cpu.load[0] > s.cpu.cores * 2 && !s.service.busy) bump('warn', `load ${s.cpu.load[0]} on ${s.cpu.cores} cores with no ${busyLabel} running`);
  s.disks.forEach((d, i) => {
    if (!d.ok) { if (i === 0) bump('bad', 'data folder unreadable'); else if (!s.service.busy) bump('bad', `${d.label} not reachable`); return; }
    if (d.pct >= 97 || d.free < 1024 * 1024 * 1024) bump('bad', `${d.label} ${d.pct}% full`);
    else if (d.pct >= 90 || d.free < 5 * 1024 * 1024 * 1024) bump('warn', `${d.label} ${d.pct}% full`);
  });
  return { level, reasons };
}

// ---- sampler -------------------------------------------------------------------------
const history = [];
let timer = null;

async function sample(ctx) {
  const extra = typeof ctx.disks === 'function' ? ctx.disks() : [];
  const disks = [disk('Data folder', ctx.userData), ...extra.filter(d => d && d.path).map(d => disk(d.label || d.path, d.path))];
  const s = {
    ts: Date.now(),
    host: { hostname: os.hostname(), platform: `${os.type()} ${os.release()} (${os.arch()})`, uptimeS: os.uptime(), isPi, isLinux },
    cpu: cpuPercent(), memory: memory(), disks, network: network(),
    pi: isPi ? await pi() : null,
    service: { pid: process.pid, node: process.versions.node, uptimeS: Math.round(process.uptime()), rss: process.memoryUsage().rss, busy: !!(ctx.busy && ctx.busy()), dbBytes: ctx.db ? ctx.db.stats().size : null },
  };
  s.health = healthOf(s, ctx.busyLabel);
  history.push({ ts: s.ts, cpu: s.cpu.pct, mem: s.memory.pct, temp: s.pi ? s.pi.tempC : null, rx: s.network.rate ? s.network.rate.rxBps : null, tx: s.network.rate ? s.network.rate.txBps : null });
  while (history.length > KEEP) history.shift();
  return s;
}

/** Start background sampling (getters in ctx are fine). */
function start(ctx) {
  if (timer) return;
  const tick = () => { sample(ctx).catch(() => null); };
  tick();
  timer = setInterval(tick, SAMPLE_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

/** Latest sample plus history; takes a fresh sample so the page is never stale. */
async function stats(ctx) {
  const s = await sample(ctx);
  return { ...s, history: history.slice(), sampleMs: SAMPLE_MS };
}

module.exports = { start, stop, stats, healthOf, isPi, SAMPLE_MS };
