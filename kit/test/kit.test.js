'use strict';
// The kit's own tests: storage, settings, csv, notify parsing, security, TOTP, sysmon rules, the
// core skeleton and the web shell's redaction and options. Plain node, no dependencies.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Db } = require('../main/db');
const { Settings, deepMerge, getPath, setPath } = require('../main/settings');
const { csv, dayKey, dayStart, nextDay } = require('../main/csv');
const { parseReplies } = require('../main/notify');
const { createSecurity, isPrivateIp, hashPassword, checkHash } = require('../server/security');
const totp = require('../server/totp');
const { healthOf } = require('../main/sysmon');
const { createCore } = require('../main/core');
const { createWebShell, resolveOptions, REDACTED, WEB_CHANNELS } = require('../server/shell');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bk-kit-'));

// ---- db: schema, migrations, kv, jobs, backup ----
{
  const dir = tmp();
  const file = path.join(dir, 'x.db');
  const db = new Db(file, { schema: 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, a TEXT);', migrations: [{ version: 1, name: 'add b', sql: 'ALTER TABLE t ADD COLUMN b TEXT; -- comment\nALTER TABLE t ADD COLUMN b TEXT;' }], counts: ['t'] });
  assert.strictEqual(db.userVersion, 1, 'migration applied, duplicate column tolerated');
  db.run('INSERT INTO t(a, b) VALUES(?, ?)', 'x', 'y');
  assert.strictEqual(db.stats().t, 1);
  db.kvSet('k', { n: 1 }); assert.deepStrictEqual(db.kvGet('k'), { n: 1 }); assert.strictEqual(db.kvGet('nope', 'd'), 'd');
  db.jobDone('j', false, 'boom'); db.jobDone('j', true); assert.strictEqual(db.jobs()[0].last_error, null); assert.ok(db.jobs()[0].last_ok);
  const b = db.backup('t'); assert.ok(fs.existsSync(b));
  assert.throws(() => db.transaction(() => { db.run('INSERT INTO t(a) VALUES(?)', 'z'); throw new Error('x'); }), /x/);
  assert.strictEqual(db.get('SELECT COUNT(*) n FROM t').n, 1, 'rolled back');
  db.close();
}
// ---- settings ----
{
  const dir = tmp();
  const s = new Settings(dir, { a: { b: 1, c: [1, 2] }, secret: '' });
  s.set({ a: { c: [3] }, secret: 'k' });
  assert.deepStrictEqual(new Settings(dir, { a: { b: 1, c: [1, 2] }, secret: '' }).get(), { a: { b: 1, c: [3] }, secret: 'k' });
  assert.deepStrictEqual(deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 }, e: undefined }), { a: 1, b: { c: 2, d: 3 }, e: undefined });
  const o = { x: { y: { z: 1 } } }; assert.strictEqual(getPath(o, 'x.y.z'), 1); setPath(o, 'x.q.r', 2); assert.strictEqual(o.x.q.r, 2);
}
// ---- csv + days ----
assert.strictEqual(csv([{ a: 'x,y', b: '=1+1' }], [['a', r => r.a], ['b', r => r.b]]), '﻿a,b\r\n"x,y","=1+1"\r\n');
assert.strictEqual(new Date(nextDay(new Date(2026, 2, 8).getTime())).getDate(), 9);
assert.strictEqual(dayStart(new Date(2026, 8, 23, 15).getTime()), new Date(2026, 8, 23).getTime());
assert.strictEqual(dayKey(new Date(2026, 0, 5).getTime()), '2026-01-05');
// ---- notify ----
assert.deepStrictEqual(parseReplies('250-a\r\n250 b\r\n354 go\r\n2'), { replies: ['250-a\n250 b', '354 go'], rest: '2' });
// ---- security ----
{
  const dir = tmp();
  const sec = createSecurity({ dataDir: dir, cookie: 'x_session', issuer: 'X' });
  assert.ok(isPrivateIp('192.168.1.5') && isPrivateIp('::1') && !isPrivateIp('8.8.8.8'));
  assert.ok(checkHash('pw12345678', hashPassword('pw12345678')) && !checkHash('nope', hashPassword('pw12345678')));
  assert.strictEqual(sec.login('10.0.0.1', 'ua', { username: 'admin', password: 'x' }).reason, 'nopassword');
  sec.setPassword('correct-horse');
  assert.strictEqual(sec.login('10.0.0.1', 'ua', { username: 'admin', password: 'wrong' }).reason, 'password');
  const r = sec.login('10.0.0.1', 'ua', { username: 'admin', password: 'correct-horse' });
  assert.ok(r.ok && r.role === 'admin');
  assert.ok(sec.cookieFor(r.id, false).startsWith('x_session='));
  const s = sec.sessionOf(`other=1; x_session=${r.id}`); assert.strictEqual(s.user, 'admin');
  assert.strictEqual(sec.sessionOf('x_session=' + 'a'.repeat(64)), null);
  sec.addUser('bob', 'password123', 'standard', '10.0.0.1', 'admin');
  assert.throws(() => sec.setRole('admin', 'standard', '10.0.0.1', 'admin'), /last admin/);
  sec.setPrefs('bob', { dashboard: { cards: [] } }); assert.deepStrictEqual(sec.getPrefs('bob').dashboard, { cards: [] });
  assert.deepStrictEqual(sec.getPrefs(null), {}, 'guests read the admin prefs (none set)');
  for (let i = 0; i < 8; i++) sec.login('10.0.0.9', 'ua', { username: 'admin', password: 'bad' });
  assert.strictEqual(sec.login('10.0.0.9', 'ua', { username: 'admin', password: 'correct-horse' }).reason, 'locked');
  const k = sec.statusKey(false, '10.0.0.1', 'admin'); assert.ok(sec.statusOk(k) && !sec.statusOk('x'));
  assert.ok(sec.status(s).users.length === 2);
}
// ---- totp ----
{
  const secret = totp.newSecret();
  const code = totp.totp(secret, 1700000000000);
  assert.ok(totp.verify(secret, code, 1700000000000) && !totp.verify(secret, '000000', 1700000000000));
  assert.ok(totp.otpauthUrl(secret, 'me', 'X').startsWith('otpauth://totp/X:me?'));
}
// ---- sysmon rules ----
assert.strictEqual(healthOf({ pi: null, memory: { pct: 50 }, cpu: { load: [0.1], cores: 4 }, service: { busy: false }, disks: [{ ok: true, pct: 10, free: 1e12 }] }).level, 'ok');
assert.strictEqual(healthOf({ pi: { tempC: 85 }, memory: { pct: 50 }, cpu: { load: [0.1], cores: 4 }, service: { busy: false }, disks: [{ ok: true, pct: 10, free: 1e12 }] }).level, 'bad');
// ---- core + web shell ----
(async () => {
  const dir = tmp();
  const core = createCore({ app: { name: 'T', slug: 't' }, dataDir: dir, defaults: { a: { b: 1 }, notify: { events: { x: true } } }, schema: 'CREATE TABLE IF NOT EXISTS n (id INTEGER PRIMARY KEY);', counts: ['n'] });
  let hooked = null; core.onSettings((b, a) => { hooked = [b.a.b, a.a.b]; });
  assert.strictEqual(core.settings.get().notify.email.port, 587, 'app defaults deep-merge over the kit defaults');
  core.handlers.get('settings:set')({ a: { b: 2 } });
  assert.deepStrictEqual(hooked, [1, 2]);
  assert.strictEqual(core.handlers.get('db:stats')().n, 0);
  core.handlers.get('prefs:set')({ k: 1 }); assert.deepStrictEqual(core.handlers.get('prefs:get')(), { k: 1 });
  let ran = 0; core.daily('d', () => '00:00', () => { ran++; });
  await core.minute(new Date(2026, 0, 1, 12).getTime()); await core.minute(new Date(2026, 0, 1, 13).getTime());
  assert.strictEqual(ran, 1, 'a daily job runs once per day');
  await core.minute(new Date(2026, 0, 2, 12).getTime()); assert.strictEqual(ran, 2);
  core.shutdown();

  const dir2 = tmp();
  const shell = createWebShell({ app: { name: 'T', slug: 't', repo: 'https://github.com/AxialForge/t' }, rootDir: path.join(__dirname, '..', '..'), dataDir: dir2, port: 0, secrets: ['notify.email.pass'], roles: { GUEST: ['x:y'] }, createService: ({ dataDir, log, send }) => { const c = createCore({ app: { slug: 't' }, dataDir, log, send }); c.h('x:y', () => 1); return c; } });
  for (const ch of WEB_CHANNELS) assert.ok(shell.handlers.has(ch), `web shell serves ${ch}`);
  assert.ok(shell.roles.GUEST.has('x:y') && shell.roles.GUEST.has('app:info'));
  shell.svc.settings.set({ notify: { email: { pass: 'hidden' } } });
  const ctx = { session: null, ip: '127.0.0.1', role: 'admin', req: { headers: {} } };
  assert.strictEqual(shell.webHandlers.get('settings:get')(ctx).notify.email.pass, REDACTED);
  shell.webHandlers.get('settings:set')(ctx, { notify: { email: { pass: REDACTED, host: 'h' } } });
  assert.strictEqual(shell.svc.settings.get().notify.email.pass, 'hidden', 'the placeholder keeps the secret');
  assert.strictEqual(shell.svc.settings.get().notify.email.host, 'h');
  const info = await shell.webHandlers.get('app:info')(ctx); assert.ok(info.web && info.kit);
  const o = resolveOptions({ app: { name: 'T', slug: 't' }, argv: ['node', 'x', '--port=1234'], env: { T_DATA: '/tmp/td' } });
  assert.strictEqual(o.port, 1234); assert.ok(o.dataDir.endsWith('td')); assert.strictEqual(o.envPrefix, 'T');
  shell.svc.shutdown();
  console.log('kit tests passed');
})().catch(e => { console.error(e); process.exit(1); });
