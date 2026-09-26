'use strict';
// Browser bridge: builds window.<APP.bridge> (default `api`) from bridge-shape.js over HTTP.
//
// Requests: POST /api/<channel> with a JSON array of arguments; the reply is
// { ok: true, result } or { ok: false, reason, error }. Events: one EventSource
// on /api/events carrying { channel, payload } messages.
//
// 401 handling by `reason`:
//   login      no session → sign-in dialog (password, then a 2FA code if asked)
//   totp       password accepted, code required → same dialog shows the code field
//   reauth     a sensitive action needs the password again → re-auth dialog, then retry
//
// Does nothing when the desktop preload already installed the bridge.
(function () {
  const APP = window.APP || {};
  const name = APP.bridge || 'api';
  // Desktop: the preload exposed the IPC bridge as window.__<name> (contextBridge globals are non-configurable, so a
  // top-level `const api = window.api` in app.js would be a SyntaxError). Re-publish it as a plain property here.
  if (window['__' + name]) { window[name] = window['__' + name]; return; }
  if (window[name] || !window.API_SHAPE) return;
  if (location.protocol === 'file:') { // desktop app whose preload failed: do not pretend to be a web client
    document.addEventListener('DOMContentLoaded', () => { const m = document.querySelector('#view') || document.body; m.innerHTML = `<div class="empty">The desktop bridge did not load (preload.js failed). Reinstall ${APP.name || 'the app'} or run from source with the log open.</div>`; });
    return;
  }

  function dialog({ title, text, fields, button }) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'webauth';
      box.innerHTML = `<form class="card"><h2>${title}</h2><p class="muted">${text}</p>${fields.map(f => `<div class="field"><label>${f.label}</label><input type="${f.type}" name="${f.name}" autocomplete="${f.autocomplete || 'off'}" inputmode="${f.inputmode || 'text'}" placeholder="${f.placeholder || ''}"></div>`).join('')}<div class="inline" style="margin-top:10px"><button class="primary" type="submit">${button}</button><span class="bad small err"></span></div></form>`;
      Object.assign(box.style, { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'grid', placeItems: 'center', zIndex: 9999 });
      document.body.append(box);
      const form = box.querySelector('form'); form.style.minWidth = '340px';
      setTimeout(() => form.querySelector('input').focus(), 0);
      form.onsubmit = async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(fields.map(f => [f.name, form.elements[f.name].value]));
        const err = await resolveAttempt(values);
        if (err === null) { box.remove(); resolve(); } else form.querySelector('.err').textContent = err;
      };
      let resolveAttempt = () => null;
      box.attempt = (fn) => { resolveAttempt = fn; };
      dialog.current = box;
    });
  }

  let loginPromise = null;
  function askLogin(needCode) {
    if (loginPromise) return loginPromise;
    const fields = [
      { label: 'Username', name: 'username', type: 'text', autocomplete: 'username' },
      { label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password' },
      { label: 'Authenticator code', name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: needCode ? '6 digits, required' : 'only if 2FA is on' },
    ];
    loginPromise = dialog({ title: APP.name || 'Sign in', text: `Sign in with your ${APP.name || ''} account.`, fields, button: 'Sign in' });
    dialog.current.attempt(async (v) => {
      if (!v.code) delete v.code;
      const r = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
      if (r.ok) { location.reload(); return null; } // roles change what the page shows: start clean
      let b = {}; try { b = await r.json(); } catch { /* ignore */ }
      return b.error || 'Sign-in failed';
    });
    return loginPromise.finally(() => { loginPromise = null; });
  }

  let reauthPromise = null;
  function askReauth() {
    if (reauthPromise) return reauthPromise;
    reauthPromise = dialog({ title: 'Confirm it is you', text: 'This action changes security settings or data. Re-enter your password to continue (valid for 5 minutes).', fields: [{ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password' }], button: 'Confirm' });
    dialog.current.attempt(async (v) => {
      const r = await fetch('api/reauth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
      if (r.ok) return null;
      let b = {}; try { b = await r.json(); } catch { /* ignore */ }
      return b.error || 'Wrong password';
    });
    return reauthPromise.finally(() => { reauthPromise = null; });
  }

  async function call(ch, args) {
    for (;;) {
      const r = await fetch('api/' + encodeURIComponent(ch), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
      let body;
      try { body = await r.json(); } catch { throw new Error(`Server error ${r.status}`); }
      if (r.status === 401) {
        if (body.reason === 'reauth') { await askReauth(); continue; }
        await askLogin(body.reason === 'totp'); continue;
      }
      if (r.status === 403) throw new Error(body.error || 'Not allowed for your account');
      if (!body.ok) throw new Error(body.error || `Server error ${r.status}`);
      if (listeners.size) ensureEvents(); // open the event stream only once a call has proven the session
      return body.result;
    }
  }

  const listeners = new Map();
  let es = null;
  function ensureEvents() {
    if (es) return;
    es = new EventSource('api/events');
    es.onmessage = (m) => { try { const { channel, payload } = JSON.parse(m.data); for (const fn of listeners.get(channel) || []) fn(payload); } catch { /* ignore */ } };
    es.onerror = () => { /* EventSource reconnects on its own; a 401 shows up on the next request */ };
  }
  const listen = (ch) => (fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); return () => listeners.get(ch).delete(fn); };
  const invoke = (ch) => (...args) => call(ch, args);

  function build(node) {
    if (typeof node === 'string') return node.startsWith('!') ? listen(node.slice(1)) : invoke(node);
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = build(v);
    return out;
  }
  const api = build(window.API_SHAPE);
  api.isWeb = true;
  api.logout = async () => { await fetch('api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); location.reload(); };
  api.signIn = () => askLogin(false);
  window[name] = api;
})();
