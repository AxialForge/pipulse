'use strict';
/* The UI helper library and app shell for Bracket apps. No framework: helpers return HTML strings,
   pages render into #view, a hash router picks the page. Loads after app-meta.js, bridge-shape.js
   and webbridge.js (or the desktop preload), and before app.js.

     const { $, esc, tile, makeTable, … } = UI;
     UI.views.items = async () => { … };            // one function per page
     UI.init({ nav: [...], guestViews: [...] });      // renders the sidebar and starts routing

   Kit-provided pages: UI.pages.security, .system, .log, .about(opts). Register the ones you want:
     UI.views.security = UI.pages.security;
   Kit-provided settings sections (html + wire): UI.sections.notifications, .homeAssistant, .appearance. */
(function () {
  const APP = window.APP || {};
  const api = () => window[APP.bridge || 'api'];
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = () => $('#view');

  // ---------- formatting -----------------------------------------------------------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const fmtN = n => Number(n || 0).toLocaleString();
  const fmtBytes = b => { if (b == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = Number(b); while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`; };
  const fmtGB = b => { if (b == null) return '—'; const n = Number(b); if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`; if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`; if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`; return `${(n / 1e3).toFixed(0)} kB`; };
  const fmtDate = ms => ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const fmtTime = ms => ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const fmtAgo = ms => { if (!ms) return 'never'; const d = (Date.now() - ms) / 1000; if (d < 60) return `${Math.max(0, Math.round(d))} s ago`; if (d < 5400) return Math.round(d / 60) + ' min ago'; if (d < 172800) return Math.round(d / 3600) + ' h ago'; return Math.round(d / 86400) + ' days ago'; };
  const fmtIn = ms => { if (!ms) return ''; const d = (ms - Date.now()) / 1000; if (d < 0) return 'expired'; if (d < 3600) return `in ${Math.round(d / 60)} min`; if (d < 172800) return `in ${Math.round(d / 3600)} h`; return `in ${Math.round(d / 86400)} days`; };
  const fmtUptime = (s) => { if (s == null) return ''; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const fmtMs = (v) => v == null ? '—' : `${Math.round(Number(v) * 10) / 10} ms`;
  const fmtRate = (bps) => bps == null ? '—' : bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' MB/s' : (bps / 1e3).toFixed(0) + ' kB/s';
  const sevClass = (s) => (s === 'HIGH' || s === 'CRITICAL' ? 'bad' : s === 'MEDIUM' ? 'warn' : '');
  // A glossary term when glossary.js is loaded (it replaces UI.term), plain text otherwise.
  const T = (key, text) => (window.Glossary ? window.Glossary.term(key, text) : esc(text));
  const PALETTE = ['var(--accent)', 'var(--accent2)', 'var(--warn)', 'var(--c2)', 'var(--c3)', 'var(--bad)', 'var(--c1)', 'var(--muted)'];
  const store = { get: (k, d) => { try { const v = localStorage.getItem(`${APP.slug || 'bracket'}.${k}`); return v == null ? d : v; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`${APP.slug || 'bracket'}.${k}`, v); } catch { /* blocked */ } } };

  // ---------- toast, modal ---------------------------------------------------------
  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast'); if (!t) return; t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }
  function openModal(html) { $('#modalCard').innerHTML = html; $('#modal').hidden = false; return $('#modalCard'); }
  function closeModal() { const m = $('#modal'); if (m) m.hidden = true; }

  // ---------- tables, tiles, small charts ------------------------------------------
  /** Sortable, filterable table. cols: [{ key, label, num, render, sortVal, cls }] */
  function makeTable(rows, cols, { onRow, search, defaultSort, short } = {}) {
    let sortKey = defaultSort ? defaultSort.key : null, asc = defaultSort ? defaultSort.asc !== false : true, q = '';
    const wrap = el(`<div class="table-wrap ${short ? 'short' : ''}"></div>`);
    const render = () => {
      let data = rows;
      if (q && search) { const lq = q.toLowerCase(); data = rows.filter(r => search(r).toLowerCase().includes(lq)); }
      if (sortKey) {
        const c = cols.find(x => x.key === sortKey);
        const val = r => c.sortVal ? c.sortVal(r) : r[sortKey];
        data = [...data].sort((a, b) => { const va = val(a), vb = val(b); if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }); return asc ? r : -r; });
      }
      const head = cols.map(c => `<th class="${c.num ? 'num' : ''} ${c.key === sortKey ? 'sorted' + (asc ? ' asc' : '') : ''}" data-key="${c.key}">${esc(c.label)}</th>`).join('');
      const body = data.length ? data.map((r, i) => `<tr class="${onRow ? 'clickable' : ''}" data-i="${i}">${cols.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="empty">Nothing here.</td></tr>`;
      wrap.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      wrap.querySelectorAll('th').forEach(th => th.onclick = () => { const k = th.dataset.key; if (sortKey === k) asc = !asc; else { sortKey = k; asc = true; } render(); });
      if (onRow) wrap.querySelectorAll('tbody tr').forEach(tr => tr.onclick = (ev) => { if (ev.target.closest('button,a,input,select')) return; onRow(data[Number(tr.dataset.i)]); });
      wrap.dispatchEvent(new CustomEvent('count', { detail: data.length }));
    };
    render();
    return { node: wrap, setQuery: v => { q = v; render(); }, rerender: render };
  }
  function searchToolbar(table, total, extra = '') {
    const tb = el(`<div class="toolbar"><input type="search" placeholder="Filter…"><span class="muted small count"></span><span class="grow"></span>${extra}</div>`);
    const cnt = $('.count', tb);
    const upd = n => cnt.textContent = `${n.toLocaleString()} of ${total.toLocaleString()}`;
    upd(total);
    table.node.addEventListener('count', e => upd(e.detail));
    $('input', tb).oninput = e => table.setQuery(e.target.value);
    return tb;
  }
  const tile = (cls, label, value, sub = '', id = '') => `<div class="tile ${cls}" ${id ? `id="${id}"` : ''}><div class="label">${label}</div><div class="value" title="${esc(String(value).replace(/<[^>]+>/g, ''))}">${value}</div><div class="sub">${sub}</div></div>`;
  const linkTile = (href, html) => `<a href="${href}" class="tilelink">${html}</a>`;
  function sparkline(values, { max = null, min = 0 } = {}) {
    const v = values.filter(x => x != null);
    if (v.length < 2) return '<svg class="spark" viewBox="0 0 100 44" preserveAspectRatio="none"></svg>';
    const hi = max != null ? max : Math.max(...v) * 1.05 || 1, lo = min;
    const pts = values.map((x, i) => x == null ? null : [i / (values.length - 1) * 100, 42 - (Math.min(Math.max(x, lo), hi) - lo) / (hi - lo) * 40]).filter(Boolean);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 100 44" preserveAspectRatio="none"><path class="fill" d="${d} L${pts[pts.length - 1][0].toFixed(1)} 44 L${pts[0][0].toFixed(1)} 44 Z"></path><path d="${d}"></path></svg>`;
  }
  const meter = (pct, warn = 80, bad = 92) => `<div class="meter ${pct >= bad ? 'bad' : pct >= warn ? 'warn' : ''}"><div style="width:${Math.min(100, pct || 0)}%"></div></div>`;
  const RANGE_LABEL = { '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', '1y': '1 year' };
  const rangePicker = (cur, id = 'rangeSel') => `<select id="${id}" class="small">${Object.entries(RANGE_LABEL).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  /** Align several bucketed series on one time axis so Cards.series can hover across them. */
  function alignSeries(from, to, bucket, sets) {
    const t0 = Math.floor(from / bucket) * bucket;
    const ts = []; for (let t = t0; t <= to; t += bucket) ts.push(t);
    return sets.map(s => { const m = new Map(s.points.map(p => [Math.floor(p.t / bucket) * bucket, p.y])); return { name: s.name, color: s.color, points: ts.map(t => ({ t, y: m.has(t) ? m.get(t) : null })) }; });
  }

  // ---------- theme -------------------------------------------------------------------
  const THEMES = [['', 'Graphite (default)'], ['midnight', 'Midnight blue'], ['obsidian', 'Obsidian'], ['forest', 'Forest'], ['rose', 'Rose quartz'], ['lavender', 'Lavender'], ['gunmetal', 'Gunmetal'], ['crimson', 'Crimson steel']];
  function applyTheme(name) {
    if (name) document.documentElement.dataset.theme = name; else delete document.documentElement.dataset.theme;
    try { const k = `${APP.slug || 'bracket'}.theme`; if (name) localStorage.setItem(k, name); else localStorage.removeItem(k); } catch { /* storage blocked */ }
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1115';
  }
  const currentTheme = () => { try { return localStorage.getItem(`${APP.slug || 'bracket'}.theme`) || ''; } catch { return ''; } };

  // ---------- account, roles, router ---------------------------------------------------
  let me = { role: 'guest', guest: true, username: null, available: false };
  const isAdmin = () => me.role === 'admin';
  const isGuest = () => me.role === 'guest';
  async function loadMe() {
    try { me = await api().security.me(); } catch { /* pre-login */ }
    if (!me.available) me = { ...me, role: 'admin', guest: false }; // desktop app: the machine's user
    document.body.classList.remove('role-admin', 'role-standard', 'role-guest');
    document.body.classList.add('role-' + (me.role || 'guest'));
    const line = $('#accountLine');
    if (line) {
      if (!me.available) line.hidden = true;
      else { line.hidden = false; line.innerHTML = me.guest ? `Viewing as guest · <a href="#" id="signInLink">Sign in</a>` : `Signed in as <b>${esc(me.username || '')}</b> (${me.role}) · <a href="#" id="signOutLink">Sign out</a>`; }
      if ($('#signInLink')) $('#signInLink').onclick = e => { e.preventDefault(); api().signIn(); };
      if ($('#signOutLink')) $('#signOutLink').onclick = e => { e.preventDefault(); api().logout(); };
    }
    $$('.sidebar a[data-roles]').forEach(a => { a.hidden = !a.dataset.roles.split(',').includes(me.role); });
  }
  const views = {};
  const navRoles = {};
  let currentView = null, config = {};
  async function route() {
    const hash = location.hash.slice(1) || config.home || 'dashboard';
    let [name, ...rest] = hash.split('/');
    const arg = rest.length ? rest.join('/') : undefined;
    if (!views[name]) name = config.home || Object.keys(views)[0];
    if (navRoles[name] && !navRoles[name].includes(me.role)) name = config.home || Object.keys(views)[0];
    currentView = name;
    $$('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
    const v = view();
    if (!v.children.length || v.dataset.view !== name) v.innerHTML = '<div class="empty">Loading…</div>';
    v.dataset.view = name;
    try { await views[name](arg ? decodeURIComponent(arg) : undefined); }
    catch (e) { v.innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`; }
  }
  /** Sidebar from a spec: [{ group, items: [{ view, label, icon, pill, roles: ['admin','standard','guest'], href }] }] */
  function renderNav(spec) {
    const nav = $('#sidebar'); if (!nav) return;
    const logo = APP.logo ? `<img class="logo-img" src="${esc(APP.logo)}" alt="">` : '<span class="logo">▣</span> ';
    let html = `<div class="brand">${logo}${esc(APP.name || '')}</div>`;
    for (const g of spec) {
      if (g.group) html += `<div class="navgroup">${esc(g.group)}</div>`;
      for (const it of g.items) {
        const roles = it.roles || ['admin', 'standard'];
        navRoles[it.view] = roles;
        html += `<a href="${it.href || '#' + it.view}" data-view="${esc(it.view)}" data-roles="${roles.join(',')}"><i>${it.icon || '•'}</i>${esc(it.label)}${it.pill ? ` <span class="pill ${it.pillClass || ''}" id="${esc(it.pill)}" hidden${it.pillTitle ? ` title="${esc(it.pillTitle)}"` : ''}></span>` : ''}</a>`;
      }
    }
    html += `<div class="spacer"></div><div class="tiny muted" id="accountLine" hidden style="padding:6px 10px"></div><div class="scanbox" id="navFooter">${config.footer || ''}</div><div class="version muted tiny" id="versionLine"></div>`;
    nav.innerHTML = html;
    $$('.sidebar a').forEach(a => a.addEventListener('click', closeNav));
    const brand = $('#topBrand'); if (brand) brand.innerHTML = `${logo}${esc(APP.name || '')}`;
  }
  /** Set a sidebar pill: a number (hidden when 0), text, or null to hide. */
  function setPill(id, value, cls) { const p = $('#' + id); if (!p) return; if (value == null || value === 0 || value === '') { p.hidden = true; return; } p.hidden = false; p.textContent = value; if (cls != null) p.className = 'pill ' + cls; }
  const closeNav = () => document.body.classList.remove('nav-open');

  // ---------- kit pages ------------------------------------------------------------------
  const pages = {};
  pages.security = async () => {
    const A = api(), v = view();
    const st = await A.security.status();
    if (!st.available) { v.innerHTML = `<h1>Security</h1><div class="card"><p>Accounts, sessions, two-factor codes and HTTPS belong to the web server. This desktop app has no sign-in: whoever uses this machine owns it. Run the web server on a Pi or another always-on machine and open the same page there to manage access.</p></div>`; return; }
    if (me.role !== 'admin') { v.innerHTML = '<h1>Security</h1><div class="card"><p>Only admins manage security. You can change your own password here.</p><div class="field"><label>Current</label><input type="password" id="pwCur"></div><div class="field"><label>New (8+ chars)</label><input type="password" id="pwNew"></div><div class="inline"><button class="primary" id="pwChange">Change password</button></div></div>'; $('#pwChange').onclick = async () => { try { await A.security.changePassword($('#pwCur').value, $('#pwNew').value); toast('Password changed'); } catch (e) { toast(e.message, true); } }; return; }
    const pill = $('#secPill'); if (pill) { const bad = st.checks.filter(c => !c.ok && c.level === 'bad').length; setPill('secPill', bad, 'bad'); }
    const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
    const EVENT_TEXT = { login: 'Signed in', login_failed: 'Failed sign-in', login_blocked: 'Blocked (locked out)', ip_locked: 'Address locked out', logout: 'Signed out', reauth: 'Password re-entered', reauth_failed: 'Re-entry failed', sensitive_action: 'Sensitive action', password_changed: 'Password changed', password_change_failed: 'Password change refused', '2fa_enabled': '2FA turned on', '2fa_disabled': '2FA turned off', options_changed: 'Options changed', session_revoked: 'Session revoked', sessions_revoked: 'Other sessions revoked', tls_enabled: 'HTTPS turned on', refused_non_lan: 'Refused: outside LAN', cross_origin_refused: 'Refused: cross-origin', user_added: 'User added', user_deleted: 'User deleted', role_changed: 'Role changed', password_reset: 'Password reset', forbidden: 'Refused: not allowed', status_key: 'Status key', status_refused: 'Refused: bad status key', webhook_changed: 'Webhook changed' };
    const evClass = (e) => /failed|blocked|locked|refused|forbidden/.test(e) ? 'bad' : /sensitive|changed|revoked|disabled|reset|deleted/.test(e) ? 'warn' : '';
    const slug = APP.slug || 'bracket';
    v.innerHTML = `<h1>Security</h1>
      <p class="muted">Web server on ${st.https || st.proxyHttps ? 'HTTPS' : 'HTTP'} port ${st.port} · ${st.sessions.length} active session${st.sessions.length === 1 ? '' : 's'} · ${st.failedLogins24h} failed sign-in${st.failedLogins24h === 1 ? '' : 's'} in 24 h · ${st.banned.length} address${st.banned.length === 1 ? '' : 'es'} locked out</p>
      <div class="checks">${st.checks.map(c => `<div class="check ${c.ok ? '' : c.level}"><div class="dot"></div><div><b>${esc(c.name)}</b><span>${esc(c.detail)}</span></div></div>`).join('')}</div>
      <div class="grid2" style="margin-top:14px">
        <div class="card"><h3>Password</h3>
          <div class="field"><label>Current</label><input type="password" id="pwCur" autocomplete="current-password"></div>
          <div class="field"><label>New (${st.limits.minPassword}+ chars)</label><input type="password" id="pwNew" autocomplete="new-password"></div>
          <div class="field"><label>Repeat</label><input type="password" id="pwNew2" autocomplete="new-password"></div>
          <div class="inline"><button class="primary" id="pwChange">Change password</button><span class="muted tiny">Signs out every other session.</span></div>
          <h3 style="margin-top:16px">Options</h3>
          <div class="field"><label>${T('lan-only', 'LAN only')}</label><input type="checkbox" id="optLan" ${st.lanOnly ? 'checked' : ''}><div class="hint">Refuse connections from outside private address ranges. Leave on unless you know why.</div></div>
          <div class="field"><label>Idle sign-out</label><div class="inline"><input type="number" id="optIdle" min="0" max="10080" value="${st.idleMinutes}" style="width:90px"> <span class="muted">minutes (0 = off)</span><button class="small" id="optIdleSave">Save</button></div></div>
          <div class="field"><label>${T('guest', 'Guest access')}</label><input type="checkbox" id="optGuest" ${st.guestEnabled ? 'checked' : ''}><div class="hint">Anyone on the LAN can open the pages the guest role allows without signing in.</div></div>
          ${st.guestEnabled && window.qrSvg ? `<div class="field"><label>Guest link</label><div class="inline" style="align-items:flex-start;gap:14px"><div class="qrbox">${window.qrSvg(location.origin + '/', { size: 132, label: 'Guest link' })}</div><div class="muted tiny">Scan to open <span class="mono">${esc(location.origin)}</span> on a phone.</div></div></div>` : ''}
          <div class="inline"><button id="optSave">Save options</button></div>
          <h3 style="margin-top:16px">Users</h3>
          <table><thead><tr><th>User</th><th>Role</th><th>Last sign-in</th><th>Sessions</th><th></th></tr></thead><tbody>${st.users.map(u => `<tr><td><b>${esc(u.username)}</b>${st.me && u.username === st.me.username ? ' <span class="badge ok">you</span>' : ''}</td><td><select class="small uRole" data-u="${esc(u.username)}"><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option><option value="standard" ${u.role === 'standard' ? 'selected' : ''}>standard</option></select></td><td class="muted">${u.lastLogin ? ago(u.lastLogin) : 'never'}</td><td>${u.sessions}</td><td class="nowrap"><button class="small uReset" data-u="${esc(u.username)}">Reset password</button> <button class="small uDel" data-u="${esc(u.username)}">✕</button></td></tr>`).join('')}</tbody></table>
          <div class="inline" style="margin-top:8px"><input type="text" id="nuName" placeholder="username" style="width:130px" autocomplete="off"><input type="password" id="nuPw" placeholder="password (8+)" style="width:150px" autocomplete="new-password"><select id="nuRole"><option value="standard">standard</option><option value="admin">admin</option></select><button class="primary" id="nuAdd">Add user</button></div>
          <p class="muted tiny" style="margin:6px 0 0"><b>admin</b>: everything. <b>standard</b>: ${esc(config.standardRoleText || 'every page read-only, their own password and preferences; no settings, no security.')}</p>
        </div>
        <div class="card"><h3>${T('two-factor', 'Two-factor codes')}&nbsp;${st.totpEnabled ? '<span class="right ok">on</span>' : '<span class="right muted">off</span>'}</h3>
          ${st.totpEnabled
            ? `<p>Sign-in requires your password and a 6-digit code from your authenticator app.</p><div class="field"><label>Password</label><input type="password" id="totpPw"></div><div class="inline"><button class="danger" id="totpOff">Turn off 2FA</button></div>`
            : `<p class="muted">Adds a code from Google Authenticator, Aegis, Bitwarden, 1Password or any TOTP app. Even a leaked password then cannot sign in.</p><div id="totpBox"><button class="primary" id="totpStart">Set up 2FA</button></div>`}
          <h3 style="margin-top:16px">HTTPS ${st.https || st.proxyHttps ? '<span class="right ok">on</span>' : '<span class="right muted">off</span>'}</h3>
          ${st.https
            ? `<p class="muted">Traffic between browsers and this server is encrypted with a self-signed certificate. Each device warns once until the certificate is installed on it.</p><div class="inline"><a href="tls/${esc(slug)}-cert.crt" download="${esc(slug)}-cert.crt"><button>Download certificate</button></a></div>`
            : st.proxy
              ? `<p class="muted">This app sits behind a reverse proxy on its machine (Caddy). ${st.proxyHttps ? 'The proxy terminates HTTPS with its own certificate; there is nothing to turn on here.' : 'The proxy is passing plain HTTP: add a <span class="mono">tls internal</span> line to its site block instead of turning HTTPS on here.'}</p>`
              : `<p class="muted">Encrypts the traffic between browsers and this server with a self-signed certificate made here, for every name and address the server answers to. The service restarts on the same port; sign-in sessions are kept.</p><div class="inline"><button class="primary" id="tlsOn" ${st.opensslAvailable ? '' : 'disabled title="openssl is not installed on the server"'}>Turn on HTTPS</button></div>`}
          ${st.proxy ? '' : `<details style="margin-top:8px"><summary class="muted tiny" style="cursor:pointer">Removing the browser warning: install the certificate once per device</summary><div class="tiny" style="margin-top:6px;line-height:1.6">
            <b>Windows</b>: download it, double-click the .crt → Install Certificate → Local Machine → Place all certificates in the following store → <i>Trusted Root Certification Authorities</i>. Restart the browser.<br>
            <b>Android</b>: Settings → Security → Encryption &amp; credentials → Install a certificate → <i>CA certificate</i> → pick the file.<br>
            <b>iPhone / iPad</b>: open the download in Safari, allow the profile, install it under Settings → General → VPN &amp; Device Management, then switch it on under General → About → Certificate Trust Settings.</div></details>`}
          <h3 style="margin-top:16px">${T('session', 'Sessions')}</h3>
          <table><thead><tr><th>User</th><th>Where</th><th>Browser</th><th>Last seen</th><th></th></tr></thead><tbody>${st.sessions.map(s => `<tr><td>${esc(s.user || '')} <span class="muted tiny">${esc(s.role || '')}</span></td><td>${esc(s.ip || '')}${s.current ? ' <span class="badge ok">this</span>' : ''}</td><td class="muted tiny" title="${esc(s.ua)}">${esc((s.ua || '').replace(/^Mozilla\/5\.0 /, '').slice(0, 48))}</td><td>${ago(s.lastSeen)}</td><td>${s.current ? '' : `<button class="small revoke" data-id="${s.id}">Sign out</button>`}</td></tr>`).join('')}</tbody></table>
          <div class="inline" style="margin-top:8px"><button id="revokeOthers" ${st.sessions.length > 1 ? '' : 'disabled'}>Sign out other sessions</button><button id="logoutBtn">Sign out here</button></div>
        </div>
      </div>
      <h2>Audit log</h2>
      <div class="card"><table><thead><tr><th>When</th><th>Event</th><th>Address</th><th>Detail</th></tr></thead><tbody>${st.events.map(e => `<tr><td class="muted">${fmtDate(Date.parse(e.ts))}</td><td class="${evClass(e.event)}">${esc(EVENT_TEXT[e.event] || e.event)}</td><td>${esc(e.ip || '')}</td><td class="muted">${esc(e.detail || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No events yet.</td></tr>'}</tbody></table>
      <p class="muted tiny">Lockout after ${st.limits.lockFails} failures in ${st.limits.lockMinutes} min · security changes ask for the password again after ${st.limits.reauthMinutes} min · sessions last ${st.limits.sessionDays} days · full log in ${esc(st.dataDir)}/security.log</p></div>`;
    const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); pages.security(); } catch (e) { toast(e.message, true); } };
    $('#pwChange').onclick = () => { if ($('#pwNew').value !== $('#pwNew2').value) return toast('New passwords differ', true); act(() => A.security.changePassword($('#pwCur').value, $('#pwNew').value), 'Password changed'); };
    const saveOptions = () => act(() => A.security.setOptions({ lanOnly: $('#optLan').checked, idleMinutes: Number($('#optIdle').value), guestEnabled: $('#optGuest').checked }), 'Options saved');
    $('#optSave').onclick = saveOptions; $('#optIdleSave').onclick = saveOptions;
    if ($('#tlsOn')) $('#tlsOn').onclick = () => { if (!confirm('Create a certificate and restart on HTTPS? Every browser will warn once until the certificate is installed on it.')) return; act(async () => { const r = await A.security.tlsEnable(); const target = `https://${location.hostname}:${r.port}/#security`; toast(`Certificate created. Restarting on HTTPS; this page will open ${target} in a few seconds.`); setTimeout(() => { location.href = target; }, 7000); }); };
    $('#nuAdd').onclick = () => act(() => A.security.addUser($('#nuName').value, $('#nuPw').value, $('#nuRole').value), 'User added');
    $$('.uRole').forEach(s => { s.onchange = () => act(() => A.security.setRole(s.dataset.u, s.value), 'Role changed'); });
    $$('.uReset').forEach(b => { b.onclick = () => { const pw = prompt(`New password for ${b.dataset.u} (8+ characters). They will be signed out everywhere.`); if (pw) act(() => A.security.resetPassword(b.dataset.u, pw), 'Password reset'); }; });
    $$('.uDel').forEach(b => { b.onclick = () => { if (confirm(`Delete user ${b.dataset.u}?`)) act(() => A.security.deleteUser(b.dataset.u), 'User deleted'); }; });
    $('#revokeOthers').onclick = () => act(() => A.security.revokeOthers(), 'Other sessions signed out');
    $('#logoutBtn').onclick = () => A.logout();
    $$('.revoke').forEach(b => { b.onclick = () => act(() => A.security.revoke(b.dataset.id), 'Session signed out'); });
    if ($('#totpStart')) $('#totpStart').onclick = async () => { try {
      const r = await A.security.totpSetup();
      $('#totpBox').innerHTML = `<p>1. In your authenticator app tap <b>+</b> → <b>Scan a QR code</b>:</p><div class="qrbox">${window.qrSvg ? window.qrSvg(r.url, { size: 184, label: 'Two-factor setup code' }) : ''}</div><p class="muted tiny" style="margin-top:8px">No camera? Enter this setup key (time-based, 6 digits):</p><div class="secret">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</div><p>2. Enter the 6-digit code it shows:</p><div class="inline"><input type="text" id="totpCode" inputmode="numeric" placeholder="000000" style="width:120px"><button class="primary" id="totpConfirm">Turn on 2FA</button></div>`;
      $('#totpConfirm').onclick = () => act(() => A.security.totpEnable($('#totpCode').value), 'Two-factor codes are on');
    } catch (e) { toast(e.message, true); } };
    if ($('#totpOff')) $('#totpOff').onclick = () => act(() => A.security.totpDisable($('#totpPw').value), 'Two-factor codes are off');
  };

  let sysTimer = null;
  pages.system = async () => {
    const A = api(), v = view();
    const s = await A.sys.stats();
    const h = s.history, last = (k) => h.map(x => x[k]);
    const health = s.health || { level: 'ok', reasons: [] };
    setPill('sysPill', health.level === 'ok' ? null : (health.level === 'bad' ? '!' : '•'), health.level === 'bad' ? 'bad' : 'warn');
    const pi = s.pi;
    const tempTile = pi && pi.tempC != null ? tile(pi.tempC >= 80 ? 'badt' : pi.tempC >= 70 ? 'warnt' : '', T('soc-temp', 'SoC temperature'), `${pi.tempC.toFixed(1)} °C`, `${pi.clockMHz ? pi.clockMHz + ' MHz' : ''}${pi.voltage ? ' · ' + pi.voltage.toFixed(2) + ' V' : ''}`) : '';
    const thr = pi && pi.throttled;
    const thrTile = thr ? tile(thr.now ? 'badt' : thr.ever ? 'warnt' : 'okt', T('throttling', 'Power & throttling'), thr.now ? 'Throttled now' : thr.ever ? 'Throttled earlier' : 'Healthy', thr.flags.length ? esc(thr.flags.join(' · ')) : 'no under-voltage or frequency capping since boot') : '';
    const dataDisk = s.disks[0];
    v.innerHTML = `<h1>System</h1>
      <p class="muted">${esc(s.host.hostname)} · ${esc(pi ? pi.model : s.host.platform)} · ${T('uptime', 'up')} ${fmtUptime(s.host.uptimeS)} · ${esc(APP.name || 'service')} up ${fmtUptime(s.service.uptimeS)} · refreshes every ${Math.round(s.sampleMs / 1000)} s</p>
      <div class="tiles">
        ${tile(health.level === 'ok' ? 'okt' : health.level + 't', T('health', 'Health'), `<span class="health-${health.level}">${health.level === 'ok' ? 'All good' : health.level === 'warn' ? 'Attention' : 'Problem'}</span>`, health.reasons.length ? esc(health.reasons.join(' · ')) : 'no rule triggered')}
        ${tempTile}${thrTile}
        ${tile('', T('cpu', 'CPU'), s.cpu.pct == null ? '…' : `${s.cpu.pct}%`, `${s.cpu.cores} ${T('cores', 'cores')} · ${T('load', 'load')} ${s.cpu.load.join(' / ')}`)}
        ${tile('', T('memory', 'Memory'), `${s.memory.pct}%`, `${fmtBytes(s.memory.used)} of ${fmtBytes(s.memory.total)}${s.memory.swap ? ` · swap ${fmtBytes(s.memory.swap.used)}` : ''}`)}
        ${tile(dataDisk.ok ? (dataDisk.pct >= 92 ? 'badt' : dataDisk.pct >= 80 ? 'warnt' : '') : 'badt', T('disk', 'Data disk'), dataDisk.ok ? `${dataDisk.pct}%` : 'unreadable', dataDisk.ok ? `${fmtBytes(dataDisk.free)} free · database ${fmtBytes(s.service.dbBytes || 0)}` : esc(dataDisk.error || ''))}
        ${tile('', T('network', 'Network'), s.network.rate ? `↓ ${fmtRate(s.network.rate.rxBps)}` : (s.network.interfaces[0] ? esc(s.network.interfaces[0].address) : '—'), s.network.rate ? `↑ ${fmtRate(s.network.rate.txBps)} · ${esc(s.network.interfaces.map(i => `${i.name} ${i.address}`).join(', '))}` : esc(s.network.interfaces.map(i => i.name).join(', ')))}
      </div>
      <div class="grid2">
        <div class="card"><h3>CPU <span class="right">${s.cpu.pct == null ? '' : s.cpu.pct + '%'}</span></h3>${sparkline(last('cpu'), { max: 100 })}<div class="cores">${(s.cpu.perCore || []).map(p => `<div title="${p}%"><div style="height:${p}%"></div></div>`).join('')}</div><div class="muted tiny" style="margin-top:6px">${esc(s.cpu.model || '')}</div></div>
        <div class="card"><h3>Memory <span class="right">${s.memory.pct}%</span></h3>${sparkline(last('mem'), { max: 100 })}${meter(s.memory.pct)}<div class="muted tiny" style="margin-top:6px">Process ${fmtBytes(s.service.rss)} · Node ${esc(s.service.node)} · pid ${s.service.pid}${s.service.busy ? ' · <b>busy</b>' : ''}</div></div>
        ${pi && pi.tempC != null ? `<div class="card"><h3>Temperature <span class="right">${pi.tempC.toFixed(1)} °C</span></h3>${sparkline(last('temp'), { min: 30, max: 90 })}${meter(pi.tempC, 70, 80)}<div class="muted tiny" style="margin-top:6px">Pi firmware soft-limits at 80 °C and throttles at 85 °C</div></div>` : ''}
        ${s.network.rate ? `<div class="card"><h3>Network <span class="right">↓ ${fmtRate(s.network.rate.rxBps)} · ↑ ${fmtRate(s.network.rate.txBps)}</span></h3>${sparkline(last('rx'))}<div class="muted tiny">This machine's own interfaces</div></div>` : ''}
      </div>
      <h2>Storage</h2>
      <div class="card"><table class="kv">${s.disks.map(d => `<tr><td>${esc(d.label)}</td><td>${d.ok ? `${fmtBytes(d.free)} free of ${fmtBytes(d.total)} (${d.pct}% used)${meter(d.pct, 90, 97)}` : `<span class="bad">not reachable: ${esc(d.error || '')}</span>`}<div class="muted tiny mono">${esc(d.path)}</div></td></tr>`).join('')}</table></div>`;
    clearInterval(sysTimer);
    sysTimer = setInterval(() => { if (currentView === 'system') pages.system(); else clearInterval(sysTimer); }, s.sampleMs);
  };

  pages.log = async () => {
    const A = api(), v = view();
    const lines = await A.logTail(500);
    v.innerHTML = `<h1>Log</h1><div class="toolbar"><button id="logRefresh">Refresh</button><span class="muted small">Newest at the bottom · ${lines.length} line(s)${config.logHint ? ' · ' + esc(config.logHint) : ''}</span></div><div class="card logview mono" style="white-space:pre-wrap;max-height:70vh;overflow:auto" id="logBox">${lines.map(l => `<div class="${/fail|error|cannot|refused|could not/i.test(l) ? 'bad' : ''}">${esc(l)}</div>`).join('')}</div>`;
    const box = $('#logBox'); box.scrollTop = box.scrollHeight;
    $('#logRefresh').onclick = () => pages.log();
  };

  /** About page. opts: { blurb, rows: [[label, html]], credits: [[name, html]], runtime: [[label, html]] } */
  pages.about = (opts = {}) => async () => {
    const A = api(), v = view();
    const info = await A.appInfo();
    const dbLine = info.db ? Object.entries(info.db).filter(([k]) => !['file', 'size', 'version'].includes(k)).map(([k, n]) => `${fmtN(n)} ${k}`).join(' · ') : '';
    v.innerHTML = `<h1>About</h1>
      <div class="grid2">
        <div class="card">
          <div class="inline">${APP.logo ? `<img src="${esc(APP.logo)}" alt="" style="width:56px;height:56px">` : '<span class="about-logo">▣</span>'}<div><div style="font-size:20px;font-weight:700">${esc(APP.name || '')} <span class="muted">v${esc(info.version)}</span></div><div class="muted">${esc(APP.tagline || '')}</div></div></div>
          ${opts.blurb ? `<p class="muted" style="margin:12px 0 0">${opts.blurb}</p>` : ''}
          <table class="kv" style="margin-top:12px">
            <tr><td>Author</td><td>${esc(APP.author || 'AxialForge')}</td></tr><tr><td>License</td><td>${esc(APP.license || 'MIT')}</td></tr>
            ${info.repo ? `<tr><td>Source &amp; releases</td><td><a href="${esc(info.repo)}" target="_blank" rel="noopener">${esc(info.repo)}</a></td></tr>` : ''}
            ${info.kit ? `<tr><td>Built on</td><td>Bracket kit ${esc(info.kit)}</td></tr>` : ''}
            ${(opts.rows || []).map(([k, h]) => `<tr><td>${esc(k)}</td><td>${h}</td></tr>`).join('')}
          </table>
        </div>
        <div class="card">
          <h3>Updates</h3>
          <div class="status-line" id="updLine">${info.web ? 'Press Check for updates.' : (info.updateStatus && info.updateStatus.state !== 'idle' ? esc(JSON.stringify(info.updateStatus)) : 'Updates install silently on the next start; press Check to look now.')}</div>
          <div class="inline" style="margin-top:10px"><button class="primary" id="chkUpd">Check for updates</button></div>
          <h3 style="margin-top:16px">Runtime</h3>
          <table class="kv">
            <tr><td>Node</td><td>${esc(info.node)}${info.electron ? ` · Electron ${esc(info.electron)}` : ''}</td></tr><tr><td>Host</td><td>${esc(info.hostname)} · ${esc(info.platform)} · ${info.cpus} cores</td></tr>
            ${(opts.runtime || []).map(([k, h]) => `<tr><td>${esc(k)}</td><td>${h}</td></tr>`).join('')}
            <tr><td>Data folder</td><td class="mono">${esc(info.dataDir)}</td></tr>
            ${info.db ? `<tr><td>Database</td><td>${fmtBytes(info.db.size)}${dbLine ? ' · ' + dbLine : ''}</td></tr>` : ''}
          </table>
        </div>
      </div>
      ${opts.credits ? `<h2>Credits</h2><div class="card"><table class="kv">${opts.credits.map(([k, h]) => `<tr><td>${esc(k)}</td><td>${h}</td></tr>`).join('')}<tr><td>Bracket</td><td>App shell, security model, cards and dashboard · MIT, AxialForge</td></tr><tr><td>SQLite</td><td>Storage via Node's built-in module · public domain</td></tr></table></div>` : ''}`;
    $('#chkUpd').onclick = async () => { $('#updLine').textContent = 'Checking…'; const r = await A.update.check(); $('#updLine').textContent = r.message || r.state; setPill('updatePill', r.state === 'available' ? 'update' : null, 'accent'); };
  };

  // ---------- settings sections (html + wire) --------------------------------------------
  const sections = {};
  const chk = (id, on) => `<input type="checkbox" id="${id}" ${on ? 'checked' : ''}>`;
  /** Notifications: webhook + e-mail + event switches. events: { key: label } */
  sections.notifications = (s, events) => ({
    html: `<div class="section-head"><h2>Notifications</h2></div>
    <div class="card">
      <div class="field"><label>Webhook URL</label><input type="text" id="nWeb" value="${esc(s.notify.webhookUrl)}" placeholder="http://homeassistant.local:8123/api/webhook/${esc(APP.slug || 'app')}"><div class="hint">Gets a JSON POST: { app, event, title, message, at }. Works with Home Assistant, ntfy, Discord and the like.</div></div>
      <div class="field"><label>E-mail</label><div class="inline">${chk('mOn', s.notify.email.enabled)} <input type="text" id="mHost" value="${esc(s.notify.email.host)}" placeholder="smtp.gmail.com" style="width:170px"> port <input type="number" id="mPort" value="${s.notify.email.port}" style="width:70px"> <label class="inline small">${chk('mSecure', s.notify.email.secure)} TLS on connect (465)</label></div></div>
      <div class="field"><label></label><div class="inline"><input type="text" id="mUser" value="${esc(s.notify.email.user)}" placeholder="user" style="width:170px"><input type="password" id="mPass" value="${esc(s.notify.email.pass)}" placeholder="app password" style="width:150px"><input type="text" id="mTo" value="${esc(s.notify.email.to)}" placeholder="to" style="width:190px"></div></div>
      ${events && Object.keys(events).length ? `<div class="field"><label>Tell me when</label><div>${Object.entries(events).map(([k, v]) => `<label class="inline small" style="display:flex"><input type="checkbox" class="nEv" value="${k}" ${s.notify.events[k] ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>` : ''}
      <div class="field"><label>Summary at</label><input type="time" id="nDaily" value="${esc(s.notify.dailyTime || '08:00')}" style="width:120px"></div>
      <div class="inline"><button class="primary" id="nSave">Save</button><button id="nTest">Send a test</button></div>
    </div>`,
    wire: (save) => {
      $('#nSave').onclick = () => save({ notify: { webhookUrl: $('#nWeb').value.trim(), dailyTime: $('#nDaily').value, email: { enabled: $('#mOn').checked, host: $('#mHost').value.trim(), port: Number($('#mPort').value), secure: $('#mSecure').checked, user: $('#mUser').value.trim(), pass: $('#mPass').value, from: $('#mUser').value.trim(), to: $('#mTo').value.trim() }, events: Object.fromEntries($$('.nEv').map(x => [x.value, x.checked])) } });
      $('#nTest').onclick = async () => { try { const r = await api().notifyTest(); const parts = [r.webhook ? `webhook ${r.webhook.ok ? 'ok' : 'failed: ' + (r.webhook.error || r.webhook.status)}` : null, r.email ? `e-mail ${r.email.ok ? 'sent' : 'failed: ' + r.email.error}` : null].filter(Boolean); toast(parts.length ? parts.join(' · ') : 'Nothing configured yet', !parts.length || parts.some(p => /failed/.test(p))); } catch (e) { toast(e.message, true); } };
    },
  });
  /** The Home Assistant status URL (web server only). */
  sections.homeAssistant = (text) => ({
    html: `<div class="section-head"><h2>Home Assistant</h2></div><div class="card"><p class="small">${text || 'Read-only status JSON for REST sensors:'}</p><div class="inline"><span class="mono small" id="haUrl">…</span><button class="small" id="haRotate">New key</button></div></div>`,
    wire: () => {
      api().status.info().then(r => { $('#haUrl').textContent = r.available ? r.url : 'Only on the web server.'; if (!r.available) $('#haRotate').hidden = true; }).catch(() => {});
      $('#haRotate').onclick = async () => { if (!confirm('Make a new key? The old URL stops working.')) return; try { const r = await api().status.rotate(); $('#haUrl').textContent = r.url; } catch (e) { toast(e.message, true); } };
    },
  });
  sections.appearance = () => ({
    html: `<div class="section-head"><h2>Appearance</h2></div><div class="card"><div class="field"><label>Colour theme</label><select id="theme">${THEMES.map(([k, v]) => `<option value="${k}" ${k === currentTheme() ? 'selected' : ''}>${v}</option>`).join('')}</select><div class="hint">Saved in this browser.</div></div></div>`,
    wire: () => { $('#theme').onchange = e => applyTheme(e.target.value); },
  });

  // ---------- boot -----------------------------------------------------------------------
  /** init({ nav, home, footer, standardRoleText, logHint, onReady, onTick }) */
  function init(cfg = {}) {
    config = cfg;
    renderNav(cfg.nav || []);
    $('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    const t = $('#navToggle'); if (t) t.onclick = () => document.body.classList.toggle('nav-open');
    const sh = $('#navShade'); if (sh) sh.onclick = closeNav;
    window.addEventListener('hashchange', route);
    // Scripts loaded after this one (dash.js, app.js) may not have run when a fast API reply arrives: wait for the document.
    const scriptsReady = document.readyState === 'loading' ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })) : Promise.resolve();
    Promise.all([loadMe(), scriptsReady]).then(() => { route(); if (typeof cfg.onReady === 'function') cfg.onReady(); });
    api().appInfo().then(i => { const vl = $('#versionLine'); if (vl) vl.textContent = `v${i.version}`; }).catch(() => {});
  }

  window.UI = { term: T, $, $$, esc, el, fmtN, fmtBytes, fmtGB, fmtDate, fmtTime, fmtAgo, fmtIn, fmtUptime, fmtMs, fmtRate, sevClass, PALETTE, store, toast, openModal, closeModal, makeTable, searchToolbar, tile, linkTile, sparkline, meter, RANGE_LABEL, rangePicker, alignSeries, THEMES, applyTheme, currentTheme, views, pages, sections, route, setPill, closeNav, init, me: () => me, isAdmin, isGuest, current: () => currentView, api, view };
})();
