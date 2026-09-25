// PiPulse Hub dashboard. Polls the hub; no framework, no build step.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => v == null ? '–' : `${Math.round(v)}%`;
const level = (v, warn, crit) => v >= crit ? 'crit' : v >= warn ? 'warn' : '';
function bytes(n) {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function dur(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const when = ts => new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json();
  if (r.status === 401 && !path.startsWith('/api/auth/')) { showLogin(); throw new Error('signed out'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let state = { nodes: [] }, openId = null, tab = 'overview', detail = null, signedIn = false, setupMode = false;
let view = 'pis', settingsData = null;

// ------------------------------------------------------------------ sign in

async function showLogin() {
  signedIn = false;
  $$('dialog[open]').forEach(d => d.close());
  const s = await (await fetch('/api/auth')).json();
  setupMode = s.setup;
  $('#loginMsg').textContent = setupMode
    ? 'Create a password for this hub. You\'ll use it to sign in from any device.'
    : 'Sign in to see your Pis.';
  $('#pw').autocomplete = setupMode ? 'new-password' : 'current-password';
  $('#pw2').hidden = !setupMode; $('#pw2').required = setupMode;
  $('#loginBtn').textContent = setupMode ? 'Create password' : 'Sign in';
  $('#loginErr').textContent = '';
  $('#login').hidden = false;
  $('#pw').focus();
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#pw').value;
  if (setupMode && pw !== $('#pw2').value) return $('#loginErr').textContent = 'The two passwords don\'t match.';
  $('#loginBtn').disabled = true;
  try {
    await api(setupMode ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    $('#pw').value = $('#pw2').value = '';
    $('#login').hidden = true; signedIn = true;
    route();
  } catch (err) { $('#loginErr').textContent = err.message; }
  $('#loginBtn').disabled = false;
});

$('#logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};

// ------------------------------------------------------------------ views

function route() {
  view = (location.hash.slice(1) || 'pis').split('/')[0];
  if (!['pis', 'events', 'settings', 'about'].includes(view)) view = 'pis';
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + view);
  $$('nav.views a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  if (!signedIn) return;
  poll();
  if (view === 'events') loadEvents();
  if (view === 'settings') loadSettings();
  if (view === 'about') loadAbout();
}
addEventListener('hashchange', route);

// ------------------------------------------------------------------ Pis grid

function meter(label, value, text, warn = 70, crit = 90) {
  return `<div class="meter"><div class="lbl"><span>${label}</span><span>${text}</span></div>
    <div class="bar"><i class="${level(value ?? 0, warn, crit)}" style="width:${Math.min(100, value ?? 0)}%"></i></div></div>`;
}
const memUse = m => m?.mem?.total ? 100 * (1 - m.mem.avail / m.mem.total) : null;
const rootDisk = m => (m?.disks || []).find(d => d.mount === '/') || (m?.disks || [])[0];
const nodeName = n => n.label || n.hostname || n.id;

function card(n) {
  const m = n.metrics, worst = n.alerts.some(a => a[0] === 'crit') ? 'crit' : n.alerts.length ? 'warn' : '';
  const disk = rootDisk(m), mu = memUse(m);
  const span = n.hist.length > 1 ? dur(Math.min(3600, Math.max(60, n.hist.at(-1)[0] - n.hist[0][0]))) : 'minute';
  const body = m ? `
    <div class="meters">
      ${meter('CPU', m.cpu, pct(m.cpu), 70, 90)}
      ${meter('RAM', mu, `${bytes(m.mem.total - m.mem.avail)} / ${bytes(m.mem.total)}`, 80, 90)}
      ${meter('Temp', m.temp == null ? 0 : (m.temp / 85) * 100, m.temp == null ? '–' : `${m.temp.toFixed(1)} °C`, 82, 94)}
      ${disk ? meter('Disk ' + disk.mount, 100 * disk.used / disk.total, `${bytes(disk.used)} / ${bytes(disk.total)}`, 85, 95) : '<div></div>'}
    </div>
    <canvas class="spark" data-id="${esc(n.id)}"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>CPU</span><span><i style="background:var(--accent2)"></i>RAM</span><span><i style="background:var(--warn)"></i>Temp</span><span style="margin-left:auto">last ${span}</span></div>` : '';
  const alerts = n.alerts.length ? `<div class="alerts">${n.alerts.map(a => `<div class="alert ${a[0]}">${esc(a[1])}</div>`).join('')}</div>` : '';
  return `<div class="card ${worst} ${n.online ? '' : 'off'}" data-id="${esc(n.id)}">
    <div class="cardHead"><span class="dot ${n.online ? '' : 'off'}"></span><b>${esc(nodeName(n))}</b>
      ${n.outdated ? '<span class="tag warnTag">update</span>' : ''}
      ${n.pending ? `<span class="tag">${n.pending} pending</span>` : ''}
      ${m && n.online ? `<span class="muted">up ${dur(m.uptime)}</span>` : ''}</div>
    <div class="sub">${esc(n.info?.model || '')}${n.info?.cores ? ` · ${n.info.cores} cores` : ''}${m ? ` · load ${m.load.map(x => x.toFixed(2)).join(' ')}` : ''}</div>
    ${body}${alerts}</div>`;
}

function spark(canvas, hist) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  g.strokeStyle = '#2a313b'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h - .5); g.lineTo(w, h - .5); g.stroke();
  if (hist.length < 2) return;
  // Stretch whatever history exists (up to an hour) across the full width.
  const t1 = hist[hist.length - 1][0], t0 = Math.max(t1 - 3600, hist[0][0]), span = Math.max(60, t1 - t0);
  for (const [idx, color, max] of [[1, '#34d399', 100], [2, '#60a5fa', 100], [3, '#fbbf24', 90]]) {
    g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
    let started = false;
    for (const p of hist) {
      if (p[idx] == null || p[0] < t0) continue;
      const x = (p[0] - t0) / span * w, y = h - 2 - Math.min(1, p[idx] / max) * (h - 4);
      started ? g.lineTo(x, y) : g.moveTo(x, y); started = true;
    }
    g.stroke();
  }
}

function renderGrid() {
  const nodes = [...state.nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  $('#empty').hidden = nodes.length > 0;
  $$('pre.cmd').forEach(p => p.textContent = state.install || '');
  // The install command already carries the hub's LAN address (never localhost).
  $$('.hubUrl').forEach(s => s.textContent = (state.install || '').match(/https?:\/\/[^/']+/)?.[0] || location.origin);
  $('#grid').innerHTML = nodes.map(card).join('');
  for (const c of $$('canvas.spark')) {
    const n = nodes.find(n => n.id === c.dataset.id);
    if (n) spark(c, n.hist);
  }
  const outdated = nodes.filter(n => n.online && n.outdated);
  $('#fleetBar').hidden = !outdated.length;
  $('#fleetBar').innerHTML = outdated.length ? `<span>${outdated.length} Pi${outdated.length > 1 ? 's run' : ' runs'} an older client than this hub (${esc(state.version)}).</span>
    <button class="btn small" data-updateall>Update all Pis</button>` : '';
  $('#updBanner').hidden = !state.update_available;
  $('#updBanner').textContent = state.update_available ? `PiPulse ${state.update_available} is available` : '';
  const on = nodes.filter(n => n.online).length, bad = nodes.filter(n => n.alerts.some(a => a[0] === 'crit')).length;
  $('#totals').textContent = nodes.length ? `${on}/${nodes.length} online${bad ? ` · ${bad} need attention` : ''}` : '';
  const sel = $('#evNode'), cur = sel.value;
  sel.innerHTML = '<option value="">All Pis</option>' + nodes.map(n => `<option value="${esc(n.id)}">${esc(nodeName(n))}</option>`).join('');
  sel.value = cur;
}

async function poll() {
  if (!signedIn) return;
  try {
    state = await api('/api/state');
    renderGrid();
    if (openId) await loadDetail();
  } catch (e) { if (signedIn) $('#totals').textContent = 'hub unreachable: ' + e.message; }
}

// ------------------------------------------------------------------ Pi detail

async function loadDetail() {
  try { detail = await api('/api/node/' + encodeURIComponent(openId)); }
  catch { detail = null; $('#nodeDlg').close(); return; }
  renderDetail();
}

function renderDetail(force = false) {
  const n = detail, m = n.metrics;
  $('#nTitle').textContent = nodeName(n);
  $('#nSub').textContent = [n.label ? n.hostname : '', n.info?.model, n.info?.os, n.online ? '' : 'OFFLINE'].filter(Boolean).join(' · ');
  if (tab === 'history' && !force) return;  // has its own, slower refresh
  // Rows re-sort by load, so hold the table still while the pointer is on it;
  // otherwise a button can slide away between aiming and clicking.
  const body = $('#tabBody'), top = body.scrollTop;
  if (!force && body.querySelector('table')?.matches(':hover')) return;
  if (tab === 'history') return loadHistory();
  body.innerHTML = !m && tab !== 'events' ? '<p class="muted">No data yet.</p>' : tabs[tab](n, m);
  body.scrollTop = top;
}

const THROTTLE_BITS = [[0, 'Under-voltage now'], [1, 'ARM frequency capped now'], [2, 'Throttled now'], [3, 'Soft temperature limit now'],
  [16, 'Under-voltage has happened'], [17, 'Frequency capping has happened'], [18, 'Throttling has happened'], [19, 'Soft temp limit has happened']];

function eventRow(e, showName) {
  return `<div class="ev ${e.level}"><time>${when(e.ts)}</time><b>●</b>${showName ? `<span class="evName">${esc(e.name)}</span>` : ''}<span>${esc(e.msg)}</span></div>`;
}

const tabs = {
  overview(n, m) {
    const th = m.throttled;
    const thText = th == null ? '<span class="muted">vcgencmd not available</span>'
      : th === 0 ? '<span style="color:var(--accent)">No throttling or under-voltage since boot</span>'
      : THROTTLE_BITS.filter(([b]) => th & (1 << b)).map(([, t]) => `<div class="alert ${t.endsWith('now') ? 'crit' : ''}">${t}</div>`).join('');
    const client = n.outdated
      ? `${esc(n.client_version)} <button class="btn small" data-update>Update to ${esc(n.hub_version)}</button>`
      : esc(n.client_version || '?');
    return `
      ${n.alerts.length ? `<div class="alerts" style="margin:0 0 14px">${n.alerts.map(a => `<div class="alert ${a[0]}">${esc(a[1])}</div>`).join('')}</div>` : ''}
      <div class="grid2">
        <div class="box"><h3>CPU cores</h3><div class="cores">${m.cores.map((c, i) => meter('core ' + i, c, pct(c))).join('')}</div>
          <div class="kv" style="margin-top:12px"><span>Load (1/5/15m)</span><span>${m.load.map(x => x.toFixed(2)).join(' / ')}</span>
          <span>Processes</span><span>${m.nprocs}</span></div></div>
        <div class="box"><h3>Memory</h3>
          ${meter('RAM used', memUse(m), `${bytes(m.mem.total - m.mem.avail)} / ${bytes(m.mem.total)}`, 80, 90)}
          ${m.mem.swap_total ? meter('Swap used', 100 * (m.mem.swap_total - m.mem.swap_free) / m.mem.swap_total, `${bytes(m.mem.swap_total - m.mem.swap_free)} / ${bytes(m.mem.swap_total)}`, 30, 60) : '<p class="muted">No swap</p>'}</div>
        <div class="box"><h3>Disks</h3>${(m.disks || []).map(d => meter(d.mount, 100 * d.used / d.total, `${bytes(d.used)} / ${bytes(d.total)}`, 85, 95)).join('') || '<p class="muted">None found</p>'}</div>
        <div class="box"><h3>Power &amp; heat</h3>
          <div class="kv"><span>Temperature</span><span>${m.temp == null ? '–' : m.temp.toFixed(1) + ' °C'}</span>
          <span>Network</span><span>↓ ${bytes(m.net.rx)}/s · ↑ ${bytes(m.net.tx)}/s</span>
          <span>Uptime</span><span>${dur(m.uptime)}</span></div>
          <div style="margin-top:10px">${thText}</div></div>
        ${healthBox(n, m)}
        <div class="box"><h3>System</h3><div class="kv">
          <span>Model</span><span>${esc(n.info.model)}</span><span>OS</span><span>${esc(n.info.os)}</span>
          <span>Kernel</span><span>${esc(n.info.kernel)} (${esc(n.info.arch)})</span>
          <span>Limits support</span><span>${n.info.cgroup2 && n.info.systemd ? 'yes (systemd + cgroup v2)' : '<span style="color:var(--warn)">no: needs systemd with cgroup v2</span>'}</span>
          <span>Client</span><span>${client}</span>
          <span>Last report</span><span>${when(n.seen)}</span></div></div>
      </div>`;
  },

  services(n) {
    const cores = n.info.cores || 1;
    const watch = n.prefs?.watch || {};
    const rows = n.services.map(s => {
      const limits = [
        s.cpu_quota ? `<span class="tag">CPU ≤ ${(s.cpu_quota / 100).toFixed(2).replace(/\.?0+$/, '')} core</span>` : '',
        s.mem_max ? `<span class="tag">RAM ≤ ${bytes(s.mem_max)}</span>` : '',
        s.cpu_weight && s.cpu_weight !== 100 ? `<span class="tag">weight ${s.cpu_weight}</span>` : '',
      ].join('');
      const u = esc(s.unit);
      return `<tr><td class="mono">${u}</td><td class="num">${s.cpu.toFixed(1)}%</td><td class="num">${bytes(s.mem)}</td>
        <td class="num">${s.tasks}</td><td>${limits || '<span class="muted">none</span>'}</td>
        <td class="acts">${s.unit.endsWith('.service') ? `<button class="btn small ${watch[s.unit] ? '' : 'ghost'}" data-watch="${u}" title="Alert if it stops">${watch[s.unit] ? 'Watching' : 'Watch'}</button>` : ''}
        <button class="btn small ghost" data-limit="${u}">Limit</button>
        ${s.unit.endsWith('.service') ? `<button class="btn small ghost" data-restart="${u}">Restart</button>` : ''}</td></tr>`;
    }).join('');
    return watchPanel(n) + `<div class="hint">Put a cap on any service that hogs the Pi. <b>CPU %</b> is of one core (${cores} cores = ${cores * 100}%). Caps apply straight away and stay in place after a reboot.</div>
      <table><thead><tr><th>Service</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Tasks</th><th>Limits</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No services reported (needs systemd + cgroup v2).</td></tr>'}</tbody></table>`;
  },

  procs(n) {
    const rows = [...n.procs].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).map(p => `
      <tr><td class="num">${p.pid}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.user)}</td>
      <td class="num">${p.cpu.toFixed(1)}%</td><td class="num">${bytes(p.rss)}</td><td class="num">${p.nice}</td>
      <td class="mono">${esc(p.unit || '')}</td><td class="cmd mono" title="${esc(p.cmd)}">${esc(p.cmd)}</td>
      <td class="acts"><button class="btn small ghost" data-renice="${p.pid}" data-name="${esc(p.name)}">Nice</button>
      ${p.unit ? `<button class="btn small ghost" data-limit="${esc(p.unit)}">Limit service</button>` : ''}</td></tr>`).join('');
    return `<div class="hint">These are the busiest processes and the biggest memory users. <b>Nice</b> lowers a process's priority until it restarts. For a limit that lasts, use <b>Limit service</b>.</div>
      <table><thead><tr><th class="num">PID</th><th>Name</th><th>User</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Nice</th><th>Service</th><th>Command</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  },

  events(n) {
    if (!n.events.length) return '<p class="muted">Nothing yet.</p>';
    return n.events.map(e => eventRow(e, false)).join('') + `<p><a href="#events" data-evnode="${esc(n.id)}">All events for this Pi →</a></p>`;
  },
};

// ------------------------------------------------------------------ history charts

let histRange = '24h', histTimer = null;
const RANGE_LABELS = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', '1y': '1 year' };
const CHARTS = [
  { title: 'CPU', unit: '%', max: 100, series: [['cpu', '#34d399', 'average'], ['cpu_max', '#34d39955', 'peak']] },
  { title: 'Memory used', unit: '%', max: 100, series: [['mem', '#60a5fa', 'average'], ['mem_max', '#60a5fa55', 'peak']] },
  { title: 'Temperature', unit: '°C', series: [['temp', '#fbbf24', 'average'], ['temp_max', '#fbbf2455', 'peak']] },
  { title: 'Load (1 min)', unit: '', series: [['load1', '#c084fc', 'load']] },
  { title: 'Root disk used', unit: '%', max: 100, series: [['disk', '#f472b6', 'used']] },
  { title: 'Network', unit: 'B/s', bytes: true, series: [['rx', '#34d399', 'down'], ['tx', '#60a5fa', 'up']] },
  { title: 'Disk writes (SD wear)', unit: 'B/s', bytes: true, series: [['wr', '#fb923c', 'written']] },
  { title: 'Link latency to hub', unit: 'ms', series: [['rtt', '#a3e635', 'round trip']] },
];

async function loadHistory() {
  clearTimeout(histTimer);
  const body = $('#tabBody');
  if (!body.querySelector('.histHead')) {
    body.innerHTML = `<div class="histHead"><div class="seg">${Object.keys(RANGE_LABELS).map(r =>
      `<button data-range="${r}" class="${r === histRange ? 'on' : ''}">${r}</button>`).join('')}</div>
      <span class="muted" id="histRes"></span></div>
      <div class="charts">${CHARTS.map((c, i) => `<div class="box chartBox"><h3>${c.title}</h3><canvas class="chart" data-i="${i}"></canvas></div>`).join('')}</div>`;
  }
  let h;
  try { h = await api(`/api/node/${encodeURIComponent(openId)}/history?range=${histRange}`); } catch { return; }
  if (tab !== 'history') return;
  const col = Object.fromEntries(h.cols.map((c, i) => [c, i]));
  $('#histRes').textContent = h.points.length
    ? `${h.points.length} points · ${h.resolution === 'hourly' ? 'hourly averages' : h.resolution === 'raw' ? 'full detail'
      : 'averaged per ' + (parseInt(h.resolution) < 90 ? h.resolution : dur(parseInt(h.resolution)))}`
    : 'No history in this range yet.';
  const secs = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000, '1y': 31536000 }[histRange];
  const now = Date.now() / 1000;
  $$('canvas.chart').forEach(cv => drawChart(cv, CHARTS[cv.dataset.i], h.points, col, now - secs, now));
  histTimer = setTimeout(() => tab === 'history' && openId && loadHistory(), 30000);
}

function fmtVal(c, v) {
  if (v == null) return '–';
  return c.bytes ? bytes(v) + '/s' : `${v.toFixed(c.unit === '' ? 2 : 1)}${c.unit === '%' ? '%' : c.unit ? ' ' + c.unit : ''}`;
}

// Round an axis top up so its four gridlines land on readable steps (…, 2, 2.5, 5, 10, …).
function niceMax(v, binary) {
  const base = binary ? 1024 ** Math.floor(Math.log(v / 4) / Math.log(1024)) : 1;
  const raw = v / 4 / (base || 1), p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  return step * 4 * (base || 1);
}

function drawChart(cv, c, pts, col, t0, t1) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const L = c.bytes ? 58 : 40, R = 8, T = 8, B = 20, w = W - L - R, h = H - T - B;
  let max = c.max ?? 0;
  if (!c.max) for (const p of pts) for (const [k] of c.series) if (p[col[k]] != null) max = Math.max(max, p[col[k]]);
  if (!c.max) max = niceMax(max || 1, c.bytes);
  const X = t => L + (t - t0) / (t1 - t0) * w, Y = v => T + h - Math.min(1, v / max) * h;
  g.font = '11px system-ui, sans-serif'; g.fillStyle = '#8b95a3'; g.strokeStyle = '#2a313b'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, y = Math.round(Y(v)) + .5;
    g.beginPath(); g.moveTo(L, y); g.lineTo(L + w, y); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(c.bytes ? bytes(v) : Math.round(v * 10) / 10 + (c.unit === '%' ? '%' : ''), L - 6, y);
  }
  const long = t1 - t0 > 2 * 86400;
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (t1 - t0) * i / 4, d = new Date(t * 1000);
    const label = long ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    g.fillText(label, Math.min(Math.max(X(t), L + 20), L + w - 20), T + h + 5);
  }
  // Break the line wherever samples are missing (Pi or hub was down).
  const gap = pts.length > 1 ? Math.max(3 * (pts.at(-1)[0] - pts[0][0]) / pts.length, 60) : 60;
  for (const [k, color] of c.series) {
    g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
    let prev = null;
    for (const p of pts) {
      const v = p[col[k]]; if (v == null) { prev = null; continue; }
      const x = X(p[0]), y = Y(v);
      prev != null && p[0] - prev < gap ? g.lineTo(x, y) : g.moveTo(x, y);
      prev = p[0];
    }
    g.stroke();
  }
  cv._chart = { c, pts, col, X, L, w, t0, t1 };
}

document.addEventListener('mousemove', e => {
  const cv = e.target.closest?.('canvas.chart'), tip = $('#tip');
  if (!cv || !cv._chart || !cv._chart.pts.length) return tip.hidden = true;
  const { c, pts, col, L, w, t0, t1 } = cv._chart, r = cv.getBoundingClientRect();
  const t = t0 + (e.clientX - r.left - L) / w * (t1 - t0);
  let best = pts[0];
  for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  tip.innerHTML = `<b>${when(best[0])}</b>` + c.series.map(([k, color, lbl]) =>
    `<div><i style="background:${color}"></i>${lbl}: ${fmtVal(c, best[col[k]])}</div>`).join('');
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
});

// ------------------------------------------------------------------ actions

async function act(body) {
  try { await api(`/api/node/${encodeURIComponent(openId)}/action`, { method: 'POST', body: JSON.stringify(body) }); }
  catch (e) { alert('Could not queue that: ' + e.message); }
  poll();
}

let limitUnit = null;
function openLimit(unit) {
  const s = detail.services.find(x => x.unit === unit) || {};
  const cores = detail.info.cores || 1;
  limitUnit = unit;
  $('#lUnit').textContent = unit;
  const r = $('#lCpu'); r.max = cores * 100; r.value = s.cpu_quota || 0;
  $('#lMem').value = s.mem_max ? Math.round(s.mem_max / 1048576) : '';
  $('#lWeight').value = s.cpu_weight && s.cpu_weight !== 100 ? String(s.cpu_weight) : '';
  cpuOut();
  $('#limitDlg').showModal();
}
function cpuOut() {
  const v = +$('#lCpu').value;
  $('#lCpuOut').textContent = v ? `${v}% (${v / 100} core${v === 100 ? '' : 's'})` : 'no cap';
}
$('#lCpu').addEventListener('input', cpuOut);
$('#lCancel').onclick = () => $('#limitDlg').close();
$('#limitDlg').addEventListener('click', e => {
  const p = e.target.dataset.preset; if (!p) return;
  const cores = detail.info.cores || 1, ramMb = Math.round((detail.metrics?.mem.total || 0) / 1048576);
  if (p === 'gentle') { $('#lCpu').value = Math.max(25, cores * 50); $('#lWeight').value = '50'; }
  if (p === 'half') { $('#lCpu').value = cores * 50; $('#lMem').value = Math.round(ramMb / 2 / 16) * 16; }
  if (p === 'clear') { $('#lCpu').value = 0; $('#lMem').value = ''; $('#lWeight').value = ''; }
  cpuOut();
});
$('#lApply').onclick = () => {
  const cpu = +$('#lCpu').value, mem = $('#lMem').value.trim(), w = $('#lWeight').value;
  $('#limitDlg').close();
  act({ type: 'limit', unit: limitUnit, cpu_quota: cpu ? Math.max(5, cpu) : null, mem_max_mb: mem ? +mem : null, cpu_weight: w ? +w : null });
};

// ------------------------------------------------------------------ Events page

let evOldest = null, evTimer = null;
async function loadEvents(more = false) {
  clearTimeout(evTimer);
  const p = new URLSearchParams({ node: $('#evNode').value, level: $('#evLevel').value, q: $('#evQ').value.trim(), limit: 100 });
  if (more && evOldest) p.set('before', evOldest);
  let rows;
  try { rows = (await api('/api/events?' + p)).events; } catch { return; }
  const html = rows.map(e => eventRow(e, true)).join('');
  if (more) $('#evList').insertAdjacentHTML('beforeend', html);
  else $('#evList').innerHTML = html || '<p class="muted">No events match.</p>';
  if (rows.length) evOldest = rows.at(-1).id; else if (!more) evOldest = null;
  $('#evMore').hidden = rows.length < 100;
  if (!more) evTimer = setTimeout(() => view === 'events' && signedIn && !$('#evList').matches(':hover') && loadEvents(), 15000);
}
['#evNode', '#evLevel'].forEach(s => $(s).addEventListener('change', () => loadEvents()));
let evDebounce;
$('#evQ').addEventListener('input', () => { clearTimeout(evDebounce); evDebounce = setTimeout(() => loadEvents(), 300); });
$('#evMore').onclick = () => loadEvents(true);

// ------------------------------------------------------------------ Settings page

const SETTING_GROUPS = [
  ['Reporting', [['interval', 'Report every', 's', 'How often each client sends a report.'],
                 ['offline_after', 'Offline after', 's', 'No report for this long raises an "offline" alert.']]],
  ['Alerts', [['sustain', 'Problem must last', 's', 'Before an alert is raised; stops short spikes from alerting. Offline, under-voltage and throttling alert at once.'],
              ['temp_warn', 'Temperature warning', '°C'], ['temp_crit', 'Temperature critical', '°C'],
              ['mem_warn', 'Memory warning', '% used'], ['mem_crit', 'Memory critical', '% used'],
              ['disk_warn', 'Disk warning', '% full'], ['disk_crit', 'Disk critical', '% full'],
              ['swap_warn', 'Swap warning', '% used'], ['load_warn', 'Load warning', '× cores', '5-minute load average per CPU core.'],
              ['write_warn', 'Disk-write warning', 'MB/min', 'Heavy writing wears out SD cards. 0 turns this off.']]],
  ['History', [['raw_days', 'Keep full detail for', 'days', 'Every report, every few seconds.'],
               ['hourly_days', 'Keep hourly averages for', 'days'],
               ['event_days', 'Keep events for', 'days']]],
  ['NAS storage', [['nas_data_dir', 'Logs folder', '', 'Hourly database mirror, plus the archive of everything past the history limits above.', 'path'],
                   ['mirror_hours', 'Mirror every', 'hours', '0 turns the mirror off.'],
                   ['archive', 'Archive old data to the NAS', '', 'Instead of deleting it when it passes the history limits.', 'bool'],
                   ['nas_backup_dir', 'Backup folder', '', 'Nightly backup: database + hub certificate and key.', 'path'],
                   ['backup_hour', 'Back up at', "o'clock", '0–23, local time.'],
                   ['backup_keep', 'Keep', 'backups']]],
  ['Updates', [['update_check', 'Check GitHub for new releases daily', '', 'Nothing is installed until you click Update on the About page.', 'bool']]],
];

async function loadSettings() {
  try { settingsData = await api('/api/settings'); } catch { return; }
  const d = settingsData, s = d.settings;
  $('#settingsBody').innerHTML = SETTING_GROUPS.map(([title, fields]) => `<div class="box ${title === 'NAS storage' ? 'wideBox' : ''}"><h3>${title}</h3>${fields.map(([k, label, unit, help, type]) => {
    const helpHtml = help ? `<small class="muted">${help}</small>` : '';
    if (type === 'path') return `<label class="field pathField"><span>${label}</span>
      <input type="text" name="${k}" value="${esc(s[k])}" placeholder="off" spellcheck="false">${helpHtml}</label>`;
    if (type === 'bool') return `<label class="field"><span>${label}</span><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}>${helpHtml}</label>`;
    const [lo, hi] = d.limits[k];
    return `<label class="field"><span>${label}</span><span class="inp"><input type="number" name="${k}" value="${s[k]}" min="${lo}" max="${hi}" step="${Number.isInteger(lo) ? 1 : 0.1}" required><em>${unit}</em></span>
      ${helpHtml}</label>`;
  }).join('')}${title === 'History' ? `<p class="muted small">Database: ${bytes(d.db.bytes)} · ${d.db.samples.toLocaleString()} detailed samples · ${d.db.hourly.toLocaleString()} hourly rows · ${d.db.events.toLocaleString()} events</p>` : ''}</div>`).join('');
  $('#secBox').innerHTML = `<h3>Encrypted client link</h3>
    <p>Clients send reports over HTTPS on port <b>${d.link_port}</b>. The hub uses its own certificate, and every client checks it against this fingerprint before sending anything:</p>
    <pre class="fp">${esc(d.fingerprint)}</pre>
    <p class="muted small">If you move the hub to a new Pi, copy <code>${esc(d.data)}</code> across (including <code>hub-cert.pem</code> and <code>hub-key.pem</code>) so your clients keep trusting it.</p>
    <h3 style="margin-top:14px">Add a Pi</h3><pre class="cmd">${esc(d.install)}</pre>`;
  $('#setMsg').textContent = '';
  renderGuards();
  loadNas();
}

$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const s = settingsData.settings, changes = {};
  for (const inp of $$('#settingsBody input')) {
    const v = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.type === 'text' ? inp.value.trim() : +inp.value;
    if (v !== s[inp.name]) changes[inp.name] = v;
  }
  if (!Object.keys(changes).length) return $('#setMsg').textContent = 'Nothing changed.';
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(changes) });
    await loadSettings();
    $('#setMsg').textContent = 'Saved.';
    setTimeout(() => $('#setMsg').textContent === 'Saved.' && ($('#setMsg').textContent = ''), 4000);
  } catch (err) { $('#setMsg').textContent = err.message; }
});

$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('#pwNew').value !== $('#pwNew2').value) return $('#pwMsg').textContent = 'The new passwords don\'t match.';
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ current: $('#pwCur').value, new: $('#pwNew').value }) });
    e.target.reset();
    $('#pwMsg').textContent = 'Password changed.';
  } catch (err) { $('#pwMsg').textContent = err.message; }
});

// ------------------------------------------------------------------ health, OS updates, watchdog

function healthBox(n, m) {
  const a = n.apt, io = m.disk_io || {};
  const job = a?.job === 'running' ? '<span class="tag warnTag">installing updates…</span>'
    : a?.job === 'failed' ? '<span class="tag critTag">last upgrade failed; see the Pi\'s log</span>' : '';
  const apt = !a ? '<span class="muted">not reported (older client)</span>'
    : a.upgradable == null ? '<span class="muted">checking…</span>'
    : a.upgradable === 0 ? '<span style="color:var(--accent)">up to date</span>'
    : `<b>${a.upgradable}</b> waiting${a.security ? `, <b style="color:var(--warn)">${a.security} security</b>` : ''}`;
  return `<div class="box"><h3>Health &amp; updates</h3><div class="kv">
      <span>Disk writes</span><span>${bytes(io.write)}/s now · ${bytes(io.written_boot)} since boot</span>
      <span>Root filesystem</span><span>${m.root_ro ? '<b style="color:var(--crit)">read-only</b>' : 'read-write'}</span>
      <span>Link to hub</span><span>${m.rtt == null ? '–' : m.rtt + ' ms round trip'} · encrypted</span>
      <span>OS updates</span><span>${apt} ${job}</span>
      ${a?.checked ? `<span>Checked</span><span>${when(a.checked)}</span>` : ''}
      ${a?.reboot_required ? '<span>Reboot</span><span style="color:var(--warn)">needed to finish updates</span>' : ''}</div>
    <div class="row wrap" style="margin-top:12px">
      <button class="btn small ghost" data-apt="check">Check for updates</button>
      <button class="btn small ${a?.upgradable ? '' : 'ghost'}" data-apt="upgrade" ${a?.job === 'running' ? 'disabled' : ''}>Install OS updates</button>
      <span class="spacer"></span>
      <button class="btn small ghost" data-power="reboot">Reboot</button>
      <button class="btn small ghost danger" data-power="shutdown">Shut down</button></div></div>`;
}

function watchPanel(n) {
  const watch = n.prefs?.watch || {}, st = n.watch_status || {}, units = Object.keys(watch).sort();
  const rows = units.map(u => {
    const s = st[u] || 'waiting for report', ok = ['active', 'reloading', 'activating'].includes(s);
    return `<tr><td class="mono">${esc(u)}</td><td><span class="tag ${ok ? '' : 'critTag'}">${esc(s)}</span></td>
      <td><button class="btn small ${watch[u].restart ? '' : 'ghost'}" data-autorestart="${esc(u)}">${watch[u].restart ? 'Auto-restart on' : 'Auto-restart off'}</button></td>
      <td class="acts"><button class="btn small ghost" data-unwatch="${esc(u)}">Stop watching</button></td></tr>`;
  }).join('');
  return `<div class="box watchBox"><h3>Watched services</h3>
    <p class="muted small">You get an alert if one of these stops. With auto-restart on, the hub restarts it: at most once every 2 minutes and 3 times an hour, then it gives up and tells you.</p>
    ${units.length ? `<table><tbody>${rows}</tbody></table>` : ''}
    <div class="row" style="margin-top:8px"><input id="addWatch" placeholder="service name, e.g. medialedger" spellcheck="false">
      <button class="btn small" data-addwatch>Watch</button></div></div>`;
}

async function setWatch(unit, watch, restart) {
  try {
    const r = await api(`/api/node/${encodeURIComponent(openId)}/watch`, { method: 'POST', body: JSON.stringify({ unit, watch, restart }) });
    detail.prefs = r.prefs;
    renderDetail(true);
  } catch (e) { alert(e.message); }
}

// ------------------------------------------------------------------ NAS storage & backups (Settings)

let nasTimer = null;
async function loadNas() {
  clearTimeout(nasTimer);
  let d;
  try { d = await api('/api/nas'); } catch { return; }
  const job = (k, label) => {
    const j = d.status[k];
    if (!j) return `<span>${label}</span><span class="muted">not run yet</span>`;
    return `<span>${label}</span><span><b style="color:var(--${j.ok ? 'accent' : 'crit'})">${j.ok ? '✓' : '✕'}</b> ${esc(j.msg)} <span class="muted">· ${when(j.at)}</span></span>`;
  };
  const dir = (k, label) => {
    const x = d.dirs[k];
    return `<span>${label}</span><span>${x.path ? `<span class="mono">${esc(x.path)}</span> ` : ''}${x.ok ? '<b style="color:var(--accent)">reachable</b>' : `<b style="color:var(--${x.path ? 'crit' : 'muted'})">${esc(x.msg)}</b>`}</span>`;
  };
  $('#nasBox').innerHTML = `<h3>NAS status</h3><div class="kv">
      ${dir('nas_data_dir', 'Logs folder')}${dir('nas_backup_dir', 'Backup folder')}
      ${job('mirror', 'Last mirror')}${job('archive', 'Last archive')}${job('backup', 'Last backup')}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn small ghost" data-nas="mirror" ${d.running ? 'disabled' : ''}>Mirror now</button>
      <button class="btn small" data-nas="backup" ${d.running ? 'disabled' : ''}>Back up now</button>
      ${d.running ? `<span class="muted">${esc(d.running)} running…</span>` : ''}</div>
    ${d.backups.length ? `<details style="margin-top:12px"><summary>${d.backups.length} backups on the NAS</summary>
      <table>${d.backups.map(b => `<tr><td class="mono">${esc(b.name)}</td><td class="num">${bytes(b.size)}</td></tr>`).join('')}</table>
      <p class="muted small">To restore one, run on the hub Pi: <code>sudo pipulse-hub restore "&lt;backup folder&gt;/&lt;file&gt;"</code></p></details>` : ''}
    <p class="muted small">On the hub Pi, <code>sudo pipulse-hub nas</code> connects (or reconnects) the NAS share and stores its login.</p>`;
  if (d.running && view === 'settings') nasTimer = setTimeout(loadNas, 3000);
}
$('#nasBox').addEventListener('click', async e => {
  const job = e.target.dataset.nas; if (!job) return;
  try { await api('/api/nas/' + job, { method: 'POST' }); } catch (err) { alert(err.message); }
  loadNas();
});

// ------------------------------------------------------------------ guard rules (Settings)

function renderGuards() {
  const rules = settingsData.settings.guards || [], nodes = [...state.nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  const nodeSel = v => `<select data-g="node"><option value="">All Pis</option>${nodes.map(n => `<option value="${esc(n.id)}" ${n.id === v ? 'selected' : ''}>${esc(nodeName(n))}</option>`).join('')}</select>`;
  const row = r => `<tr data-id="${esc(r.id || '')}">
      <td><input type="checkbox" data-g="on" ${r.on !== false ? 'checked' : ''} title="Rule on"></td>
      <td><input data-g="name" value="${esc(r.name || '')}" placeholder="name" size="12"></td>
      <td><input data-g="match" value="${esc(r.match || '*')}" size="14" spellcheck="false" title="Service name; * and ? wildcards"></td>
      <td>${nodeSel(r.node)}</td>
      <td><select data-g="metric"><option value="cpu" ${r.metric !== 'mem' ? 'selected' : ''}>CPU above</option><option value="mem" ${r.metric === 'mem' ? 'selected' : ''}>RAM above</option></select></td>
      <td><input type="number" data-g="above" value="${r.above ?? 150}" style="width:70px"></td>
      <td><input type="number" data-g="minutes" value="${r.minutes ?? 5}" style="width:56px" step="0.5"></td>
      <td><input type="number" data-g="cap" value="${r.cap ?? 100}" style="width:70px"></td>
      <td><button type="button" class="btn small ghost danger" data-gdel>✕</button></td></tr>`;
  $('#guardBox').innerHTML = `<h3>Guard rules</h3>
    <p class="muted small">Automatic protection: when a service stays over a limit, cap it and log an event. CPU is % of one core (150 = 1.5 cores), RAM is MB.
      A rule fires once per service; it won't touch a service that already has that kind of cap, or ${settingsData.protected.join(', ')}.</p>
    <table class="guards"><thead><tr><th>On</th><th>Name</th><th>Service</th><th>Pi</th><th>When</th><th class="num">Over</th><th class="num">For min</th><th class="num">Cap at</th><th></th></tr></thead>
      <tbody>${rules.map(row).join('')}</tbody></table>
    <div class="row" style="margin-top:10px"><button type="button" class="btn small ghost" data-gadd>+ Add rule</button>
      <span class="spacer"></span><span id="gMsg" class="muted"></span><button type="button" class="btn small" data-gsave>Save rules</button></div>`;
  $('#guardBox').onclick = async e => {
    if (e.target.dataset.gadd !== undefined) {
      $('#guardBox tbody').insertAdjacentHTML('beforeend', row({ name: 'CPU hog', match: '*', metric: 'cpu', above: 150, minutes: 5, cap: 100 }));
    }
    if (e.target.dataset.gdel !== undefined) e.target.closest('tr').remove();
    if (e.target.dataset.gsave !== undefined) {
      const guards = $$('#guardBox tbody tr').map(tr => {
        const g = k => tr.querySelector(`[data-g="${k}"]`);
        return { id: tr.dataset.id, on: g('on').checked, name: g('name').value, match: g('match').value, node: g('node').value,
                 metric: g('metric').value, above: +g('above').value, minutes: +g('minutes').value, cap: +g('cap').value };
      });
      try {
        const r = await api('/api/guards', { method: 'POST', body: JSON.stringify({ guards }) });
        settingsData.settings.guards = r.guards; renderGuards(); $('#gMsg').textContent = 'Saved.';
      } catch (err) { $('#gMsg').textContent = err.message; }
    }
  };
}

// ------------------------------------------------------------------ About

let aboutTimer = null;
async function loadAbout() {
  clearTimeout(aboutTimer);
  let d;
  try { d = await api('/api/about'); } catch { return; }
  const u = d.update, l = u.latest || {};
  let action;
  if (u.in_progress) action = '<p><b>Updating the hub…</b> The dashboard reconnects by itself when it\'s done.</p>';
  else if (u.available && u.managed) action = `<button class="btn" data-hubupdate>Update hub to ${esc(u.available)}</button>`;
  else if (u.available) action = `<p class="muted">This hub wasn't installed with the Pi installer, so update it by hand: ${esc(u.available)} is on <a href="${esc(l.url)}" target="_blank" rel="noopener">GitHub</a>.</p>`;
  else action = '<p style="color:var(--accent)">This hub is up to date.</p>';
  const outdated = state.nodes.filter(n => n.online && n.outdated).length;
  $('#updBox').innerHTML = `<h3>Updates</h3><div class="kv">
      <span>Installed</span><span>PiPulse ${esc(d.version)}</span>
      <span>Latest release</span><span>${l.version ? esc(l.version) + (l.published ? ` <span class="muted">(${esc(l.published.slice(0, 10))})</span>` : '') : '<span class="muted">not checked yet</span>'}</span>
      <span>Last checked</span><span>${l.checked ? when(l.checked) : '–'}${l.error ? ` <span style="color:var(--warn)">(${esc(l.error)})</span>` : ''}</span></div>
    <div style="margin:14px 0 6px">${action}</div>
    <div class="row wrap"><button class="btn small ghost" data-checkupd ${u.checking ? 'disabled' : ''}>${u.checking ? 'Checking…' : 'Check now'}</button>
      ${outdated ? `<button class="btn small" data-updateall>Update all Pis (${outdated})</button>` : '<span class="muted small">All Pis run this hub\'s client version.</span>'}</div>
    <p class="muted small">Hub updates come from GitHub releases (${esc(d.repo)}) and are checked against the release's SHA256SUMS. Pis update from this hub, over the encrypted link.</p>
    ${u.available && l.notes ? `<details open><summary>What's in ${esc(u.available)}</summary><div class="md">${md(l.notes)}</div></details>` : ''}`;
  $('#hubBox').innerHTML = `<h3>This hub</h3><div class="kv">
      <span>Running on</span><span>${esc(d.hostname)}</span><span>System</span><span>${esc(d.os)}</span>
      <span>Python</span><span>${esc(d.python)}</span><span>Up for</span><span>${dur(Date.now() / 1000 - d.started)}</span>
      <span>Data</span><span class="mono">${esc(d.data)}</span>
      <span>Database</span><span>${bytes(d.db.bytes)} · ${d.db.samples.toLocaleString()} samples · ${d.db.events.toLocaleString()} events</span>
      <span>Source</span><span><a href="https://github.com/${esc(d.repo)}" target="_blank" rel="noopener">github.com/${esc(d.repo)}</a></span>
      <span>License</span><span>MIT</span></div>
    <p class="muted small" style="margin-top:12px">Standard-library Python on both ends: no pip packages, no Docker, no cloud. Made by AxialForge.</p>`;
  $('#changelog').innerHTML = md(d.changelog.replace(/^# Changelog[\s\S]*?(?=^## )/m, ''));
  if (u.in_progress || u.checking) aboutTimer = setTimeout(() => view === 'about' && loadAbout(), 3000);
}
$('#view-about').addEventListener('click', async e => {
  if (e.target.dataset.checkupd !== undefined) { await api('/api/update/check', { method: 'POST' }).catch(() => {}); setTimeout(loadAbout, 400); }
  if (e.target.dataset.hubupdate !== undefined) {
    if (!confirm('Update the hub now? The dashboard goes away for a minute while it restarts.')) return;
    try { await api('/api/update/hub', { method: 'POST' }); } catch (err) { return alert(err.message); }
    loadAbout();
  }
});

// Just enough Markdown for release notes: headings, bullets, bold, code, links. Escapes first.
function md(text) {
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let html = '', list = false, para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd(), h = line.match(/^(#{2,4})\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { flush(); if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list && /^\s{2,}\S/.test(line)) { html = html.replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); continue; }
    if (list) { html += '</ul>'; list = false; }
    if (h) { flush(); html += `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`; }
    else if (!line.trim()) flush();
    else if (!line.startsWith('```')) para.push(line);
  }
  flush(); if (list) html += '</ul>';
  return html;
}

// ------------------------------------------------------------------ wiring

$('#grid').addEventListener('click', e => {
  const c = e.target.closest('.card'); if (!c) return;
  openId = c.dataset.id; tab = 'overview';
  $$('#nodeTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#tabBody').innerHTML = '<p class="muted">Loading…</p>';
  $('#nodeDlg').showModal();
  loadDetail();
});
$('#nodeDlg').addEventListener('close', () => { openId = null; detail = null; clearTimeout(histTimer); $('#tip').hidden = true; });
$('#nodeTabs').addEventListener('click', e => {
  if (!e.target.dataset.tab) return;
  tab = e.target.dataset.tab;
  $$('#nodeTabs button').forEach(b => b.classList.toggle('on', b === e.target));
  $('#tabBody').innerHTML = '';
  $('#tabBody').scrollTop = 0;
  if (detail) renderDetail(true);
});
$('#tabBody').addEventListener('click', e => {
  const b = e.target.closest('button, a'); if (!b) return;
  if (b.dataset.range) { histRange = b.dataset.range; $$('.seg button').forEach(x => x.classList.toggle('on', x === b)); return loadHistory(); }
  if (b.dataset.evnode) { $('#nodeDlg').close(); $('#evNode').value = b.dataset.evnode; return; }
  if (b.dataset.limit) openLimit(b.dataset.limit);
  if (b.dataset.watch) setWatch(b.dataset.watch, !(detail.prefs?.watch || {})[b.dataset.watch], false);
  if (b.dataset.unwatch) setWatch(b.dataset.unwatch, false, false);
  if (b.dataset.autorestart) setWatch(b.dataset.autorestart, true, !(detail.prefs.watch[b.dataset.autorestart] || {}).restart);
  if (b.dataset.addwatch !== undefined) {
    let u = $('#addWatch').value.trim();
    if (u && !u.includes('.')) u += '.service';
    if (u) setWatch(u, true, false);
  }
  if (b.dataset.power) {
    const what = b.dataset.power === 'reboot' ? 'Reboot' : 'Shut down';
    const extra = b.dataset.power === 'shutdown' ? '\n\nIt stays off until someone powers it back on.' : '';
    if (confirm(`${what} ${nodeName(detail)}?${extra}`)) act({ type: b.dataset.power });
  }
  if (b.dataset.apt === 'upgrade' && confirm(`Install OS updates on ${nodeName(detail)}? It runs apt upgrade in the background, which can take a while.`)) act({ type: 'apt_upgrade' });
  if (b.dataset.apt === 'check') act({ type: 'apt_check' });
  if (b.dataset.update !== undefined && confirm(`Update the client on ${nodeName(detail)} to ${detail.hub_version}? It restarts itself.`)) act({ type: 'update' });
  if (b.dataset.restart && confirm(`Restart ${b.dataset.restart} on ${detail.hostname}?`)) act({ type: 'restart', unit: b.dataset.restart });
  if (b.dataset.renice) {
    const v = prompt(`New nice value for ${b.dataset.name} (pid ${b.dataset.renice}).\n10 = lower priority, 19 = lowest, 0 = normal, negative = higher.`, '10');
    if (v !== null && v.trim() !== '') act({ type: 'renice', pid: +b.dataset.renice, nice: +v, name: b.dataset.name });
  }
});
$('#renameBtn').onclick = async () => {
  const v = prompt('Label for this Pi (blank = use hostname)', detail.label || '');
  if (v === null) return;
  await api(`/api/node/${encodeURIComponent(openId)}/label`, { method: 'POST', body: JSON.stringify({ label: v.trim() }) });
  poll();
};
$('#forgetBtn').onclick = async () => {
  if (!confirm(`Forget ${nodeName(detail)} and delete its history? If its client is still running, it will show up again as new.`)) return;
  await api('/api/node/' + encodeURIComponent(openId), { method: 'DELETE' });
  $('#nodeDlg').close(); poll();
};
$('#addBtn').onclick = async () => {
  if (!settingsData) await loadSettings();
  $$('.ports').forEach(s => s.textContent = `${settingsData.web_port} (install) and ${settingsData.link_port} (reports)`);
  $('#addCmd').textContent = state.install;
  sshCmds();
  $('#addDlg').showModal();
};
$('.addTabs').addEventListener('click', e => {
  const t = e.target.dataset.addtab; if (!t) return;
  $$('.addTabs button').forEach(b => b.classList.toggle('on', b === e.target));
  $$('[data-addpane]').forEach(p => p.hidden = p.dataset.addpane !== t);
});
// One ssh line per Pi. -t gives sudo a terminal to ask for the password on. The
// install command sits inside double quotes and keeps its own single quotes, which
// works the same in PowerShell, cmd and bash.
function sshCmds() {
  const user = $('#sshUser').value.trim() || 'pi';
  const hosts = $('#sshHosts').value.split(/[\s,]+/).filter(Boolean);
  const line = h => `ssh -t ${user}@${h} "${state.install}"`;
  $('#sshCmd').textContent = (hosts.length ? hosts : ['<pi-address>']).map(line).join('\n');
}
['#sshUser', '#sshHosts'].forEach(s => $(s).addEventListener('input', sshCmds));
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy], [data-updateall]'); if (!b) return;
  if (b.dataset.copy !== undefined) {
    navigator.clipboard?.writeText($('#' + b.dataset.copy)?.textContent || state.install);
    const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => b.textContent = old, 1500);
  }
  if (b.dataset.updateall !== undefined) {
    try {
      const r = await api('/api/update/clients', { method: 'POST' });
      b.textContent = r.queued.length ? `Updating ${r.queued.length}…` : 'Nothing to update';
    } catch (err) { alert(err.message); }
    poll();
  }
});
addEventListener('resize', () => { renderGrid(); if (tab === 'history' && openId) loadHistory(); });

route();
fetch('/api/auth').then(r => r.json()).then(s => {
  if (s.authed) { signedIn = true; route(); } else showLogin();
});
setInterval(() => view === 'pis' && poll(), 3000);
