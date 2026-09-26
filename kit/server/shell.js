'use strict';
// The web shell: a Bracket core served over HTTP(S) on the LAN, built for a Raspberry Pi behind
// Caddy but runs anywhere Node 22 does. Zero dependencies: node:http(s) serves the renderer as
// static files, POST /api/<channel> calls a core handler with a JSON array of arguments, and
// GET /api/events is a server-sent-events stream.
//
//   const shell = createWebShell({ app, createService, rootDir, roles, secrets, webHandlers, routes, csvSets });
//   shell.start();
//
// Access (security.js): accounts with admin / standard roles, optional guest mode, scrypt passwords,
// HttpOnly SameSite=Strict cookie sessions, per-IP lockout, LAN-only by default, TOTP for admins,
// re-authentication for sensitive channels, strict CSP, audit log. HTTPS: put cert.pem + key.pem in
// <data>/tls/ (or use the Security page) and the server switches to TLS. Behind a reverse proxy on
// the same machine, client addresses and the scheme come from X-Forwarded-For / X-Forwarded-Proto,
// trusted only when the socket itself is loopback.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createSecurity } = require('./security');
const { getPath, setPath } = require('../main/settings');
const { csv } = require('../main/csv');

const REDACTED = '••••';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

/** Data dir, port and host from --flags, <SLUG>_DATA/PORT/HOST environment variables, or the platform default. */
function resolveOptions({ app, argv = process.argv, env = process.env, defaultPort = 8080 } = {}) {
  const arg = (name, dflt) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
  const P = String(app.slug || 'bracket').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const dataDir = path.resolve(arg('data', env[`${P}_DATA`] || (process.platform === 'win32' ? path.join(env.APPDATA || os.homedir(), `${app.name || app.slug}-web`) : path.join(os.homedir(), '.local', 'share', app.slug))));
  return { dataDir, port: Number(arg('port', env[`${P}_PORT`] || defaultPort)), host: arg('host', env[`${P}_HOST`] || '0.0.0.0'), envPrefix: P, setPassword: argv.includes('--set-password') };
}

function createWebShell({ app, createService, rootDir, dataDir, port, host = '0.0.0.0', roles = {}, secrets = [], webHandlers = null, routes = [], csvSets = null, statusChannel = 'data:status', version = null, argv = process.argv, env = process.env }) {
  const slug = app.slug || 'bracket';
  rootDir = rootDir || path.join(__dirname, '..', '..');
  fs.mkdirSync(dataDir, { recursive: true });
  const pkg = (() => { try { return require(path.join(rootDir, 'package.json')); } catch { return {}; } })();
  version = version || pkg.version || '0.0.0';
  const kitVersion = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); } catch { return null; } })();
  const logFile = path.join(dataDir, `${slug}.log`);
  const log = (...a) => { const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`; try { fs.appendFileSync(logFile, line); } catch { /* ignore */ } process.stdout.write(line); };
  const sec = createSecurity({ dataDir, log, cookie: `${slug.replace(/[^a-z0-9]/gi, '')}_session`, issuer: app.name || slug });

  // ---- TLS (optional) ------------------------------------------------------------------
  const tlsDir = path.join(dataDir, 'tls');
  let tls = null;
  try { tls = { cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')), key: fs.readFileSync(path.join(tlsDir, 'key.pem')) }; } catch { /* plain http */ }

  // ---- core --------------------------------------------------------------------------------
  const clients = new Set(); // SSE responses
  const send = (channel, payload) => { const data = `data: ${JSON.stringify({ channel, payload })}\n\n`; for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } } };
  const svc = createService({ dataDir, log, send });

  // ---- roles -----------------------------------------------------------------------------
  const GUEST = new Set(['app:info', 'security:me', 'prefs:get', ...(roles.GUEST || [])]);
  const STANDARD = new Set([...GUEST, 'settings:get', 'sys:stats', 'db:stats', 'security:changePassword', 'prefs:set', ...(roles.STANDARD || [])]);
  const SENSITIVE = new Set(['security:tlsEnable', 'status:rotate', 'security:changePassword', 'security:totpSetup', 'security:totpEnable', 'security:totpDisable', 'security:setOptions', 'security:revokeOthers', 'security:addUser', 'security:setRole', 'security:resetPassword', 'security:deleteUser', 'settings:replace', ...(roles.SENSITIVE || [])]);
  const allowed = (role, ch) => role === 'admin' || (role === 'standard' ? STANDARD.has(ch) : GUEST.has(ch));
  // Settings may hold secrets; everyone sees them blanked and the form sends the placeholder back.
  const redactSettings = (s) => { const out = structuredClone(s); for (const p of secrets) if (getPath(out, p)) setPath(out, p, REDACTED); return out; };
  const keepSecrets = (patch) => { if (!patch) return patch; const cur = svc.settings.get(); for (const p of secrets) if (getPath(patch, p) === REDACTED) setPath(patch, p, getPath(cur, p)); return patch; };

  // ---- proxy awareness ---------------------------------------------------------------------
  const socketIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
  const proxied = (req) => !!req && isLoopback(socketIp(req)) && !!req.headers['x-forwarded-for'];
  const clientIp = (req) => { const s = socketIp(req); if (!isLoopback(s)) return s; const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, ''); return f || s; };
  const requestProto = (req) => (tls ? 'https' : proxied(req) && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '')) ? 'https' : 'http');
  const hasOpenssl = () => { try { return require('child_process').spawnSync('openssl', ['version'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch { return false; } };
  const uaShort = (ua) => { const s = String(ua || ''); const b = /(Edg|Firefox|Chrome|Safari)\/[\d.]+/.exec(s); const o = /(Windows NT [\d.]+|Android [\d.]+|iPhone OS [\d_]+|Mac OS X [\d_]+|Linux)/.exec(s); return [b ? b[1].replace('Edg', 'Edge') : null, o ? o[1].replace(/_/g, '.') : null].filter(Boolean).join(' on ') || 'browser'; };

  // Security posture checklist shown at the top of the Security page.
  function posture(req) {
    const st = sec.state;
    const checks = [];
    const add = (ok, name, detail, level = 'warn') => checks.push({ ok, name, detail, level: ok ? 'ok' : level });
    const viaProxy = proxied(req), proxyHttps = viaProxy && requestProto(req) === 'https';
    const admins = Object.values(st.users).filter(u => u.role === 'admin').length;
    add(admins > 0, 'Admin account', admins ? `${admins} admin, ${Object.keys(st.users).length - admins} standard user(s); scrypt-hashed in web.json` : `Run: sudo ${slug} --set-password`, 'bad');
    add(st.totp.enabled, 'Two-factor codes for admins', st.totp.enabled ? 'a phone code is required at admin sign-in' : 'optional: turn on below so a leaked admin password alone is not enough');
    add(st.lanOnly, 'LAN-only access', st.lanOnly ? 'connections from outside private address ranges are refused' : 'off: any address that can reach the port may try to sign in');
    add(!st.guestEnabled, 'Guest access', st.guestEnabled ? 'on: anyone on the LAN sees what the guest role allows' : 'off: every page needs an account');
    add(!!tls || proxyHttps, 'HTTPS', tls ? `serving TLS on port ${port} from <data>/tls` : proxyHttps ? 'terminated by the reverse proxy in front of this app; leave the switch below off' : viaProxy ? 'the reverse proxy passes plain HTTP; give its site block a tls directive rather than turning HTTPS on here' : 'plain HTTP: fine on a trusted LAN; turn it on below');
    if (viaProxy) add(true, 'Reverse proxy', 'requests arrive through a proxy on this machine; client addresses are read from X-Forwarded-For (trusted from loopback only)');
    add(process.getuid ? process.getuid() !== 0 : true, 'Not running as root', process.getuid && process.getuid() === 0 ? `the service runs as root; use the installer's ${slug} user` : 'service user has no shell and no sudo', 'bad');
    try { const m = fs.statSync(path.join(dataDir, 'web.json')).mode & 0o777; add(process.platform === 'win32' || m === 0o600, 'Secrets file permissions', `web.json mode ${m.toString(8)}`); } catch { /* none */ }
    try { const m = fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777; add(process.platform === 'win32' || m === 0o600, 'Settings file permissions', `settings.json mode ${m.toString(8)}`); } catch { /* none */ }
    add(st.idleMinutes > 0, 'Idle sign-out', st.idleMinutes ? `sessions end after ${st.idleMinutes} idle minutes` : 'optional: sessions last 30 days unless signed out');
    return checks;
  }

  // ---- web-only handlers (receive { session, ip, role, req } first) ------------------------
  const repoUrl = app.repo || (pkg.repository && pkg.repository.url ? String(pkg.repository.url).replace(/\.git$/, '') : null);
  const ghRepo = repoUrl ? (/github\.com\/([^/]+\/[^/]+)/.exec(repoUrl) || [])[1] : null;
  const base = new Map([
    ['app:info', async () => ({ version, kit: kitVersion, node: process.versions.node, web: true, https: !!tls, platform: `${os.type()} ${os.release()} (${os.arch()})`, hostname: os.hostname(), cpus: os.cpus().length, dataDir, logFile, dbFile: svc.db ? svc.db.file : null, repo: repoUrl, db: svc.db ? svc.db.stats() : null, name: app.name, slug })],
    ['update:check', async () => {
      const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
      if (!ghRepo) return { state: 'error', message: 'No GitHub repository configured for this app.' };
      try {
        const token = svc.settings.get().githubToken;
        const r = await fetch(`https://api.github.com/repos/${ghRepo}/releases/latest`, { headers: { 'user-agent': `${slug}-server`, accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        const latest = String((await r.json()).tag_name || '').replace(/^v/, '');
        return newer(latest, version) ? { state: 'available', version: latest, message: `Version ${latest} is available. On the server run: ${app.updateCommand || `sudo ${slug}-update`}` } : { state: 'current', version: latest, message: `You are on the latest version (${version}).` };
      } catch (e) { return { state: 'error', message: 'Could not reach GitHub: ' + e.message }; }
    }],
    ['settings:get', () => redactSettings(svc.settings.get())],
    ['settings:set', (ctx, patch) => redactSettings(svc.handlers.get('settings:set')(keepSecrets(patch)))],
    ['settings:replace', (ctx, next) => redactSettings(svc.handlers.get('settings:replace')(keepSecrets(next)))],
    ['security:me', (ctx) => ({ available: true, guest: ctx.role === 'guest', username: ctx.session ? ctx.session.user : null, role: ctx.role, guestEnabled: sec.guestEnabled(), hasUsers: sec.hasPassword() })],
    ['security:status', (ctx) => sec.status(ctx.session, { available: true, https: !!tls, proxy: proxied(ctx.req), proxyHttps: proxied(ctx.req) && requestProto(ctx.req) === 'https', port, bindHost: host, dataDir, checks: posture(ctx.req), opensslAvailable: hasOpenssl() })],
    // Creates a self-signed certificate for every name this machine answers to, then exits so the service manager restarts it on HTTPS.
    ['security:tlsEnable', (ctx) => {
      if (tls) return { ok: true, already: true, port };
      if (proxied(ctx.req)) throw new Error('Requests reach this app through a reverse proxy on this machine. HTTPS belongs in the proxy; turning it on here would break the proxy connection.');
      if (!hasOpenssl()) throw new Error('openssl is not installed on this server (sudo apt install openssl)');
      fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
      const isIp = (h) => /^\d+(\.\d+){3}$/.test(h);
      const names = new Set(), ips = new Set();
      const hostHdr = String(ctx.req.headers.host || '').replace(/:\d+$/, '');
      for (const h of [hostHdr, os.hostname() + '.local', os.hostname()]) if (h) (isIp(h) ? ips : names).add(h.toLowerCase());
      try { const d = fs.readFileSync(`/etc/${slug}-domain`, 'utf8').trim(); if (d) names.add(d.toLowerCase()); } catch { /* no custom domain */ }
      for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) ips.add(i.address);
      const san = [...names].map(n => 'DNS:' + n).concat([...ips].map(i => 'IP:' + i)).join(',');
      const cn = [...names][0] || [...ips][0];
      const r = require('child_process').spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', '/CN=' + cn, '-addext', 'subjectAltName=' + san, '-keyout', path.join(tlsDir, 'key.pem'), '-out', path.join(tlsDir, 'cert.pem')], { encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) { try { fs.rmSync(path.join(tlsDir, 'key.pem'), { force: true }); fs.rmSync(path.join(tlsDir, 'cert.pem'), { force: true }); } catch { /* ignore */ } throw new Error('openssl failed: ' + ((r.stderr || '').trim().split('\n').pop() || (r.error && r.error.message) || 'unknown')); }
      try { fs.chmodSync(path.join(tlsDir, 'key.pem'), 0o600); fs.chmodSync(path.join(tlsDir, 'cert.pem'), 0o600); } catch { /* windows */ }
      sec.audit('tls_enabled', ctx.ip, san, ctx.session.user);
      log(`HTTPS certificate created for ${san}; restarting`);
      setTimeout(() => process.exit(0), 1500);
      return { ok: true, san, port };
    }],
    ['security:changePassword', (ctx, current, next) => { sec.changePassword(ctx.session, current, next, ctx.ip); return true; }],
    ['security:totpSetup', () => sec.totpSetup(`${os.hostname()} admin`)],
    ['security:totpEnable', (ctx, code) => sec.totpEnable(code, ctx.ip, ctx.session.user)],
    ['security:totpDisable', (ctx, password) => sec.totpDisable(ctx.session, password, ctx.ip)],
    ['security:setOptions', (ctx, opts) => { sec.setOptions(opts || {}, ctx.ip, ctx.session.user); return true; }],
    ['security:revoke', (ctx, id) => sec.revoke(id, ctx.session, ctx.ip)],
    ['security:revokeOthers', (ctx) => sec.revokeOthers(ctx.session, ctx.ip)],
    ['security:users', () => sec.listUsers()],
    ['security:addUser', (ctx, name, password, role) => sec.addUser(name, password, role, ctx.ip, ctx.session.user)],
    ['security:setRole', (ctx, name, role) => sec.setRole(name, role, ctx.ip, ctx.session.user)],
    ['security:resetPassword', (ctx, name, password) => sec.resetPassword(name, password, ctx.ip, ctx.session.user)],
    ['security:deleteUser', (ctx, name) => sec.deleteUser(name, ctx.ip, ctx.session.user)],
    ['prefs:get', (ctx) => sec.getPrefs(ctx.session ? ctx.session.user : null)],
    ['prefs:set', (ctx, patch) => { if (!ctx.session) throw new Error('Sign in to save preferences'); return sec.setPrefs(ctx.session.user, patch); }],
    ['status:info', (ctx) => { const key = sec.statusKey(false, ctx.ip, ctx.session && ctx.session.user); const h = ctx.req && ctx.req.headers.host ? ctx.req.headers.host : `${os.hostname()}.local:${port}`; return { available: true, url: `${requestProto(ctx.req)}://${h}/api/status?key=${key}` }; }],
    ['status:rotate', (ctx) => { sec.statusKey(true, ctx.ip, ctx.session.user); return base.get('status:info')(ctx); }],
    // Desktop-only channels answered honestly by the web shell, so one renderer serves both.
    ['dialog:pickFolder', () => null], ['dialog:pickFile', () => null],
    ['shell:open', () => false], ['shell:openExternal', () => false], ['shell:showItem', () => false],
    ['update:install', () => ({ ok: false })], ['update:status', () => ({ state: 'idle' })],
  ]);
  const tools = { svc, sec, log, dataDir, port, tls: () => tls, proxied, requestProto, clientIp, uaShort, redactSettings, keepSecrets, REDACTED };
  const extra = typeof webHandlers === 'function' ? webHandlers(tools) : (webHandlers || new Map());
  const web = new Map([...base, ...extra]);
  const CTX_HANDLERS = new Set(web.keys());
  const handlers = new Map([...svc.handlers, ...web]);

  // ---- http --------------------------------------------------------------------------------
  const appRenderer = path.join(rootDir, 'app', 'renderer');
  const kitRenderer = path.join(__dirname, '..', 'renderer');
  const SEC_HEADERS = {
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'cross-origin-opener-policy': 'same-origin',
    ...(tls ? { 'strict-transport-security': 'max-age=15552000' } : {}),
  };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', d => { s += d; if (s.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } }); req.on('end', () => resolve(s)); req.on('error', reject); });
  const roleOf = (req) => { const session = sec.sessionOf(req.headers.cookie); return { session, role: session ? session.role : (sec.guestEnabled() ? 'guest' : null) }; };
  const sendFile = (res, abs) => { res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' }); fs.createReadStream(abs).pipe(res); };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    try {
      if (!sec.isAllowedIp(ip)) { sec.audit('refused_non_lan', ip, url.pathname); res.writeHead(403); return res.end('LAN only'); }
      // Read-only status JSON for Home Assistant: GET /api/status?key=<status key>. No session, LAN-only still applies.
      if (url.pathname === '/api/status') {
        if (!sec.statusOk(url.searchParams.get('key') || '')) { sec.audit('status_refused', ip, 'bad key'); return json(res, 401, { ok: false, error: 'bad key' }); }
        const fn = handlers.get(statusChannel);
        return json(res, 200, fn ? await fn() : { ok: true, app: app.name, version });
      }
      const { session, role } = roleOf(req);
      // App-specific raw routes (speed tests, uploads…) run before the API and the static files.
      for (const r of routes) if (await r(req, res, url, { ...tools, ip, session, role, json, readBody, sendFile })) return;
      if (url.pathname.startsWith('/api/')) {
        const ch = decodeURIComponent(url.pathname.slice(5));
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) { sec.audit('cross_origin_refused', ip, origin); return json(res, 403, { ok: false, error: 'cross-origin request refused' }); }
        if (req.method !== 'GET' && !/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'JSON body required' });
        if (ch === 'login' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          const r = sec.login(ip, req.headers['user-agent'], body);
          if (r.ok) { res.setHeader('Set-Cookie', sec.cookieFor(r.id, !!tls)); return json(res, 200, { ok: true, username: r.username, role: r.role }); }
          const status = { locked: 429, nopassword: 503, totp: 401, totp_bad: 401, password: 401 }[r.reason] || 401;
          return json(res, status, { ok: false, reason: r.reason, error: { locked: 'Too many failed attempts; this address is locked for 15 minutes', nopassword: `No account exists yet. On the server run: sudo ${slug} --set-password`, totp: 'Enter the code from your authenticator app', totp_bad: 'Wrong code', password: 'Wrong username or password' }[r.reason] });
        }
        if (!role) return json(res, 401, { ok: false, reason: 'login', error: 'sign in required' });
        if (ch === 'logout') { if (session) { sec.logout(session, ip); res.setHeader('Set-Cookie', sec.clearCookie); } return json(res, 200, { ok: true }); }
        if (ch === 'reauth' && req.method === 'POST') { if (!session) return json(res, 401, { ok: false, reason: 'login', error: 'sign in required' }); const { password } = JSON.parse(await readBody(req) || '{}'); return sec.reauth(session, password, ip) ? json(res, 200, { ok: true }) : json(res, 401, { ok: false, reason: 'reauth_bad', error: 'Wrong password' }); }
        if (ch === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
          res.write(': connected\n\n'); clients.add(res);
          const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 25000);
          req.on('close', () => { clearInterval(ka); clients.delete(res); });
          return;
        }
        const fn = handlers.get(ch);
        if (!fn || req.method !== 'POST') return json(res, 404, { ok: false, error: `unknown channel ${ch}` });
        if (!allowed(role, ch)) { if (!session) return json(res, 401, { ok: false, reason: 'login', error: 'sign in required' }); sec.audit('forbidden', ip, ch, session.user); return json(res, 403, { ok: false, reason: 'forbidden', error: 'Your account is not allowed to do that' }); }
        const args = JSON.parse(await readBody(req) || '[]');
        if (!Array.isArray(args)) return json(res, 400, { ok: false, error: 'arguments must be an array' });
        if (SENSITIVE.has(ch)) { if (sec.needsReauth(session)) return json(res, 401, { ok: false, reason: 'reauth', error: 'Please re-enter your password for this action' }); sec.audit('sensitive_action', ip, ch, session.user); }
        const ctx = { session, ip, role, req };
        const result = CTX_HANDLERS.has(ch) ? await fn(ctx, ...args) : await fn(...args);
        return json(res, 200, { ok: true, result: result === undefined ? null : result });
      }
      // The public half of the self-signed certificate, for installing on phones and PCs (any signed-in session).
      if (url.pathname === `/tls/${slug}-cert.crt`) {
        if (!tls || !session) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': `attachment; filename="${slug}-cert.crt"`, 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(tlsDir, 'cert.pem')).pipe(res);
      }
      // CSV of one data set for a date range (any signed-in session): /csv/<set>?from=YYYY-MM-DD&to=YYYY-MM-DD
      if (csvSets && url.pathname.startsWith('/csv/')) {
        if (!session) return json(res, 401, { ok: false, reason: 'login', error: 'sign in required' });
        const key = decodeURIComponent(url.pathname.slice(5)).replace(/\.csv$/, '');
        const set = csvSets[key];
        if (!set) return json(res, 404, { ok: false, error: 'unknown data set' });
        const day = (s, dflt) => { const t = Date.parse(String(s || '') + 'T00:00:00'); return isNaN(t) ? dflt : t; };
        const to = day(url.searchParams.get('to'), Date.now()) + 86400000, from = Math.max(day(url.searchParams.get('from'), to - 8 * 86400000), to - 366 * 86400000);
        const body = set.text ? set.text(svc.db, from, to) : csv(set.rows(svc.db, from, to), set.cols);
        const name = `${slug}-${key}-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to - 1).toISOString().slice(0, 10)}.${set.text ? 'txt' : 'csv'}`;
        res.writeHead(200, { 'content-type': set.text ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
        return res.end(body);
      }
      // Zip downloads (signed-in): /exports/<file.zip> from <data>/exports.
      if (url.pathname.startsWith('/exports/')) {
        if (!session) { res.writeHead(401); return res.end('sign in first'); }
        const base2 = path.resolve(dataDir, 'exports');
        const target = path.resolve(base2, decodeURIComponent(url.pathname.slice('/exports/'.length)));
        if (!target.startsWith(base2 + path.sep) || !target.endsWith('.zip') || !fs.existsSync(target)) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${path.basename(target)}"`, 'cache-control': 'no-store' });
        return fs.createReadStream(target).pipe(res);
      }
      // Static files: the kit's renderer under /kit/renderer/, the app's renderer for everything else.
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const fromKit = /^[\\/]kit[\\/]renderer[\\/]/.test(file);
      const dir = fromKit ? kitRenderer : appRenderer;
      const abs = path.join(dir, fromKit ? file.replace(/^[\\/]kit[\\/]renderer[\\/]/, '') : file);
      if (!abs.startsWith(dir) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end('not found'); }
      sendFile(res, abs);
    } catch (e) {
      log(`${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else res.end();
    }
  }

  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.requestTimeout = 0;       // long downloads and exports legitimately run for minutes
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;

  function start() {
    server.listen(port, host, () => {
      log(`${app.name || slug} ${version} on ${tls ? 'https' : 'http'}://${host}:${port} (data: ${dataDir}, LAN-only: ${sec.state.lanOnly}, guest: ${sec.guestEnabled()})`);
      if (!sec.hasPassword()) log('No account yet: run with --set-password to create "admin" before anyone can sign in.');
      if (typeof svc.start === 'function') svc.start();
    });
    server.on('error', (e) => { log(`cannot listen on ${host}:${port}: ${e.message}`); process.exit(1); });
    const stop = (sig) => { log(`${sig}: shutting down`); server.close(); for (const c of clients) { try { c.end(); } catch { /* ignore */ } } if (typeof svc.shutdown === 'function') svc.shutdown(); process.exit(0); };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  }

  /** `--set-password`: create or reset the admin account from <SLUG>_PASSWORD, stdin, or a prompt, then exit. */
  function setPasswordCli() {
    const P = String(slug).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const finish = (pw) => { try { sec.setPassword(pw); } catch (e) { console.error(e.message); process.exit(2); } console.log('Password for user "admin" saved; all sessions signed out.'); process.exit(0); };
    if (env[`${P}_PASSWORD`]) finish(env[`${P}_PASSWORD`]);
    else if (!process.stdin.isTTY) { let s = ''; process.stdin.on('data', d => { s += d; }).on('end', () => finish(s.trim())); }
    else { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question('New password for user "admin": ', pw => { console.log(); rl.close(); finish(pw); }); rl._writeToOutput = s => { if (/password/i.test(s)) rl.output.write(s); }; }
  }

  return { start, setPasswordCli, server, svc, sec, send, log, dataDir, port, handlers, webHandlers: web, roles: { GUEST, STANDARD, SENSITIVE } };
}

// The channels the web shell serves on its own (kit/test/contract.js checks the bridge against them).
const WEB_CHANNELS = ['app:info', 'update:check', 'settings:get', 'settings:set', 'settings:replace', 'security:me', 'security:status', 'security:tlsEnable', 'security:changePassword', 'security:totpSetup', 'security:totpEnable', 'security:totpDisable', 'security:setOptions', 'security:revoke', 'security:revokeOthers', 'security:users', 'security:addUser', 'security:setRole', 'security:resetPassword', 'security:deleteUser', 'prefs:get', 'prefs:set', 'status:info', 'status:rotate', 'dialog:pickFolder', 'dialog:pickFile', 'shell:open', 'shell:openExternal', 'shell:showItem', 'update:install', 'update:status'];

module.exports = { createWebShell, resolveOptions, REDACTED, WEB_CHANNELS };
