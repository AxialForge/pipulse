'use strict';
// Security for the web shell: user accounts with roles, sessions, lockout, LAN-only guard,
// two-factor codes for admins, re-authentication for dangerous actions, an optional no-login
// guest mode, per-account preferences, and an audit log.
//
// Roles
//   admin     everything the app offers, plus settings, security and users
//   standard  what the app's STANDARD list allows (usually every page read-only), their own password
//             and preferences
//   guest     (no account, no sign-in, only when "guest access" is on) what the app's GUEST list allows
//
// State lives in <data>/web.json (mode 0600), deliberately apart from settings.json which the UI
// can replace wholesale. Events append to <data>/security.log as JSON lines and the last 300 are
// kept in memory for the Security page.
//
// The cookie name is per app (`<slug>_session`): two Bracket apps on one host share the browser's
// cookie jar (cookies ignore the port), and the same name would sign each other out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const totp = require('./totp');

const SESSION_DAYS = 30;
const REAUTH_MINUTES = 5;
const LOCK_FAILS = 8;         // failures per IP …
const LOCK_WINDOW_MS = 15 * 60000; // … within this window …
const LOCK_MS = 15 * 60000;   // … ban the IP for this long
const MIN_PASSWORD = 8;
const ROLES = ['admin', 'standard'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Private / local address? Loopback, RFC 1918, link-local, CGNAT, IPv6 ULA + link-local. */
function isPrivateIp(ip) {
  if (!ip) return false;
  let a = String(ip);
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a === '127.0.0.1') return true;
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 10 || x === 127 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (net.isIPv6(a)) { const l = a.toLowerCase(); return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80'); }
  return false;
}

const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkHash = (pw, stored) => { if (!stored) return false; const [salt, hex] = stored.split(':'); const a = Buffer.from(hex, 'hex'), b = crypto.scryptSync(pw, salt, 32); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const normUser = (u) => String(u || '').trim().toLowerCase();

function createSecurity({ dataDir, log = () => {}, cookie = 'bracket_session', issuer = 'Bracket' }) {
  const webFile = path.join(dataDir, 'web.json');
  const auditFile = path.join(dataDir, 'security.log');
  const DEFAULTS = { users: {}, guestEnabled: false, lanOnly: true, idleMinutes: 0, totp: { enabled: false, secret: null, pending: null }, sessions: {}, webhook: { enabled: false, key: null }, statusKey: null };
  let state = { ...DEFAULTS };
  try {
    state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(webFile, 'utf8')) };
    state.totp = { ...DEFAULTS.totp, ...(state.totp || {}) }; state.sessions = state.sessions || {}; state.users = state.users || {}; state.webhook = { ...DEFAULTS.webhook, ...(state.webhook || {}) };
    for (const [k, v] of Object.entries(state.sessions)) if (!v || !v.lastSeen || !v.user) delete state.sessions[k];
  } catch { /* first run */ }
  const save = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(webFile, JSON.stringify(state, null, 2), { mode: 0o600 }); try { fs.chmodSync(webFile, 0o600); } catch { /* windows */ } };
  if (Object.keys(state.users).length || fs.existsSync(webFile)) save();

  // ---- audit ----
  const recent = [];
  try { for (const l of fs.readFileSync(auditFile, 'utf8').trim().split('\n').slice(-300)) { try { recent.push(JSON.parse(l)); } catch { /* skip */ } } } catch { /* none yet */ }
  function audit(event, ip, detail = '', user = null) {
    const e = { ts: new Date().toISOString(), event, ip: ip || null, user: user || null, detail };
    recent.push(e); if (recent.length > 300) recent.shift();
    try { fs.appendFileSync(auditFile, JSON.stringify(e) + '\n', { mode: 0o600 }); } catch { /* ignore */ }
    log(`security: ${event} ${user ? user + '@' : ''}${ip || ''} ${detail}`.trim());
  }

  // ---- lockout ----
  const fails = new Map(); // ip -> [ts]
  const bans = new Map();  // ip -> until
  const failed = (ip) => { const now = Date.now(); const l = (fails.get(ip) || []).filter(t => now - t < LOCK_WINDOW_MS); l.push(now); fails.set(ip, l); if (l.length >= LOCK_FAILS) { bans.set(ip, now + LOCK_MS); fails.delete(ip); audit('ip_locked', ip, `${LOCK_FAILS} failures in ${LOCK_WINDOW_MS / 60000} min`); } };
  const isBanned = (ip) => { const u = bans.get(ip); if (u && u > Date.now()) return true; if (u) bans.delete(ip); return false; };

  // ---- users ----
  const userOf = (name) => state.users[normUser(name)] || null;
  const adminCount = () => Object.values(state.users).filter(u => u.role === 'admin').length;
  // Per-account preferences (dashboard layouts, card rules). Guests read the first admin's.
  function getPrefs(name) { const u = name ? state.users[normUser(name)] : null; const src = u || Object.values(state.users).find(x => x.role === 'admin'); return (src && src.prefs) || {}; }
  function setPrefs(name, patch) { const u = state.users[normUser(name)]; if (!u) throw new Error('No such user'); u.prefs = { ...(u.prefs || {}), ...(patch || {}) }; for (const k of Object.keys(u.prefs)) if (u.prefs[k] === null) delete u.prefs[k]; save(); return u.prefs; }
  function listUsers() { return Object.entries(state.users).map(([name, u]) => ({ username: name, role: u.role, created: u.created, lastLogin: u.lastLogin || null, sessions: Object.values(state.sessions).filter(s => s.user === name).length })).sort((a, b) => a.username.localeCompare(b.username)); }
  function addUser(name, password, role, ip, by) {
    const u = normUser(name);
    if (!USERNAME_RE.test(u)) throw new Error('Username: 2–32 characters, letters, digits, dot, dash or underscore');
    if (state.users[u]) throw new Error('That username already exists');
    if (!ROLES.includes(role)) throw new Error('Role must be admin or standard');
    if (!password || password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
    state.users[u] = { hash: hashPassword(password), role, created: Date.now() }; save(); audit('user_added', ip, `${u} (${role})`, by); return true;
  }
  function setRole(name, role, ip, by) {
    const u = normUser(name); if (!state.users[u]) throw new Error('No such user');
    if (!ROLES.includes(role)) throw new Error('Role must be admin or standard');
    if (state.users[u].role === 'admin' && role !== 'admin' && adminCount() === 1) throw new Error('That is the last admin');
    state.users[u].role = role; for (const s of Object.values(state.sessions)) if (s.user === u) s.role = role; save(); audit('role_changed', ip, `${u} → ${role}`, by); return true;
  }
  function resetPassword(name, password, ip, by) {
    const u = normUser(name); if (!state.users[u]) throw new Error('No such user');
    if (!password || password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
    state.users[u].hash = hashPassword(password); for (const k of Object.keys(state.sessions)) if (state.sessions[k].user === u) delete state.sessions[k]; save(); audit('password_reset', ip, u, by); return true;
  }
  function deleteUser(name, ip, by) {
    const u = normUser(name); if (!state.users[u]) throw new Error('No such user');
    if (state.users[u].role === 'admin' && adminCount() === 1) throw new Error('That is the last admin');
    delete state.users[u]; for (const k of Object.keys(state.sessions)) if (state.sessions[k].user === u) delete state.sessions[k]; save(); audit('user_deleted', ip, u, by); return true;
  }
  /** CLI / installer: create or reset the "admin" account. */
  function setPassword(pw) { if (!pw || pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`); state.users.admin = { ...(state.users.admin || { created: Date.now() }), hash: hashPassword(pw), role: 'admin' }; state.sessions = {}; save(); }
  const hasUsers = () => Object.keys(state.users).length > 0;

  // ---- sessions ----
  const prune = () => { const now = Date.now(); for (const [k, s] of Object.entries(state.sessions)) if (s.expires < now || (state.idleMinutes && s.lastSeen && now - s.lastSeen > state.idleMinutes * 60000)) delete state.sessions[k]; };
  function newSession(user, ip, ua) {
    prune();
    const id = crypto.randomBytes(32).toString('hex');
    state.sessions[id] = { user, role: state.users[user].role, created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400000, lastSeen: Date.now(), ip, ua: String(ua || '').slice(0, 160), reauthAt: Date.now() };
    state.users[user].lastLogin = Date.now();
    save();
    return id;
  }
  const cookieFor = (id, secure) => `${cookie}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  const clearCookie = `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  const cookieRe = new RegExp(`(?:^|;\\s*)${cookie}=([a-f0-9]{64})`);
  function sessionOf(cookieHeader) {
    const m = cookieRe.exec(cookieHeader || '');
    if (!m) return null;
    const s = state.sessions[m[1]];
    if (!s) return null;
    const now = Date.now();
    if (s.expires < now || (state.idleMinutes && now - s.lastSeen > state.idleMinutes * 60000) || !state.users[s.user]) { delete state.sessions[m[1]]; save(); return null; }
    if (now - s.lastSeen > 60000) { s.lastSeen = now; save(); } // throttle disk writes
    return { id: m[1], ...s, role: state.users[s.user].role };
  }
  function setSessionFlag(id, key, value) { if (state.sessions[id]) { state.sessions[id][key] = value; save(); } }
  const shortId = (id) => id.slice(0, 8);

  // ---- login ----
  function login(ip, ua, { username, password, code }) {
    if (isBanned(ip)) { audit('login_blocked', ip, 'locked out'); return { ok: false, reason: 'locked' }; }
    if (!hasUsers()) return { ok: false, reason: 'nopassword' };
    const u = normUser(username); const user = state.users[u];
    if (!user || !checkHash(String(password || ''), user.hash)) { failed(ip); audit('login_failed', ip, user ? 'wrong password' : 'unknown user', u || null); return { ok: false, reason: 'password' }; }
    if (state.totp.enabled && user.role === 'admin') {
      if (!code) return { ok: false, reason: 'totp' }; // password right, now ask for the code
      if (!totp.verify(state.totp.secret, code)) { failed(ip); audit('login_failed', ip, 'wrong 2FA code', u); return { ok: false, reason: 'totp_bad' }; }
    }
    fails.delete(ip);
    const id = newSession(u, ip, ua);
    audit('login', ip, `${user.role}${state.totp.enabled && user.role === 'admin' ? ' + 2FA' : ''}`, u);
    return { ok: true, id, role: user.role, username: u };
  }
  function logout(s, ip) { delete state.sessions[s.id]; save(); audit('logout', ip, '', s.user); }

  // ---- own password ----
  function changePassword(s, current, next, ip) {
    const user = state.users[s.user];
    if (!checkHash(String(current || ''), user.hash)) { failed(ip); audit('password_change_failed', ip, '', s.user); throw new Error('Current password is wrong'); }
    if (!next || next.length < MIN_PASSWORD) throw new Error(`New password must be at least ${MIN_PASSWORD} characters`);
    user.hash = hashPassword(next);
    for (const k of Object.keys(state.sessions)) if (k !== s.id && state.sessions[k].user === s.user) delete state.sessions[k];
    save(); audit('password_changed', ip, 'other sessions of this user signed out', s.user);
  }

  // ---- re-authentication for dangerous actions ----
  const needsReauth = (s) => !s.reauthAt || Date.now() - s.reauthAt > REAUTH_MINUTES * 60000;
  function reauth(s, password, ip) {
    if (isBanned(ip)) return false;
    if (!checkHash(String(password || ''), state.users[s.user].hash)) { failed(ip); audit('reauth_failed', ip, '', s.user); return false; }
    state.sessions[s.id].reauthAt = Date.now(); save(); audit('reauth', ip, '', s.user); return true;
  }

  // ---- two-factor (admins) ----
  function totpSetup(account) { const secret = totp.newSecret(); state.totp.pending = secret; save(); return { secret, url: totp.otpauthUrl(secret, account, issuer) }; }
  function totpEnable(code, ip, by) {
    if (!state.totp.pending) throw new Error('Start 2FA setup first');
    if (!totp.verify(state.totp.pending, code)) throw new Error('That code did not match; check the phone clock and try again');
    state.totp = { enabled: true, secret: state.totp.pending, pending: null }; save(); audit('2fa_enabled', ip, 'applies to admin sign-ins', by); return true;
  }
  function totpDisable(s, password, ip) {
    if (!checkHash(String(password || ''), state.users[s.user].hash)) { failed(ip); throw new Error('Password is wrong'); }
    state.totp = { enabled: false, secret: null, pending: null }; save(); audit('2fa_disabled', ip, '', s.user); return true;
  }

  // ---- options ----
  function setOptions({ lanOnly, idleMinutes, guestEnabled }, ip, by) {
    if (typeof lanOnly === 'boolean') state.lanOnly = lanOnly;
    if (typeof guestEnabled === 'boolean') state.guestEnabled = guestEnabled;
    if (idleMinutes != null) state.idleMinutes = Math.max(0, Math.min(10080, Number(idleMinutes) || 0));
    save(); audit('options_changed', ip, `lanOnly=${state.lanOnly} idleMinutes=${state.idleMinutes} guest=${state.guestEnabled}`, by);
  }
  const isAllowedIp = (ip) => !state.lanOnly || isPrivateIp(ip);
  // Webhook key (for push integrations that need a shared secret in the URL).
  function webhookSet({ enabled, rotate }, ip, by) {
    if (rotate || (enabled && !state.webhook.key)) state.webhook.key = crypto.randomBytes(18).toString('base64url');
    if (typeof enabled === 'boolean') state.webhook.enabled = enabled;
    save(); audit('webhook_changed', ip, `enabled=${state.webhook.enabled}${rotate ? ' key rotated' : ''}`, by); return state.webhook;
  }
  // Read-only status JSON for Home Assistant and friends: a random key in the URL.
  function statusKey(rotate, ip, by) { if (rotate || !state.statusKey) { state.statusKey = crypto.randomBytes(18).toString('base64url'); save(); audit('status_key', ip, rotate ? 'rotated' : 'created', by); } return state.statusKey; }
  const statusOk = (key) => !!state.statusKey && !!key && key.length === state.statusKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(state.statusKey));
  const webhookOk = (key) => state.webhook.enabled && !!state.webhook.key && !!key && key.length === state.webhook.key.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(state.webhook.key));

  // ---- status for the Security page ----
  function status(current, extra = {}) {
    prune();
    return {
      passwordSet: hasUsers(), totpEnabled: state.totp.enabled, totpPending: !!state.totp.pending, lanOnly: state.lanOnly, idleMinutes: state.idleMinutes, guestEnabled: state.guestEnabled,
      me: current ? { username: current.user, role: current.role } : null,
      users: listUsers(),
      sessions: Object.entries(state.sessions).map(([id, s]) => ({ id: shortId(id), current: current && id === current.id, user: s.user, role: s.role, created: s.created, lastSeen: s.lastSeen, expires: s.expires, ip: s.ip, ua: s.ua })).sort((a, b) => b.lastSeen - a.lastSeen),
      events: recent.slice(-100).reverse(),
      banned: [...bans.entries()].filter(([, u]) => u > Date.now()).map(([ip, until]) => ({ ip, until })),
      failedLogins24h: recent.filter(e => e.event === 'login_failed' && Date.now() - Date.parse(e.ts) < 86400000).length,
      limits: { lockFails: LOCK_FAILS, lockMinutes: LOCK_MS / 60000, reauthMinutes: REAUTH_MINUTES, sessionDays: SESSION_DAYS, minPassword: MIN_PASSWORD },
      ...extra,
    };
  }
  function revoke(short, current, ip) { for (const k of Object.keys(state.sessions)) if (shortId(k) === short && k !== current.id) { delete state.sessions[k]; save(); audit('session_revoked', ip, short, current.user); return true; } return false; }
  function revokeOthers(current, ip) { let n = 0; for (const k of Object.keys(state.sessions)) if (k !== current.id) { delete state.sessions[k]; n++; } save(); audit('sessions_revoked', ip, `${n} other session(s)`, current.user); return n; }

  return {
    get state() { return state; }, cookie, audit, isBanned, isAllowedIp, login, logout, sessionOf, setSessionFlag, cookieFor, clearCookie,
    setPassword, hasPassword: hasUsers, changePassword, needsReauth, reauth, totpSetup, totpEnable, totpDisable, setOptions, status, revoke, revokeOthers,
    listUsers, addUser, setRole, resetPassword, deleteUser, userOf, guestEnabled: () => state.guestEnabled, statusKey, statusOk, getPrefs, setPrefs,
    webhookSet, webhookOk, webhook: () => state.webhook,
  };
}

module.exports = { createSecurity, isPrivateIp, hashPassword, checkHash, MIN_PASSWORD, ROLES };
