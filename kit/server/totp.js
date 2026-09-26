'use strict';
// RFC 6238 time-based one-time passwords (what Google Authenticator, Aegis,
// 1Password, Bitwarden etc. generate). HMAC-SHA1, 6 digits, 30 s step, no deps.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** Code for a base32 secret at a given time (ms). */
function totp(secretB32, nowMs = Date.now(), step = 30) {
  return hotp(base32Decode(secretB32), Math.floor(nowMs / 1000 / step));
}

/** Accept the current step and one either side (clock drift). Constant-time compare. */
function verify(secretB32, code, nowMs = Date.now(), step = 30, window = 1) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(nowMs / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

/** otpauth:// URL that authenticator apps import (typed in or via a QR code). */
function otpauthUrl(secretB32, account, issuer = 'Bracket') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { base32Encode, base32Decode, hotp, totp, verify, newSecret, otpauthUrl };
