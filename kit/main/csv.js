'use strict';
// RFC 4180 CSV with a UTF-8 BOM (so Excel opens it with the right encoding), formula-safe: a cell
// starting with = + - @ is quoted so a spreadsheet never executes it.
//   csv(rows, [[header, row => value], …])
function csv(rows, cols) {
  const cell = (v) => { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.map(c => cell(c[0])).join(','), ...rows.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\r\n') + '\r\n';
}
const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextDay = (ms) => { const d = new Date(ms); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); }; // DST-safe

module.exports = { csv, iso, dayKey, dayStart, nextDay };
