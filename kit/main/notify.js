'use strict';
// Notifications without dependencies: a JSON webhook (Home Assistant, ntfy, Discord, anything that
// takes a POST) and a minimal SMTP client (STARTTLS or implicit TLS, AUTH PLAIN/LOGIN) for e-mail
// through any ordinary mailbox.
//
//   const notifier = createNotifier(() => settings.get().notify, log, { app: 'MyApp' });
//   await notifier.send('newItem', 'Title', 'Body text', { extra: 'data' });
//
// cfg = { webhookUrl, email: { enabled, host, port, secure, user, pass, from, to }, events: { <event>: true|false } }
const net = require('net');
const tls = require('tls');
const os = require('os');

/** POST a JSON body to a webhook URL. Resolves to { ok, status } and never throws on HTTP errors. */
async function postWebhook(url, payload, { timeoutMs = 10000, userAgent = 'Bracket' } = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': userAgent }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  return { ok: res.ok, status: res.status };
}

// ---- SMTP ------------------------------------------------------------------------------
// A reply is one or more lines; continuation lines read "250-…", the last one "250 …" (space after the code).
function parseReplies(buf) {
  const replies = []; let lines = [], rest = buf;
  for (;;) {
    const i = rest.indexOf('\n'); if (i < 0) break;
    const line = rest.slice(0, i).replace(/\r$/, ''); rest = rest.slice(i + 1); lines.push(line);
    if (/^\d{3}( |$)/.test(line)) { replies.push(lines.join('\n')); lines = []; }
  }
  return { replies, rest: lines.length ? lines.join('\n') + '\n' + rest : rest };
}
function smtpSession(socket) {
  let buf = ''; const waiters = []; const ready = [];
  const feed = (chunk) => { buf += chunk.toString('utf8'); const p = parseReplies(buf); buf = p.rest; for (const r of p.replies) { if (waiters.length) waiters.shift()(r); else ready.push(r); } };
  socket.on('data', feed);
  const read = () => ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve, reject) => { waiters.push(resolve); socket.once('error', reject); });
  const cmd = async (line) => { if (line != null) socket.write(line + '\r\n'); const r = await read(); const code = Number(r.slice(0, 3)); if (code >= 400) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'}: ${r.split('\n').pop()}`); return r; };
  return { cmd, socket, swap: (s) => { socket.off('data', feed); socket = s; socket.on('data', feed); } };
}

/** Send one plain-text e-mail. cfg: { host, port, secure (implicit TLS on 465), user, pass, from, to } */
async function sendMail(cfg, { subject, text, appName = 'Bracket' }) {
  const port = Number(cfg.port) || (cfg.secure ? 465 : 587);
  const connect = () => new Promise((resolve, reject) => { const s = cfg.secure ? tls.connect({ host: cfg.host, port, servername: cfg.host }, () => resolve(s)) : net.connect({ host: cfg.host, port }, () => resolve(s)); s.setTimeout(20000, () => { s.destroy(new Error('SMTP timeout')); }); s.once('error', reject); });
  let sock = await connect();
  const S = smtpSession(sock);
  try {
    await S.cmd(null);
    let ehlo = await S.cmd(`EHLO ${os.hostname() || 'bracket'}`);
    if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
      await S.cmd('STARTTLS');
      sock = await new Promise((resolve, reject) => { const t = tls.connect({ socket: sock, servername: cfg.host }, () => resolve(t)); t.once('error', reject); });
      S.swap(sock);
      ehlo = await S.cmd(`EHLO ${os.hostname() || 'bracket'}`);
    }
    if (cfg.user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await S.cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`).toString('base64'));
      else { await S.cmd('AUTH LOGIN'); await S.cmd(Buffer.from(cfg.user).toString('base64')); await S.cmd(Buffer.from(cfg.pass || '').toString('base64')); }
    }
    const from = cfg.from || cfg.user; const tos = String(cfg.to || '').split(/[,;\s]+/).filter(Boolean);
    if (!tos.length) throw new Error('No recipient');
    await S.cmd(`MAIL FROM:<${from}>`);
    for (const t of tos) await S.cmd(`RCPT TO:<${t}>`);
    await S.cmd('DATA');
    const body = [`From: ${appName} <${from}>`, `To: ${tos.join(', ')}`, `Subject: ${String(subject).replace(/[\r\n]+/g, ' ')}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'), '.'].join('\r\n');
    await S.cmd(body);
    try { await S.cmd('QUIT'); } catch { /* some servers close first */ }
    return { ok: true, to: tos };
  } finally { try { sock.end(); } catch { /* ignore */ } }
}

/** Notifier: sends to whatever is configured. `events` in the config switch each event on or off. */
function createNotifier(getCfg, log = () => {}, { app = 'Bracket' } = {}) {
  async function send(event, title, text, data = {}) {
    const cfg = getCfg() || {};
    if (cfg.events && cfg.events[event] === false) return { skipped: 'event off' };
    const out = { webhook: null, email: null };
    if (cfg.webhookUrl) {
      try { out.webhook = await postWebhook(cfg.webhookUrl, { app, event, title, message: text, ...data, at: new Date().toISOString() }, { userAgent: app }); }
      catch (e) { out.webhook = { ok: false, error: e.message }; log(`notify webhook failed: ${e.message}`); }
    }
    if (cfg.email && cfg.email.enabled && cfg.email.host && cfg.email.to) {
      try { out.email = await sendMail(cfg.email, { subject: `[${app}] ${title}`, text, appName: app }); }
      catch (e) { out.email = { ok: false, error: e.message }; log(`notify e-mail failed: ${e.message}`); }
    }
    return out;
  }
  return { send };
}

module.exports = { createNotifier, sendMail, postWebhook, parseReplies };
