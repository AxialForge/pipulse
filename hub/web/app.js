'use strict';
/* PiPulse's pages on the Bracket kit. UI (kit/renderer/ui.js) gives the helpers, the router and the
   shared Security and About pages; Cards the charts; Glossary the definitions (terms.js). One
   function per page in UI.views. Everything talks to the hub through window.api (bridge-shape.js). */
const { $, $$, esc, tile, makeTable, toast, openModal, closeModal, fmtTime, fmtAgo, fmtUptime, fmtBytes, sparkline, meter, isAdmin, views, pages, sections, setPill } = UI;
const api = window.api;
const T = (key, text) => UI.term(key, text);
const REFRESH_MS = 5000;

// ---------- small helpers -------------------------------------------------------------------------
const nodeName = n => n.label || n.hostname || n.id;
const memPct = m => m && m.mem && m.mem.total ? 100 * (1 - m.mem.avail / m.mem.total) : null;
const rootDisk = m => ((m && m.disks) || []).find(d => d.mount === '/') || ((m && m.disks) || [])[0];
const pct = v => v == null ? '—' : `${Math.round(v)}%`;
const level = (v, warn, bad) => v == null ? '' : v >= bad ? 'badt' : v >= warn ? 'warnt' : '';
const rate = b => b == null ? '—' : `${fmtBytes(b)}/s`;

/** A Pi's overall state from the hub's alerts: { cls, word, dot, reasons }. */
function healthOf(n) {
  if (!n.online) return { cls: 'badt', word: 'Offline', dot: 'bad', reasons: n.seen ? `last report ${fmtAgo(n.seen * 1000)}` : 'never reported' };
  const crit = n.alerts.filter(a => a[0] === 'crit'), warn = n.alerts.filter(a => a[0] !== 'crit');
  const reasons = n.alerts.map(a => a[1]).join(' · ');
  if (crit.length) return { cls: 'badt', word: 'Problem', dot: 'bad', reasons };
  if (warn.length) return { cls: 'warnt', word: 'Attention', dot: 'warn', reasons };
  return { cls: 'okt', word: 'All good', dot: 'ok', reasons: 'no alerts' };
}
const THROTTLE = [[0, 'under-voltage now'], [1, 'frequency capped now'], [2, 'throttled now'], [3, 'soft temperature limit now'],
  [16, 'under-voltage since boot'], [17, 'frequency capped since boot'], [18, 'throttled since boot'], [19, 'soft temp limit since boot']];
const throttleText = th => th == null ? 'not reported' : th === 0 ? 'no throttling since boot' : THROTTLE.filter(([b]) => th & (1 << b)).map(([, t]) => t).join(' · ');

// ---------- Pis: a row of tiles per Pi -------------------------------------------------------------
let fleet = { nodes: [] };

function piTiles(n) {
  const m = n.metrics || {}, h = healthOf(n), mp = memPct(m), d = rootDisk(m), off = !n.online;
  return `<div class="tiles pitiles ${off ? 'off' : ''}">
    ${tile(h.cls, T('health', 'Health'), `<span class="health-${h.dot === 'ok' ? 'ok' : h.dot}">${h.word}</span>`, esc(h.reasons))}
    ${tile(level(m.cpu, 70, 90), T('cpu', 'CPU'), pct(m.cpu), m.load ? `${T('load', 'load')} ${m.load.map(x => x.toFixed(2)).join(' / ')}` : '')}
    ${tile(level(mp, 80, 90), T('memory', 'Memory'), pct(mp), m.mem ? `${fmtBytes(m.mem.total - m.mem.avail)} of ${fmtBytes(m.mem.total)}` : '')}
    ${tile(level(m.temp, 70, 80), T('soc-temp', 'Temperature'), m.temp == null ? '—' : `${m.temp.toFixed(1)} °C`, T('throttling', throttleText(m.throttled)))}
    ${tile(d ? level(100 * d.used / d.total, 85, 95) : '', T('disk', 'Disk'), d ? pct(100 * d.used / d.total) : '—', d ? `${fmtBytes(d.total - d.used)} free` : '')}
    ${tile('', T('link-latency', 'Link'), m.rtt == null ? '—' : `${m.rtt} ms`, m.net ? `↓ ${rate(m.net.rx)} · ↑ ${rate(m.net.tx)}` : '')}
  </div>`;
}

function piRow(n) {
  const h = healthOf(n), m = n.metrics;
  const bits = [n.info && n.info.model, n.online && m ? `${T('uptime', 'up')} ${fmtUptime(m.uptime)}` : null,
    n.client_version ? `${T('client-version', 'client')} ${esc(n.client_version)}` : null].filter(Boolean);
  return `<section class="pirow" data-id="${esc(n.id)}">
    <div class="pihead"><span class="dot ${h.dot}"></span><a href="#pi/${encodeURIComponent(n.id)}"><b>${esc(nodeName(n))}</b></a>
      <span class="muted small">${bits.map(b => b.startsWith('<') ? b : esc(b)).join(' · ')}</span>
      ${n.outdated ? '<span class="badge warn">update</span>' : ''}${n.pending ? `<span class="badge">${n.pending} pending</span>` : ''}
      <span class="grow"></span><a class="small" href="#pi/${encodeURIComponent(n.id)}">details →</a></div>
    <a class="tilelink" href="#pi/${encodeURIComponent(n.id)}">${piTiles(n)}</a>
  </section>`;
}

function fleetPills(st) {
  const bad = st.nodes.filter(n => healthOf(n).dot === 'bad').length;
  setPill('piPill', bad, 'bad');
  setPill('updatePill', st.update_available ? 'update' : null, 'accent');
}

views.pis = async () => {
  const v = UI.view();
  const st = fleet = await api.fleet.state();
  fleetPills(st);
  const nodes = [...st.nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  const online = nodes.filter(n => n.online).length, bad = nodes.filter(n => healthOf(n).dot === 'bad').length;
  const outdated = nodes.filter(n => n.online && n.outdated);
  v.innerHTML = `<h1>Pis</h1>
    <div class="livebar"><span class="dot ${bad ? 'bad' : nodes.length ? 'ok' : ''}"></span>${online}/${nodes.length} online${bad ? ` · <b class="bad">${bad} need attention</b>` : ''} · ${T('hub', 'hub')} ${esc(st.version)} on ${esc(st.hostname)}<span class="grow"></span>refreshes every ${REFRESH_MS / 1000} s</div>
    ${st.update_available ? `<div class="warnbox">PiPulse ${esc(st.update_available)} is available. <a href="#about">Update on the About page →</a></div>` : ''}
    ${outdated.length && isAdmin() ? `<div class="warnbox inline">${outdated.length} Pi${outdated.length > 1 ? 's run' : ' runs'} an older ${T('client', 'client')} than this hub.<span class="grow"></span><button class="small primary" id="updAll">Update all Pis</button></div>` : ''}
    <div id="fleet">${nodes.length ? nodes.map(piRow).join('') : `<div class="card empty">No Pis yet. ${isAdmin() ? '<a href="#add">Add your first Pi →</a>' : 'An admin can add them.'}</div>`}</div>`;
  const b = $('#updAll'); if (b) b.onclick = updateAll;
};
async function updateAll() {
  try { const q = await api.hubUpdate.clients(); toast(q.length ? `Updating ${q.join(', ')}` : 'Nothing to update'); } catch (e) { toast(e.message, true); }
}

// ---------- one Pi: System-page layout with tabs -----------------------------------------------------
const TABS = [['overview', 'Overview'], ['history', 'History'], ['services', 'Services'], ['processes', 'Processes'], ['events', 'Events']];
let pi = null, piTab = 'overview', piRange = localStorage.getItem('pipulse.range') || '24h';

views.pi = async (arg) => {
  const [id, tab] = String(arg || '').split('/');
  if (!id) { location.hash = 'pis'; return; }
  piTab = TABS.some(t => t[0] === tab) ? tab : 'overview';
  $$('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.view === 'pis'));
  pi = await api.pi.get(id);
  const v = UI.view();
  v.innerHTML = `<div class="detail-head"><a class="back" href="#pis">← Pis</a><h1 id="piTitle"></h1><span class="grow"></span>
      ${isAdmin() ? '<button class="small" id="piRename">Rename</button><button class="small danger" id="piForget">Forget</button>' : ''}</div>
    <p class="muted" id="piSub"></p>
    <div id="piAlerts"></div>
    <div id="piTiles"></div>
    <div class="toolbar tabs pitabs">${TABS.map(([k, l]) => `<a href="#pi/${encodeURIComponent(id)}/${k}"><button class="small ${k === piTab ? 'primary' : ''}">${l}</button></a>`).join('')}</div>
    <div id="piBody"></div>`;
  renderPiHead();
  await renderPiBody();
  if ($('#piRename')) $('#piRename').onclick = async () => { const l = prompt('Name for this Pi (blank = its hostname)', pi.label || ''); if (l === null) return; try { await api.pi.label(pi.id, l.trim()); UI.route(); } catch (e) { toast(e.message, true); } };
  if ($('#piForget')) $('#piForget').onclick = async () => { if (!confirm(`Forget ${nodeName(pi)} and delete its history? If its client still runs, it comes back as a new Pi.`)) return; try { await api.pi.forget(pi.id); location.hash = 'pis'; } catch (e) { toast(e.message, true); } };
};

function renderPiHead() {
  const n = pi, m = n.metrics || {};
  $('#piTitle').textContent = nodeName(n);
  const sub = [n.label ? esc(n.hostname) : null, esc(n.info.model || ''), esc(n.info.os || ''), n.online ? `${T('uptime', 'up')} ${fmtUptime(m.uptime)}` : '<b class="bad">offline</b>',
    `${T('client-version', 'client')} ${esc(n.client_version || '?')}${n.outdated ? ' <span class="badge warn">update</span>' : ''}`, `last report ${fmtAgo(n.seen * 1000)}`].filter(Boolean);
  $('#piSub').innerHTML = sub.join(' · ');
  $('#piAlerts').innerHTML = n.alerts.length ? `<div class="checks" style="margin-bottom:10px">${n.alerts.map(a => `<div class="check ${a[0] === 'crit' ? 'bad' : 'warn'}"><div class="dot"></div><div><b>${esc(a[1])}</b><span>${a[0] === 'crit' ? 'critical' : 'warning'} · ${T('alert', 'what is an alert?')}</span></div></div>`).join('')}</div>` : '';
  const io = m.disk_io || {}, apt = n.apt;
  const aptVal = !apt ? '—' : apt.upgradable == null ? '…' : String(apt.upgradable);
  $('#piTiles').innerHTML = `${piTiles(n).replace('class="tiles pitiles', 'class="tiles pitiles wide')}
    <div class="tiles compact">
      ${tile(m.throttled ? (m.throttled & 0xF ? 'badt' : 'warnt') : 'okt', T('throttling', 'Power & throttling'), m.throttled ? (m.throttled & 0xF ? 'Throttled now' : 'Earlier') : m.throttled === 0 ? 'Healthy' : '—', esc(throttleText(m.throttled)))}
      ${tile(m.root_ro ? 'badt' : '', T('read-only', 'Filesystem'), m.root_ro ? 'Read-only' : 'Read-write', m.root_ro ? 'SD card trouble' : 'root disk accepts writes')}
      ${tile('', T('disk-writes', 'Disk writes'), rate(io.write), io.written_boot != null ? `${fmtBytes(io.written_boot)} since boot` : '')}
      ${tile(apt && apt.security ? 'warnt' : '', T('os-updates', 'OS updates'), aptVal, apt ? (apt.security ? `${apt.security} ${T('security-updates', 'security')}` : 'waiting') + (apt.reboot_required ? ` · ${T('reboot-required', 'reboot needed')}` : '') : 'not reported')}
      ${tile('', T('network', 'Network'), m.net ? `↓ ${rate(m.net.rx)}` : '—', m.net ? `↑ ${rate(m.net.tx)}` : '')}
      ${tile('', T('process', 'Processes'), m.nprocs ?? '—', `${(n.services || []).length} ${T('service', 'services')} listed`)}
    </div>`;
}

async function renderPiBody() {
  const b = $('#piBody'); if (!b) return;
  if (piTab === 'overview') b.innerHTML = overviewHtml();
  else if (piTab === 'history') await renderHistory(b);
  else if (piTab === 'services') renderServices(b);
  else if (piTab === 'processes') renderProcesses(b);
  else if (piTab === 'events') b.innerHTML = eventsHtml(pi.events, false);
}

function overviewHtml() {
  const n = pi, m = n.metrics || {}, hist = n.hist || [];
  const col = i => hist.map(p => p[i]);
  const mp = memPct(m), swapPct = m.mem && m.mem.swap_total ? 100 * (m.mem.swap_total - m.mem.swap_free) / m.mem.swap_total : null;
  const apt = n.apt, admin = isAdmin();
  const aptLine = !apt ? '<span class="muted">not reported by this client</span>' : apt.upgradable == null ? 'checking…' : apt.upgradable === 0 ? '<span class="ok">up to date</span>'
    : `<b>${apt.upgradable}</b> waiting${apt.security ? `, <b class="warn">${apt.security} security</b>` : ''}`;
  const job = apt && apt.job === 'running' ? ' · <span class="warn">installing…</span>' : apt && apt.job === 'failed' ? ' · <span class="bad">last install failed</span>' : '';
  return `<div class="grid2">
    <div class="card"><h3>${T('cpu', 'CPU')} <span class="right">${pct(m.cpu)}</span></h3>${sparkline(col(1), { max: 100 })}
      <div class="cores">${(m.cores || []).map(c => `<div title="${c}%"><div style="height:${c}%"></div></div>`).join('')}</div>
      <div class="muted tiny" style="margin-top:6px">${(m.cores || []).length} ${T('cores', 'cores')} · ${T('load', 'load')} ${(m.load || []).map(x => x.toFixed(2)).join(' / ')} · last hour</div></div>
    <div class="card"><h3>${T('memory', 'Memory')} <span class="right">${pct(mp)}</span></h3>${sparkline(col(2), { max: 100 })}${meter(mp || 0, 80, 90)}
      <div class="muted tiny" style="margin-top:6px">${m.mem ? `${fmtBytes(m.mem.total - m.mem.avail)} of ${fmtBytes(m.mem.total)}` : ''} · ${T('swap', 'swap')} ${swapPct == null ? 'none' : pct(swapPct)}</div></div>
    <div class="card"><h3>${T('soc-temp', 'Temperature')} <span class="right">${m.temp == null ? '—' : m.temp.toFixed(1) + ' °C'}</span></h3>${sparkline(col(3), { min: 30, max: 90 })}${meter(m.temp || 0, 70, 80)}
      <div class="muted tiny" style="margin-top:6px">${esc(throttleText(m.throttled))} · the Pi slows itself from 80 °C</div></div>
    <div class="card"><h3>${T('disk', 'Storage')}</h3><table class="kv">${(m.disks || []).map(d => `<tr><td>${esc(d.mount)}</td><td>${fmtBytes(d.total - d.used)} free of ${fmtBytes(d.total)} (${pct(100 * d.used / d.total)})${meter(100 * d.used / d.total, 85, 95)}</td></tr>`).join('') || '<tr><td class="muted">No disks reported</td></tr>'}</table>
      <div class="muted tiny" style="margin-top:6px">${T('disk-writes', 'writes')} ${rate((m.disk_io || {}).write)} · ${T('read-only', m.root_ro ? 'read-only!' : 'read-write')}</div></div>
    <div class="card"><h3>${T('os-updates', 'OS updates')} ${admin ? `<span class="right"><button class="small" data-act="apt_check">Check now</button> <button class="small ${apt && apt.upgradable ? 'primary' : ''}" data-act="apt_upgrade" ${apt && apt.job === 'running' ? 'disabled' : ''}>Install</button></span>` : ''}</h3>
      <table class="kv"><tr><td>Waiting</td><td>${aptLine}${job}</td></tr>
      ${apt && apt.checked ? `<tr><td>Checked</td><td>${fmtAgo(apt.checked * 1000)}</td></tr>` : ''}
      ${apt && apt.reboot_required ? `<tr><td>${T('reboot-required', 'Reboot')}</td><td class="warn">needed to finish updates</td></tr>` : ''}</table></div>
    <div class="card"><h3><span>${T('client', 'Client')} &amp; power</span> ${admin ? `<span class="right"><button class="small" data-power="reboot">Reboot</button> <button class="small danger" data-power="shutdown">Shut down</button></span>` : ''}</h3>
      <table class="kv"><tr><td>${T('client-version', 'Version')}</td><td>${esc(n.client_version || '?')}${n.outdated && admin ? ` <button class="small primary" data-act="update">Update to ${esc(n.hub_version)}</button>` : ''}</td></tr>
      <tr><td>${T('link-latency', 'Link')}</td><td>${m.rtt == null ? '—' : m.rtt + ' ms'} · ${T('encrypted-link', 'encrypted')}</td></tr>
      <tr><td>Kernel</td><td>${esc(n.info.kernel || '')} (${esc(n.info.arch || '')})</td></tr>
      <tr><td>Limits</td><td>${n.info.cgroup2 && n.info.systemd ? 'supported (systemd + cgroup v2)' : '<span class="warn">not supported here</span>'}</td></tr></table>
      <p class="muted tiny" style="margin:8px 0 0">On the Pi, <span class="mono">sudo pipulse</span> opens its menu: status, test, pair, update, log.</p></div>
  </div>`;
}

// ---------- history charts (Cards.series) ------------------------------------------------------------
const RANGES = [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['1y', '1 year']];
const RANGE_S = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000, '1y': 31536000 };
const CHARTS = [
  ['CPU', [['cpu', 'var(--accent)', 'average'], ['cpu_max', 'var(--warn)', 'peak']], v => Math.round(v) + '%', 100],
  ['Memory used', [['mem', 'var(--c2)', 'average'], ['mem_max', 'var(--warn)', 'peak']], v => Math.round(v) + '%', 100],
  ['Temperature', [['temp', 'var(--c3)', 'average'], ['temp_max', 'var(--bad)', 'peak']], v => v.toFixed(1) + ' °C'],
  ['Load (1 min)', [['load1', 'var(--c1)', 'load']], v => v.toFixed(2)],
  ['Root disk used', [['disk', 'var(--accent2)', 'used']], v => Math.round(v) + '%', 100],
  ['Network', [['rx', 'var(--accent)', 'down'], ['tx', 'var(--c2)', 'up']], v => fmtBytes(v) + '/s'],
  ['Disk writes', [['wr', 'var(--c3)', 'written']], v => fmtBytes(v) + '/s'],
  ['Link latency', [['rtt', 'var(--accent2)', 'round trip']], v => v.toFixed(1) + ' ms'],
];
async function renderHistory(b) {
  b.innerHTML = `<div class="toolbar"><span class="muted">Range</span><select id="rangeSel" class="small">${RANGES.map(([k, l]) => `<option value="${k}" ${k === piRange ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="muted small" id="histRes"></span></div><div class="grid2" id="charts"><div class="empty">Loading…</div></div>`;
  $('#rangeSel').onchange = e => { piRange = e.target.value; localStorage.setItem('pipulse.range', piRange); renderHistory(b); };
  const h = await api.pi.history(pi.id, piRange);
  if (!$('#charts')) return;
  const ix = Object.fromEntries(h.cols.map((c, i) => [c, i]));
  const to = Date.now(), from = to - RANGE_S[piRange] * 1000;
  $('#histRes').textContent = h.points.length ? `${h.points.length} points · ${h.resolution === 'hourly' ? 'hourly averages' : h.resolution === 'raw' ? 'full detail' : 'averaged per ' + (parseInt(h.resolution) < 90 ? h.resolution : fmtUptime(parseInt(h.resolution)))}` : 'no history in this range yet';
  $('#charts').innerHTML = CHARTS.map(([title, sets, fmt, yMax]) => Cards.series(
    sets.map(([k, color, name]) => ({ name, color, points: h.points.map(p => ({ t: p[0] * 1000, y: p[ix[k]] })) })),
    title, { fmt, yMax, from, to, empty: 'No data in this range yet' })).join('');
}

// ---------- services: watched list + table with limit / restart / watch ------------------------------
function renderServices(b) {
  const n = pi, admin = isAdmin(), watch = (n.prefs && n.prefs.watch) || {}, st = n.watch_status || {};
  const wrows = Object.keys(watch).sort().map(u => {
    const s = st[u] || 'waiting for report', ok = ['active', 'reloading', 'activating'].includes(s);
    return `<tr><td class="mono">${esc(u)}</td><td><span class="badge ${ok ? 'ok' : 'bad'}">${esc(s)}</span></td>
      <td>${admin ? `<button class="small ${watch[u].restart ? 'primary' : ''}" data-autorestart="${esc(u)}">${T('auto-restart', 'Auto-restart')} ${watch[u].restart ? 'on' : 'off'}</button>` : (watch[u].restart ? 'auto-restart on' : '')}</td>
      <td class="num">${admin ? `<button class="small" data-unwatch="${esc(u)}">Stop watching</button>` : ''}</td></tr>`;
  }).join('');
  b.innerHTML = `<div class="card" style="margin-bottom:12px"><h3>${T('watchdog', 'Watched services')}</h3>
      ${wrows ? `<table>${wrows}</table>` : '<p class="muted small" style="margin:0 0 6px">None yet. Watch a service to get an alert when it stops.</p>'}
      ${admin ? '<div class="inline" style="margin-top:8px"><input type="text" id="addWatch" placeholder="service, e.g. medialedger" spellcheck="false" style="width:260px"><button class="small primary" data-addwatch>Watch</button></div>' : ''}</div>
    <p class="lead">${T('service', 'Services')} by CPU and memory. ${T('cpu-cap', 'CPU caps')} count in ${T('cores', 'cores')} (${n.info.cores || '?'} on this Pi). Caps apply straight away and survive reboots. <button class="small" id="svcRefresh">Refresh</button> <span class="muted tiny">as of ${fmtTime(n.seen * 1000)}</span></p>
    <div id="svcTable"></div>`;
  const cols = [
    { key: 'unit', label: 'Service', render: s => `<span class="mono">${esc(s.unit)}</span>${watch[s.unit] ? ' <span class="badge ok">watched</span>' : ''}` },
    { key: 'cpu', label: 'CPU', num: true, render: s => s.cpu.toFixed(1) + '%' },
    { key: 'mem', label: 'RAM', num: true, render: s => fmtBytes(s.mem) },
    { key: 'tasks', label: 'Tasks', num: true },
    { key: 'limits', label: 'Limits', sortVal: s => (s.cpu_quota || 0) + (s.mem_max ? 1 : 0), render: s => [s.cpu_quota ? `<span class="badge c1">CPU ≤ ${+(s.cpu_quota / 100).toFixed(2)} core</span>` : '', s.mem_max ? `<span class="badge c2">RAM ≤ ${fmtBytes(s.mem_max)}</span>` : '', s.cpu_weight && s.cpu_weight !== 100 ? `<span class="badge">weight ${s.cpu_weight}</span>` : ''].join('') || '<span class="muted">none</span>' },
    ...(admin ? [{ key: 'act', label: '', render: s => `<span class="nowrap">${s.unit.endsWith('.service') && !watch[s.unit] ? `<button class="small" data-watch="${esc(s.unit)}">Watch</button> ` : ''}<button class="small" data-limit="${esc(s.unit)}">Limit</button>${s.unit.endsWith('.service') ? ` <button class="small" data-restart="${esc(s.unit)}">Restart</button>` : ''}</span>` }] : []),
  ];
  const t = makeTable(n.services || [], cols, { defaultSort: { key: 'cpu', asc: false }, search: s => s.unit });
  const tb = UI.searchToolbar(t, (n.services || []).length);
  $('#svcTable').append(tb, t.node);
  $('#svcRefresh').onclick = refreshPi;
}

function renderProcesses(b) {
  const n = pi, admin = isAdmin();
  b.innerHTML = `<p class="lead">The busiest ${T('process', 'processes')} and the biggest memory users. ${T('nice', 'Nice')} lowers a process's priority until it restarts; for a lasting limit use its service. <button class="small" id="prRefresh">Refresh</button> <span class="muted tiny">as of ${fmtTime(n.seen * 1000)}</span></p><div id="prTable"></div>`;
  const cols = [
    { key: 'pid', label: 'PID', num: true },
    { key: 'name', label: 'Name', render: p => `<b>${esc(p.name)}</b>` },
    { key: 'user', label: 'User' },
    { key: 'cpu', label: 'CPU', num: true, render: p => p.cpu.toFixed(1) + '%' },
    { key: 'rss', label: 'RAM', num: true, render: p => fmtBytes(p.rss) },
    { key: 'nice', label: 'Nice', num: true },
    { key: 'unit', label: 'Service', render: p => p.unit ? `<span class="mono small">${esc(p.unit)}</span>` : '' },
    { key: 'cmd', label: 'Command', cls: 'wrap', render: p => `<span class="mono tiny muted" title="${esc(p.cmd)}">${esc(p.cmd.slice(0, 90))}</span>` },
    ...(admin ? [{ key: 'act', label: '', render: p => `<span class="nowrap"><button class="small" data-renice="${p.pid}" data-name="${esc(p.name)}">Nice</button>${p.unit ? ` <button class="small" data-limit="${esc(p.unit)}">Limit service</button>` : ''}</span>` }] : []),
  ];
  const t = makeTable(n.procs || [], cols, { defaultSort: { key: 'cpu', asc: false }, search: p => `${p.name} ${p.cmd} ${p.user} ${p.unit || ''}` });
  $('#prTable').append(UI.searchToolbar(t, (n.procs || []).length), t.node);
  $('#prRefresh').onclick = refreshPi;
}

const LEVEL = { crit: ['bad', 'critical'], warn: ['warn', 'warning'], error: ['bad', 'error'], ok: ['ok', 'done'], info: ['', 'info'] };
function eventsHtml(rows, withPi) {
  if (!rows.length) return '<div class="card empty">Nothing logged yet.</div>';
  return `<div class="card"><table>${rows.map(e => `<tr><td class="muted nowrap">${fmtTime(e.ts * 1000)}</td><td><span class="badge ${(LEVEL[e.level] || LEVEL.info)[0]}">${(LEVEL[e.level] || LEVEL.info)[1]}</span></td>${withPi ? `<td class="nowrap">${e.node ? `<a href="#pi/${encodeURIComponent(e.node)}">${esc(e.name)}</a>` : `<span class="muted">${esc(e.name)}</span>`}</td>` : ''}<td class="wrap">${esc(e.msg)}</td></tr>`).join('')}</table></div>`;
}

async function refreshPi() {
  if (UI.current() !== 'pi' || !pi) return;
  try { pi = await api.pi.get(pi.id); } catch { return; }
  renderPiHead();
  if (piTab === 'overview') $('#piBody').innerHTML = overviewHtml();
  if (piTab === 'services' || piTab === 'processes' || piTab === 'events') await renderPiBody();
}

// Every button on a Pi page, by data attribute.
document.addEventListener('click', async (e) => {
  if (UI.current() !== 'pi' || !pi) return;
  const b = e.target.closest('button'); if (!b || !b.closest('#view')) return;
  const d = b.dataset;
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); refreshPi(); } catch (err) { toast(err.message, true); } };
  if (d.act === 'apt_check') run(() => api.pi.action(pi.id, { type: 'apt_check' }), 'Checking for OS updates');
  if (d.act === 'apt_upgrade' && confirm(`Install OS updates on ${nodeName(pi)}? apt upgrade runs in the background and can take a while.`)) run(() => api.pi.action(pi.id, { type: 'apt_upgrade' }), 'Installing OS updates');
  if (d.act === 'update') run(() => api.pi.action(pi.id, { type: 'update' }), 'The client updates itself and restarts');
  if (d.power) {
    const what = d.power === 'reboot' ? 'Reboot' : 'Shut down';
    if (confirm(`${what} ${nodeName(pi)}?${d.power === 'shutdown' ? '\n\nIt stays off until someone powers it back on.' : ''}`)) run(() => api.pi.power(pi.id, d.power), `${what} requested`);
  }
  if (d.restart && confirm(`Restart ${d.restart} on ${nodeName(pi)}?`)) run(() => api.pi.action(pi.id, { type: 'restart', unit: d.restart }), 'Restart requested');
  if (d.watch) run(() => api.pi.watch(pi.id, d.watch, true, false).then(p => { pi.prefs = p; }), `Watching ${d.watch}`);
  if (d.unwatch) run(() => api.pi.watch(pi.id, d.unwatch, false).then(p => { pi.prefs = p; }), `Stopped watching ${d.unwatch}`);
  if (d.autorestart) { const cur = (pi.prefs.watch[d.autorestart] || {}).restart; run(() => api.pi.watch(pi.id, d.autorestart, true, !cur).then(p => { pi.prefs = p; }), `Auto-restart ${cur ? 'off' : 'on'}`); }
  if (d.addwatch !== undefined) { let u = $('#addWatch').value.trim(); if (u && !u.includes('.')) u += '.service'; if (u) run(() => api.pi.watch(pi.id, u, true, false).then(p => { pi.prefs = p; }), `Watching ${u}`); }
  if (d.renice) { const v = prompt(`New nice value for ${d.name} (pid ${d.renice}).\n10 = lower priority, 19 = lowest, 0 = normal.`, '10'); if (v !== null && v.trim() !== '') run(() => api.pi.action(pi.id, { type: 'renice', pid: +d.renice, nice: +v, name: d.name }), 'Priority change sent'); }
  if (d.limit) limitModal(d.limit);
});

function limitModal(unit) {
  const s = (pi.services || []).find(x => x.unit === unit) || {}, cores = pi.info.cores || 1, ramMb = Math.round(((pi.metrics || {}).mem || {}).total / 1048576) || 1024;
  const card = openModal(`<h2>Limit ${esc(unit)}</h2><div class="path">Enforced by systemd on ${esc(nodeName(pi))}: it applies at once, survives reboots and does not change the program.</div>
    <div class="field"><label>${T('cpu-cap', 'CPU cap')}</label><div class="inline"><input type="range" id="lCpu" min="0" max="${cores * 100}" step="25" value="${s.cpu_quota || 0}" style="width:220px"><span id="lCpuOut" class="small"></span></div></div>
    <div class="field"><label>${T('memory-cap', 'Memory cap')}</label><div class="inline"><input type="number" id="lMem" min="16" step="16" value="${s.mem_max ? Math.round(s.mem_max / 1048576) : ''}" placeholder="none" style="width:110px"> <span class="muted">MB (blank = none)</span></div><div class="hint">Slowed down near 90%; past the cap systemd restarts it.</div></div>
    <div class="field"><label>${T('cpu-weight', 'Priority')}</label><select id="lWeight"><option value="">Normal (default)</option><option value="20">Background (20)</option><option value="50">Low (50)</option><option value="200">High (200)</option><option value="500">Critical (500)</option></select></div>
    <div class="field"><label>Presets</label><div class="inline"><span class="chip" data-p="gentle">Gentle neighbour</span><span class="chip" data-p="half">Half the Pi</span><span class="chip" data-p="clear">Remove limits</span></div></div>
    <div class="actions"><span class="grow"></span><button id="lCancel">Cancel</button><button class="primary" id="lApply">Apply</button></div>`);
  const w = $('#lWeight', card); w.value = s.cpu_weight && s.cpu_weight !== 100 ? String(s.cpu_weight) : '';
  const out = () => { const v = +$('#lCpu', card).value; $('#lCpuOut', card).textContent = v ? `${v}% = ${v / 100} core${v === 100 ? '' : 's'}` : 'no cap'; };
  $('#lCpu', card).oninput = out; out();
  card.querySelectorAll('.chip[data-p]').forEach(c => { c.onclick = () => {
    if (c.dataset.p === 'gentle') { $('#lCpu', card).value = Math.max(25, cores * 50); w.value = '50'; }
    if (c.dataset.p === 'half') { $('#lCpu', card).value = cores * 50; $('#lMem', card).value = Math.round(ramMb / 2 / 16) * 16; }
    if (c.dataset.p === 'clear') { $('#lCpu', card).value = 0; $('#lMem', card).value = ''; w.value = ''; }
    out();
  }; });
  $('#lCancel', card).onclick = closeModal;
  $('#lApply', card).onclick = async () => {
    const cpu = +$('#lCpu', card).value, mem = $('#lMem', card).value.trim();
    try { await api.pi.action(pi.id, { type: 'limit', unit, cpu_quota: cpu ? Math.max(5, cpu) : null, mem_max_mb: mem ? +mem : null, cpu_weight: w.value ? +w.value : null }); closeModal(); toast('Limit sent; it shows here after the next report'); refreshPi(); }
    catch (err) { toast(err.message, true); }
  };
}

// ---------- events ----------------------------------------------------------------------------------
let evOldest = null;
views.events = async () => {
  const v = UI.view();
  const nodes = [...(fleet.nodes.length ? fleet.nodes : (await api.fleet.state()).nodes)].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  v.innerHTML = `<h1>Events</h1><p class="lead">Everything the hub has logged: ${T('alert', 'alerts')} raised and cleared, actions and their results, reboots, sign-ins and settings changes.</p>
    <div class="toolbar"><select id="evNode"><option value="">All Pis and the hub</option>${nodes.map(n => `<option value="${esc(n.id)}">${esc(nodeName(n))}</option>`).join('')}</select>
      <select id="evLevel"><option value="">All levels</option><option value="crit">Critical</option><option value="warn">Warning</option><option value="error">Error</option><option value="ok">Done / cleared</option><option value="info">Info</option></select>
      <input type="search" id="evQ" placeholder="Search messages…"><span class="grow"></span></div>
    <div id="evList"></div><div class="inline" style="margin-top:10px"><button id="evMore" hidden>Load older</button></div>`;
  const load = async (more) => {
    const q = { node: $('#evNode').value, level: $('#evLevel').value, q: $('#evQ').value.trim(), limit: 100 };
    if (more && evOldest) q.before = evOldest;
    const rows = await api.events.list(q);
    if (more) $('#evList').insertAdjacentHTML('beforeend', eventsHtml(rows, true)); else $('#evList').innerHTML = eventsHtml(rows, true);
    evOldest = rows.length ? rows[rows.length - 1].id : evOldest;
    $('#evMore').hidden = rows.length < 100;
  };
  let deb; $('#evQ').oninput = () => { clearTimeout(deb); deb = setTimeout(() => load(false), 300); };
  $('#evNode').onchange = $('#evLevel').onchange = () => load(false);
  $('#evMore').onclick = () => load(true);
  await load(false);
};

// ---------- add a Pi ------------------------------------------------------------------------------------
views.add = async () => {
  const v = UI.view();
  const i = await api.fleet.install();
  v.innerHTML = `<h1>Add a Pi</h1><p class="lead">Installs the PiPulse ${T('client', 'client')} on another Raspberry Pi. It pins this hub's ${T('fingerprint', 'certificate')} and reports over the ${T('encrypted-link', 'encrypted link')} within about 10 seconds. The new Pi needs to reach this hub on ports ${i.web_port} (install) and ${i.link_port} (reports).</p>
    <div class="grid2">
      <div class="card"><h3>Paste on the Pi</h3><p class="small">Open a terminal on the new Pi (or SSH into it) and paste:</p><pre class="cmdbox mono" id="cmdPi">${esc(i.command)}</pre><div class="inline"><button class="primary" data-copy="cmdPi">Copy</button></div></div>
      <div class="card"><h3>From your PC over SSH</h3><p class="small">Run these in PowerShell, Command Prompt or a terminal on your PC. Each line SSHes into one Pi and installs the client; it asks for that Pi's password when sudo needs it.</p>
        <div class="field"><label>SSH user</label><input type="text" id="sshUser" value="${esc(localStorage.getItem('pipulse.sshUser') || 'pi')}" style="width:140px"></div>
        <div class="field"><label>Pi addresses</label><textarea id="sshHosts" rows="3" placeholder="192.168.1.210&#10;192.168.1.211" spellcheck="false"></textarea><div class="hint">One per line, or separated by spaces.</div></div>
        <pre class="cmdbox mono" id="cmdSsh"></pre><div class="inline"><button class="primary" data-copy="cmdSsh">Copy</button></div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Afterwards</h3><table class="kv">
      <tr><td>On that Pi</td><td><span class="mono">sudo pipulse</span> opens its menu: status, test the connection, pair again, update, log</td></tr>
      <tr><td>To remove it</td><td><span class="mono">${esc(i.uninstall)}</span></td></tr>
      <tr><td>The ${T('token', 'token')}</td><td>is part of the command, so only admins see this page</td></tr></table></div>`;
  // -t gives sudo a terminal for its password prompt. The install command stays inside double
  // quotes with its own single quotes, which works the same in PowerShell, cmd and bash.
  const ssh = () => {
    const user = $('#sshUser').value.trim() || 'pi'; localStorage.setItem('pipulse.sshUser', user);
    const hosts = $('#sshHosts').value.split(/[\s,]+/).filter(Boolean);
    $('#cmdSsh').textContent = (hosts.length ? hosts : ['<pi-address>']).map(h => `ssh -t ${user}@${h} "${i.command}"`).join('\n');
  };
  $('#sshUser').oninput = $('#sshHosts').oninput = ssh; ssh();
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const text = $('#' + b.dataset.copy).textContent;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied')).catch(() => toast('Select the text and copy it', true));
});

// ---------- settings ------------------------------------------------------------------------------------
const GROUPS = [
  ['Reporting', [['interval', 'Report every', 's', 'How often each client sends a report.'], ['offline_after', T('offline', 'Offline') + ' after', 's', 'No report for this long raises an offline alert.']]],
  ['Alerts', [['sustain', T('sustain', 'Problem must last'), 's', 'Offline, under-voltage, throttling and a read-only disk alert at once.'],
    ['temp_warn', 'Temperature warning', '°C'], ['temp_crit', 'Temperature critical', '°C'], ['mem_warn', 'Memory warning', '% used'], ['mem_crit', 'Memory critical', '% used'],
    ['disk_warn', 'Disk warning', '% full'], ['disk_crit', 'Disk critical', '% full'], ['swap_warn', T('swap', 'Swap') + ' warning', '% used'],
    ['load_warn', T('load', 'Load') + ' warning', '× cores', '5-minute load average per core.'], ['write_warn', T('disk-writes', 'Disk-write') + ' warning', 'MB/min', '0 turns it off.']]],
  [T('retention', 'History'), [['raw_days', 'Keep full detail for', 'days'], ['hourly_days', 'Keep hourly averages for', 'days'], ['event_days', 'Keep events for', 'days']]],
  ['NAS storage', [['nas_data_dir', 'Logs folder', '', 'The hourly ' + T('mirror', 'mirror') + ' and the ' + T('archive', 'archive') + '. Empty turns them off.', 'path'],
    ['mirror_hours', 'Mirror every', 'hours', '0 turns the mirror off.'], ['archive', T('archive', 'Archive') + ' old data', '', 'Move data past the history limits to the NAS instead of deleting it.', 'bool'],
    ['nas_backup_dir', 'Backup folder', '', 'Nightly ' + T('backup', 'backup') + ': database + hub certificate and key.', 'path'],
    ['backup_hour', 'Back up from', "o'clock", 'Once a day from this hour (local time).'], ['backup_keep', 'Keep', 'backups']]],
  ['Updates', [['update_check', 'Check GitHub daily', '', 'Nothing installs until you press Update on the About page.', 'bool']]],
];
views.settings = async () => {
  const v = UI.view();
  const d = await api.hub.settings(), s = d.settings;
  const look = sections.appearance(), ha = sections.homeAssistant('Read-only fleet status JSON (online count, alerts, CPU, memory and temperature per Pi) for Home Assistant REST sensors:');
  const field = ([k, label, unit, help, type]) => {
    const hint = help ? `<div class="hint">${help}</div>` : '';
    if (type === 'path') return `<div class="field"><label>${label}</label><input type="text" name="${k}" value="${esc(s[k])}" placeholder="off" spellcheck="false" class="mono">${hint}</div>`;
    if (type === 'bool') return `<div class="field"><label>${label}</label><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}>${hint}</div>`;
    const [lo, hi] = d.limits[k];
    return `<div class="field"><label>${label}</label><div class="inline"><input type="number" name="${k}" value="${s[k]}" min="${lo}" max="${hi}" step="${Number.isInteger(lo) ? 1 : 0.1}" style="width:100px"> <span class="muted">${unit}</span></div>${hint}</div>`;
  };
  v.innerHTML = `<h1>Settings</h1><div class="form">
    ${GROUPS.map(([title, fields], gi) => `<div class="section-head"><h2>${title}</h2></div><div class="card setgroup" data-g="${gi}">${fields.map(field).join('')}<div class="inline"><button class="primary" data-save="${gi}">Save</button></div></div>`).join('')}
    <div class="section-head"><h2>NAS status</h2></div><div class="card" id="nasBox"><div class="empty">Loading…</div></div>
    <div class="section-head"><h2>${T('guard-rule', 'Guard rules')}</h2></div><div class="card" id="guardBox"></div>
    <div class="section-head"><h2>${T('encrypted-link', 'Encrypted client link')}</h2></div><div class="card">
      <p class="small" style="margin-top:0">Clients report over HTTPS on port <b>${d.link_port}</b> and check this ${T('fingerprint', 'certificate fingerprint')} before sending anything:</p>
      <div class="secret" style="font-size:12px;letter-spacing:1px;overflow-wrap:anywhere">${esc(d.fingerprint)}</div>
      <p class="muted tiny">Moving the hub to another Pi? Copy <span class="mono">${esc(d.data)}</span> across, including hub-cert.pem and hub-key.pem, so every client keeps trusting it.</p></div>
    ${look.html}${ha.html}</div>`;
  $$('[data-save]').forEach(b => { b.onclick = async () => {
    const changes = {};
    $$(`.setgroup[data-g="${b.dataset.save}"] input[name]`).forEach(inp => {
      const val = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.type === 'text' ? inp.value.trim() : +inp.value;
      if (val !== s[inp.name]) changes[inp.name] = val;
    });
    if (!Object.keys(changes).length) return toast('Nothing changed');
    try { Object.assign(s, await api.hub.setSettings(changes)); toast('Saved'); loadNas(); } catch (e) { toast(e.message, true); }
  }; });
  look.wire(); ha.wire();
  renderGuards(d);
  loadNas();
};

async function loadNas() {
  const box = $('#nasBox'); if (!box) return;
  let d; try { d = await api.nas.view(); } catch (e) { box.innerHTML = `<div class="bad">${esc(e.message)}</div>`; return; }
  const job = (k, label) => { const j = d.status[k]; return `<tr><td>${label}</td><td>${!j ? '<span class="muted">not run yet</span>' : `<span class="${j.ok ? 'ok' : 'bad'}">${j.ok ? '✓' : '✕'}</span> ${esc(j.msg)} <span class="muted">· ${fmtAgo(j.at * 1000)}</span>`}</td></tr>`; };
  const dir = (k, label) => { const x = d.dirs[k]; return `<tr><td>${label}</td><td>${x.path ? `<span class="mono small">${esc(x.path)}</span><br>` : ''}${x.ok ? '<span class="ok">reachable</span>' : `<span class="${x.path ? 'bad' : 'muted'}">${esc(x.msg)}</span>`}</td></tr>`; };
  box.innerHTML = `<table class="kv">${dir('nas_data_dir', 'Logs folder')}${dir('nas_backup_dir', 'Backup folder')}${job('mirror', 'Last ' + T('mirror', 'mirror'))}${job('archive', 'Last ' + T('archive', 'archive'))}${job('backup', 'Last ' + T('backup', 'backup'))}</table>
    <div class="inline" style="margin-top:10px"><button data-nas="mirror" ${d.running ? 'disabled' : ''}>Mirror now</button><button class="primary" data-nas="backup" ${d.running ? 'disabled' : ''}>Back up now</button>${d.running ? `<span class="muted">${esc(d.running)} running…</span>` : ''}</div>
    ${d.backups.length ? `<details style="margin-top:10px"><summary class="muted small" style="cursor:pointer">${d.backups.length} backups on the NAS</summary><table>${d.backups.map(b => `<tr><td class="mono small">${esc(b.name)}</td><td class="num">${fmtBytes(b.size)}</td></tr>`).join('')}</table>
      <p class="muted tiny">Restore one on the hub Pi: <span class="mono">sudo pipulse-hub restore "&lt;backup folder&gt;/&lt;file&gt;"</span></p></details>` : ''}
    <p class="muted tiny">On the hub Pi, <span class="mono">sudo pipulse-hub nas</span> connects (or reconnects) the NAS share.</p>`;
  box.querySelectorAll('[data-nas]').forEach(b => { b.onclick = async () => { try { await api.nas.run(b.dataset.nas); toast(`${b.dataset.nas} started`); setTimeout(loadNas, 1500); } catch (e) { toast(e.message, true); } }; });
  if (d.running) setTimeout(() => { if (UI.current() === 'settings') loadNas(); }, 3000);
}

function renderGuards(d) {
  const nodes = [...fleet.nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  const row = r => `<tr data-id="${esc(r.id || '')}"><td><input type="checkbox" data-g="on" ${r.on !== false ? 'checked' : ''} title="On"></td>
    <td><input type="text" data-g="name" value="${esc(r.name || '')}" style="width:120px"></td>
    <td><input type="text" data-g="match" value="${esc(r.match || '*')}" style="width:140px" class="mono" spellcheck="false" title="Service name; * and ? are wildcards"></td>
    <td><select data-g="node"><option value="">All Pis</option>${nodes.map(n => `<option value="${esc(n.id)}" ${n.id === r.node ? 'selected' : ''}>${esc(nodeName(n))}</option>`).join('')}</select></td>
    <td><select data-g="metric"><option value="cpu" ${r.metric !== 'mem' ? 'selected' : ''}>CPU over</option><option value="mem" ${r.metric === 'mem' ? 'selected' : ''}>RAM over</option></select></td>
    <td><input type="number" data-g="above" value="${r.above ?? 150}" style="width:80px"></td><td><input type="number" data-g="minutes" value="${r.minutes ?? 5}" step="0.5" style="width:70px"></td>
    <td><input type="number" data-g="cap" value="${r.cap ?? 100}" style="width:80px"></td><td><button class="small" data-gdel>✕</button></td></tr>`;
  const box = $('#guardBox');
  box.innerHTML = `<p class="small" style="margin-top:0">When a service stays over a limit, cap it and log an event. CPU is % of one core (150 = 1.5 ${T('cores', 'cores')}), RAM is MB. A rule fires once per service and never touches ${esc(d.protected.join(', '))}.</p>
    <table class="guards"><thead><tr><th>On</th><th>Name</th><th>Service</th><th>Pi</th><th>When</th><th>Over</th><th>For (min)</th><th>${T('cpu-cap', 'Cap at')}</th><th></th></tr></thead><tbody>${(d.settings.guards || []).map(row).join('')}</tbody></table>
    <div class="inline" style="margin-top:10px"><button data-gadd>+ Add rule</button><span class="grow"></span><button class="primary" data-gsave>Save rules</button></div>`;
  box.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.gadd !== undefined) $('tbody', box).insertAdjacentHTML('beforeend', row({ name: 'CPU hog', match: '*', metric: 'cpu', above: 150, minutes: 5, cap: 100 }));
    if (b.dataset.gdel !== undefined) b.closest('tr').remove();
    if (b.dataset.gsave !== undefined) {
      const rules = $$('tbody tr', box).map(tr => { const g = k => tr.querySelector(`[data-g="${k}"]`); return { id: tr.dataset.id, on: g('on').checked, name: g('name').value, match: g('match').value, node: g('node').value, metric: g('metric').value, above: +g('above').value, minutes: +g('minutes').value, cap: +g('cap').value }; });
      try { d.settings.guards = await api.hub.guards(rules); renderGuards(d); toast('Guard rules saved'); } catch (err) { toast(err.message, true); }
    }
  };
}

// ---------- about: the kit's page plus hub & Pi updates -------------------------------------------------
const aboutBase = pages.about({
  blurb: 'A hub on one Pi and a small client on every Pi. It watches CPU, memory, temperature, disks and services, keeps history on the NAS, and caps any program that tries to starve a Pi. Standard-library Python on both ends: no pip, no Docker, no cloud.',
  rows: [['Hub', 'The dashboard, logs, settings and alerts (this Pi)'], ['Clients', 'One per Pi, reporting over an encrypted link']],
  credits: [['PiPulse', 'Hub, client and pages · MIT, AxialForge']],
});
views.about = async () => {
  await aboutBase();
  const u = await api.hubUpdate.view(), l = u.latest || {}, admin = isAdmin();
  const outdated = fleet.nodes.filter(n => n.online && n.outdated).length;
  let action;
  if (u.in_progress) action = '<p><b>Updating the hub…</b> This page comes back by itself in about a minute.</p>';
  else if (u.available && u.managed && admin) action = `<button class="primary" id="hubUpd">Update hub to ${esc(u.available)}</button>`;
  else if (u.available && !u.managed) action = `<p class="muted">This hub was not installed with the Pi installer, so update it by hand: ${esc(u.available)} is on <a href="${esc(l.url)}" target="_blank" rel="noopener">GitHub</a>.</p>`;
  else if (u.available) action = `<p>PiPulse ${esc(u.available)} is available; an admin can install it.</p>`;
  else action = '<p class="ok">The hub is up to date.</p>';
  UI.view().insertAdjacentHTML('beforeend', `<h2>Hub &amp; Pi updates</h2><div class="grid2">
    <div class="card"><h3>${T('hub', 'Hub')}</h3><table class="kv"><tr><td>Installed</td><td>PiPulse ${esc(u.current)}</td></tr>
      <tr><td>Latest release</td><td>${l.version ? esc(l.version) + (l.published ? ` <span class="muted">(${esc(l.published.slice(0, 10))})</span>` : '') : '<span class="muted">not checked yet</span>'}</td></tr>
      <tr><td>Last checked</td><td>${l.checked ? fmtAgo(l.checked * 1000) : '—'}${l.error ? ` <span class="warn">(${esc(l.error)})</span>` : ''}</td></tr></table>
      <div style="margin-top:10px">${action}</div>
      <p class="muted tiny">Updates come from GitHub releases and are checked against the release's SHA256SUMS before anything is installed.</p></div>
    <div class="card"><h3>${T('client-version', 'Pis')}</h3><p class="small" style="margin-top:0">${outdated ? `${outdated} Pi${outdated > 1 ? 's run' : ' runs'} an older client than this hub.` : 'Every online Pi runs this hub\'s client version.'}</p>
      ${outdated && admin ? '<button class="primary" id="clUpd">Update all Pis</button>' : ''}<p class="muted tiny">Pis update from this hub over the encrypted link and restart their client.</p></div></div>
    ${u.available && l.notes ? `<h2>What's in ${esc(u.available)}</h2><div class="card md">${md(l.notes)}</div>` : ''}
    <h2>Changelog</h2><div class="card md">${md(u.changelog.replace(/^# Changelog[\s\S]*?(?=^## )/m, ''))}</div>`);
  if ($('#hubUpd')) $('#hubUpd').onclick = async () => { if (!confirm('Update the hub now? The dashboard goes away for about a minute while it restarts.')) return; try { await api.hubUpdate.hub(); toast('Update started'); views.about(); } catch (e) { toast(e.message, true); } };
  if ($('#clUpd')) $('#clUpd').onclick = updateAll;
  setPill('updatePill', u.available ? 'update' : null, 'accent');
};

// Just enough Markdown for release notes: headings, bullets, bold, code, links. Escapes first.
function md(text) {
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<span class="mono">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let html = '', list = false, para = [];
  const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  for (const raw of String(text || '').split('\n')) {
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

// ---------- kit pages, first run, boot --------------------------------------------------------------------
views.security = pages.security;

// While no account exists, the kit's sign-in dialog creates the first (admin) one; say so on it.
fetch('api/firstrun').then(r => r.json()).then(({ firstRun }) => {
  if (!firstRun) return;
  const relabel = () => {
    const box = document.querySelector('.webauth'); if (!box || box.dataset.firstrun) return;
    box.dataset.firstrun = '1';
    box.querySelector('h2').textContent = 'Welcome to PiPulse';
    box.querySelector('p.muted').textContent = 'No account exists yet. Choose a username and password (8+ characters): this first account is the admin.';
    const code = box.querySelector('input[name=code]'); if (code) code.closest('.field').hidden = true;
    box.querySelector('button[type=submit]').textContent = 'Create account';
  };
  new MutationObserver(relabel).observe(document.body, { childList: true });
  relabel();
}).catch(() => {});

UI.init({
  home: 'pis',
  nav: [
    { group: 'Fleet', items: [
      { view: 'pis', label: 'Pis', icon: '◉', pill: 'piPill', pillClass: 'bad', roles: ['admin', 'standard', 'guest'] },
      { view: 'events', label: 'Events', icon: '≣' },
      { view: 'add', label: 'Add a Pi', icon: '＋', roles: ['admin'] },
    ] },
    { group: 'Hub', items: [
      { view: 'settings', label: 'Settings', icon: '⚙', roles: ['admin'] },
      { view: 'security', label: 'Security', icon: '⛨', pill: 'secPill', pillClass: 'bad' },
      { view: 'about', label: 'About', icon: 'ⓘ', pill: 'updatePill', pillClass: 'accent', roles: ['admin', 'standard', 'guest'] },
    ] },
  ],
  standardRoleText: 'every page read-only (Pis, Events, About), their own password; no actions, settings or adding Pis.',
  onReady: async () => { try { fleetPills(fleet = await api.fleet.state()); } catch { /* signed out */ } },
});

// Live refresh: the Pis page and a Pi's overview every few seconds (never while a modal is open or
// the pointer rests on a table, so rows can't slide away from a click; see CLAUDE.md gotchas).
setInterval(async () => {
  if (document.visibilityState !== 'visible' || !$('#modal').hidden) return;
  if (document.querySelector('#view table:hover, #view input:focus, #view select:focus, #view textarea:focus')) return;
  if (UI.current() === 'pis') { try { const st = fleet = await api.fleet.state(); fleetPills(st); const f = $('#fleet'); if (f && st.nodes.length) f.innerHTML = [...st.nodes].sort((a, b) => nodeName(a).localeCompare(nodeName(b))).map(piRow).join(''); } catch { /* next tick */ } }
  else if (UI.current() === 'pi' && piTab === 'overview') refreshPi();
}, REFRESH_MS);
