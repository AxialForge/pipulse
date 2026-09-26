'use strict';
// Minimal QR code encoder (byte mode, error-correction level M, versions 1–15) with no dependencies.
// Renders to an inline SVG string. Used for the 2FA otpauth:// link and the guest sign-in link.
// window.qrSvg(text, { size, label }) → '<svg …>'
(function () {
  // Per version (index 1..15), level M: [ec codewords per block, blocks in group 1, data codewords per group-1 block, blocks in group 2, data codewords per group-2 block]
  const EC = [null, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];

  // GF(256) arithmetic for Reed–Solomon
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  function rsGenerator(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; } return g; }
  function rsEncode(data, n) { const gen = rsGenerator(n); const res = new Array(n).fill(0); for (const d of data) { const f = d ^ res.shift(); res.push(0); if (f) for (let j = 0; j < n; j++) res[j] ^= mul(gen[j + 1], f); } return res; }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    for (; ver <= 15; ver++) { const e = EC[ver]; const cap = e[1] * e[2] + e[3] * e[4]; const hdr = ver < 10 ? 2 : 3; if (bytes.length + hdr <= cap) break; }
    if (ver > 15) throw new Error('Text too long for a QR code');
    const e = EC[ver], capBytes = e[1] * e[2] + e[3] * e[4];
    // Bit stream: mode 0100, count, data, terminator, pad
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capBytes * 8 - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let p = 0; data.length < capBytes; p ^= 1) data.push(p ? 0x11 : 0xec);
    // Blocks + interleave
    const blocks = []; let pos = 0;
    for (let b = 0; b < e[1]; b++) { blocks.push(data.slice(pos, pos + e[2])); pos += e[2]; }
    for (let b = 0; b < e[3]; b++) { blocks.push(data.slice(pos, pos + e[4])); pos += e[4]; }
    const ecs = blocks.map(bl => rsEncode(bl, e[0]));
    const out = [];
    const maxLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++) for (const bl of blocks) if (i < bl.length) out.push(bl[i]);
    for (let i = 0; i < e[0]; i++) for (const ec of ecs) out.push(ec[i]);
    return { ver, codewords: out };
  }

  function makeMatrix(ver, codewords) {
    const n = ver * 4 + 17;
    const m = Array.from({ length: n }, () => new Int8Array(n).fill(-1)); // -1 = free, 0/1 = fixed
    const set = (r, c, v) => { m[r][c] = v; };
    const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue; const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(rr, cc, on ? 1 : 0); } };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
    const al = ALIGN[ver];
    const last = al[al.length - 1];
    for (const r of al) for (const c of al) { if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue; /* those three sit on finders */ for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, (Math.max(Math.abs(i), Math.abs(j)) === 1) ? 0 : 1); }
    set(n - 8, 8, 1); // dark module
    // Reserve format areas (filled later)
    for (let i = 0; i < 9; i++) { if (m[8][i] === -1) set(8, i, 0); if (m[i][8] === -1) set(i, 8, 0); }
    for (let i = 0; i < 8; i++) { if (m[8][n - 1 - i] === -1) set(8, n - 1 - i, 0); if (m[n - 1 - i][8] === -1) set(n - 1 - i, 8, 0); }
    const reserved = m.map(row => row.map(v => v !== -1));
    if (ver >= 7) {
      let v = ver << 12, g = 0x1f25; for (let i = 17; i >= 12; i--) if (v & (1 << i)) v ^= g << (i - 12);
      const vi = (ver << 12) | v;
      for (let i = 0; i < 18; i++) { const bit = (vi >> i) & 1, a = Math.floor(i / 3), b = n - 11 + (i % 3); set(a, b, bit); set(b, a, bit); reserved[a][b] = reserved[b][a] = true; }
    }
    // Place data bits in the zigzag
    const bits = []; for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    let k = 0, up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < n; i++) { const r = up ? n - 1 - i : i; for (const c of [col, col - 1]) if (!reserved[r][c]) { m[r][c] = k < bits.length ? bits[k++] : 0; } }
      up = !up;
    }
    return { m, n, reserved };
  }

  const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];

  function applyMask(base, mask) {
    const { m, n, reserved } = base;
    const out = m.map((row, r) => row.map((v, c) => (!reserved[r][c] && MASKS[mask](r, c)) ? v ^ 1 : v));
    // Format info: 5 bits (level M = 00, then the 3-bit mask) + 10 BCH bits, XOR 0x5412. B(i) is bit i counting from the most significant.
    let v = mask << 10; for (let i = 14; i >= 10; i--) if (v & (1 << i)) v ^= 0x537 << (i - 10);
    const fi = ((mask << 10) | v) ^ 0x5412;
    const B = i => (fi >> (14 - i)) & 1;
    for (let i = 0; i <= 5; i++) out[8][i] = B(i);
    out[8][7] = B(6); out[8][8] = B(7); out[7][8] = B(8);
    for (let i = 9; i <= 14; i++) out[14 - i][8] = B(i);
    for (let i = 7; i <= 14; i++) out[8][n - 15 + i] = B(i);
    for (let i = 0; i <= 6; i++) out[n - 1 - i][8] = B(i);
    return out;
  }

  function penalty(g) {
    const n = g.length; let p = 0;
    const run = (get) => { for (let a = 0; a < n; a++) { let last = -1, len = 0; for (let b = 0; b < n; b++) { const v = get(a, b); if (v === last) { len++; } else { if (len >= 5) p += len - 2; last = v; len = 1; } } if (len >= 5) p += len - 2; } };
    run((a, b) => g[a][b]); run((a, b) => g[b][a]);
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = g[r][c]; if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) p += 3; }
    const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const check = (get) => { for (let a = 0; a < n; a++) for (let b = 0; b <= n - 11; b++) { let ok1 = true, ok2 = true; for (let i = 0; i < 11; i++) { const v = get(a, b + i); if (v !== pat1[i]) ok1 = false; if (v !== pat2[i]) ok2 = false; } if (ok1 || ok2) p += 40; } };
    check((a, b) => g[a][b]); check((a, b) => g[b][a]);
    let dark = 0; for (const row of g) for (const v of row) dark += v;
    const pct = (dark * 100) / (n * n); const k = Math.floor(Math.abs(pct - 50) / 5); p += k * 10;
    return p;
  }

  function matrix(text, forceMask) {
    const { ver, codewords } = encode(text);
    const base = makeMatrix(ver, codewords);
    if (forceMask != null) return applyMask(base, forceMask);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { const g = applyMask(base, mask); const p = penalty(g); if (p < bestP) { bestP = p; best = g; } }
    return best;
  }

  function qrSvg(text, opts = {}) {
    const g = matrix(text), n = g.length, size = opts.size || 180, quiet = 4, total = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${(opts.label || 'QR code').replace(/"/g, '&quot;')}"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { matrix, qrSvg, encode, rsEncode, makeMatrix };
  if (typeof window !== 'undefined') { window.qrSvg = qrSvg; window.qrMatrix = matrix; }
})();
