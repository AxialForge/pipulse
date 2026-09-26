'use strict';
// Card library for dashboards and list pages: number tiles with colour rules, horizontal bars on a
// square-root scale with count and share labels, donuts, trend lines, time series with hover
// details, stacked daily columns, and one global tooltip for every [data-tip]. Pure functions
// returning HTML strings; no dependencies.
//
//   Cards.configure({ segments: { wired: 'Wired', wifi: 'Wi-Fi' }, segmentColors: { wired: 'var(--c1)' }, segmentHref: (key) => '#clients' })
//   Cards.number(label, { value, num, rule, sub, href, id, tip, gear })
//   Cards.bars(rows, title, opts)   rows: [{ k, n, segment? }]
//   Cards.donut(slices, title, opts)   slices: [{ k, n, color?, href? }]
//   Cards.trend(points, title, opts)   points: [{ x: label, y }]
//   Cards.series(sets, title, opts)    sets: [{ name, color, points: [{ t, y }] }]
//   Cards.columns(points, title, opts) points: [{ x: label, values: [v0, v1…], tip? }]
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n || 0).toLocaleString();
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const cfg = { segments: {}, segmentColors: {}, segmentHref: () => null };
  function configure(o = {}) { Object.assign(cfg, o); }

  // ---- colour rules: { higher: true|false, warn, bad } → 'okt' | 'warnt' | 'badt' | ''
  function colorFor(value, rule) {
    if (!rule || value == null || isNaN(value)) return '';
    const v = Number(value);
    if (rule.higher) { if (rule.bad != null && v <= rule.bad) return 'badt'; if (rule.warn != null && v <= rule.warn) return 'warnt'; return 'okt'; }
    if (rule.bad != null && v >= rule.bad) return 'badt'; if (rule.warn != null && v >= rule.warn) return 'warnt'; return 'okt';
  }

  // ---- number tile. opts: { id, cls, value (display), num (numeric for the rule), sub, rule, href, tip, gear }
  function number(label, opts = {}) {
    const cls = opts.cls != null ? opts.cls : colorFor(opts.num, opts.rule);
    const inner = `<div class="tile ${cls}" ${opts.id ? `id="${esc(opts.id)}" data-card="${esc(opts.id)}"` : ''} ${opts.tip ? `data-tip="${esc(opts.tip)}"` : ''}><div class="label">${esc(label)}${opts.gear ? `<i class="card-gear" data-card="${esc(opts.id)}" title="Card settings">⚙</i>` : ''}</div><div class="value">${opts.value}</div><div class="sub">${opts.sub || ''}</div></div>`;
    return opts.href ? `<a href="${esc(opts.href)}" class="tilelink">${inner}</a>` : inner;
  }

  // ---- horizontal bars. rows: [{ k, n, segment? }]; opts: { order, legend, max, keyLabel, scale: 'sqrt'|'linear', drill: bool, right, id }
  function bars(rows, title, opts = {}) {
    const { order, legend = true, max: maxLimit = 10, keyLabel = k => k, scale = 'sqrt', drill = true } = opts;
    const keys = [...new Set(rows.map(r => String(r.k ?? 'unknown')))];
    const sum = k => rows.filter(r => String(r.k ?? 'unknown') === k).reduce((x, r) => x + (r.n || 0), 0);
    const total = rows.reduce((a, r) => a + (r.n || 0), 0);
    if (order) keys.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
    else keys.sort((a, b) => sum(b) - sum(a));
    const shown = keys.slice(0, maxLimit);
    const f = scale === 'sqrt' ? Math.sqrt : (x => x);
    const max = Math.max(1, ...shown.map(k => f(sum(k))));
    const segs = [...new Set(rows.map(r => r.segment).filter(Boolean))];
    const body = shown.map(k => {
      const parts = rows.filter(r => String(r.k ?? 'unknown') === k); const n = sum(k);
      const width = Math.max(n ? 1.5 : 0, Math.round(f(n) / max * 1000) / 10);
      const inner = parts.map(p => { const h = drill && cfg.segmentHref(p.segment); const tip = `${esc(keyLabel(k))}${p.segment ? ' · ' + (cfg.segments[p.segment] || p.segment) : ''}: ${fmtN(p.n)} (${pct(p.n, n)}% of this bar, ${pct(p.n, total)}% of all)`; const color = cfg.segmentColors[p.segment] || 'var(--accent)'; return `<${h ? 'a' : 'span'} ${h ? `href="${h}?q=${encodeURIComponent(k)}"` : ''} class="seg" style="width:${p.n / n * 100}%;background:${color}" data-tip="${tip}"></${h ? 'a' : 'span'}>`; }).join('');
      return `<div class="row"><span data-tip="${esc(keyLabel(k))}">${esc(keyLabel(k))}</span><div class="track" style="width:${width}%">${inner}</div><span class="n"><b>${fmtN(n)}</b> <em>${pct(n, total)}%</em></span></div>`;
    }).join('') || '<div class="empty">—</div>';
    const rest = keys.length > shown.length ? `<div class="muted tiny" style="margin-top:4px">+${keys.length - shown.length} more · ${fmtN(keys.slice(maxLimit).reduce((a, k) => a + sum(k), 0))}</div>` : '';
    const sqrtNote = scale === 'sqrt' ? '<span class="muted" style="margin-left:auto" data-tip="Bar length uses a square-root scale so small values stay visible; the numbers are exact">√ scale</span>' : '';
    const legendHtml = legend && segs.length ? `<div class="legend">${segs.map(s => `<span><i style="background:${cfg.segmentColors[s] || 'var(--accent)'}"></i>${esc(cfg.segments[s] || s)}</span>`).join('')}${sqrtNote}</div>` : (sqrtNote ? `<div class="legend">${sqrtNote}</div>` : '');
    return `<div class="card chart" ${opts.id ? `data-card="${esc(opts.id)}"` : ''}><h3>${esc(title)}${opts.right || ''}</h3>${legendHtml}<div class="bars">${body}</div>${rest}</div>`;
  }

  // ---- donut: slices [{ k, n, color?, href? }], opts: { center: text, sub, size, right, id }
  function donut(slices, title, opts = {}) {
    const total = slices.reduce((a, s) => a + (s.n || 0), 0);
    const size = opts.size || 120, r = 46, c = 60, circ = 2 * Math.PI * r;
    const palette = ['var(--accent)', 'var(--c2)', 'var(--c3)', 'var(--accent2)', 'var(--warn)', 'var(--bad)', 'var(--muted)'];
    let offset = 0;
    const arcs = slices.filter(s => s.n > 0).map((s, i) => { const len = total ? s.n / total * circ : 0; const el = `<circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="${s.color || palette[i % palette.length]}" stroke-width="14" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" data-tip="${esc(s.k)}: ${fmtN(s.n)} (${pct(s.n, total)}%)"${s.href ? ` class="seg-link" data-href="${esc(s.href)}"` : ''}></circle>`; offset += len; return el; }).join('');
    const legend = slices.filter(s => s.n > 0).map((s, i) => `<div class="dl-row"${s.href ? ` data-href="${esc(s.href)}"` : ''}><i style="background:${s.color || palette[i % palette.length]}"></i><span>${esc(s.k)}</span><b>${fmtN(s.n)}</b><em>${pct(s.n, total)}%</em></div>`).join('');
    return `<div class="card chart donutcard" ${opts.id ? `data-card="${esc(opts.id)}"` : ''}><h3>${esc(title)}${opts.right || ''}</h3><div class="donut"><svg viewBox="0 0 120 120" width="${size}" height="${size}" style="transform:rotate(-90deg)">${total ? arcs : `<circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="var(--line)" stroke-width="14"/>`}</svg><div class="dcenter"><b>${opts.center != null ? opts.center : fmtN(total)}</b><span>${esc(opts.sub || '')}</span></div><div class="dlegend">${legend || '<span class="muted">—</span>'}</div></div></div>`;
  }

  // ---- trend line: points [{ x: label, y }], opts: { fmt, right, note, area, upIsGood, id }
  function trend(points, title, opts = {}) {
    const fmt = opts.fmt || fmtN;
    const pts = points.filter(p => p.y != null);
    const w = 300, h = 80, pad = 4;
    let svg;
    if (pts.length >= 2) {
      const ys = pts.map(p => p.y), min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
      const X = i => pad + i / (pts.length - 1) * (w - 2 * pad), Y = v => h - pad - (v - min) / span * (h - 2 * pad);
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
      const dots = pts.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="6" fill="transparent" data-tip="${esc(p.x)}: ${esc(fmt(p.y))}"/>`).join('');
      svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="trend">${opts.area !== false ? `<path d="${d} L${X(pts.length - 1).toFixed(1)},${h} L${X(0).toFixed(1)},${h} Z" fill="var(--accent)" opacity=".12"/>` : ''}<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>${dots}</svg>`;
    } else svg = `<div class="empty">${esc(opts.note || (pts.length === 1 ? 'One point so far; the line starts with the next one' : 'No history yet'))}</div>`;
    const first = pts[0], last = pts[pts.length - 1];
    const delta = pts.length >= 2 ? last.y - first.y : null;
    return `<div class="card chart" ${opts.id ? `data-card="${esc(opts.id)}"` : ''}><h3>${esc(title)}${opts.right || ''}</h3><div class="trendhead"><b>${last ? esc(fmt(last.y)) : '—'}</b>${delta != null ? `<span class="${delta > 0 ? (opts.upIsGood === false ? 'bad' : 'ok') : delta < 0 ? (opts.upIsGood === false ? 'ok' : 'bad') : 'muted'}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${esc(fmt(Math.abs(delta)))} since ${esc(first.x)}</span>` : ''}</div>${svg}</div>`;
  }

  // ---- time series: several lines over one time axis; hover shows every value at that moment.
  // sets: [{ name, color, points: [{ t, y }] }] (all sets share the same t values; see UI.alignSeries)
  // opts: { fmt, yMax, from, to, marks: [{ t, t2, color, tip }], right, id, height, note, empty }
  function series(sets, title, opts = {}) {
    const fmt = opts.fmt || fmtN;
    const W = 600, H = opts.height || 150, pad = 2;
    const all = sets.flatMap(s => s.points.filter(p => p.y != null).map(p => p.y));
    const times = sets.flatMap(s => s.points.map(p => p.t));
    const from = opts.from != null ? opts.from : Math.min(...times);
    const to = opts.to != null ? opts.to : Math.max(...times);
    let body;
    if (all.length < 2 || !(to > from)) body = '<div class="empty">' + esc(opts.empty || 'Not enough data yet') + '</div>';
    else {
      const max = opts.yMax || Math.max(...all) * 1.1 || 1;
      const X = t => pad + (t - from) / (to - from) * (W - 2 * pad), Y = v => H - pad - Math.min(v, max) / max * (H - 2 * pad);
      const lines = sets.map(s => { let d = '', pen = false; for (const p of s.points) { if (p.y == null) { pen = false; continue; } d += (pen ? 'L' : 'M') + X(p.t).toFixed(1) + ',' + Y(p.y).toFixed(1) + ' '; pen = true; } return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>'; }).join('');
      const marks = (opts.marks || []).map(m => '<rect x="' + X(m.t).toFixed(1) + '" y="0" width="' + Math.max(2, X(m.t2 || m.t) - X(m.t)).toFixed(1) + '" height="' + H + '" fill="' + (m.color || 'var(--bad)') + '" opacity=".25" data-tip="' + esc(m.tip || '') + '"/>').join('');
      const ts = sets[0].points.map(p => p.t);
      const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const hover = ts.map((t, i) => { const x0 = i ? (X(ts[i - 1]) + X(t)) / 2 : 0, x1 = i < ts.length - 1 ? (X(t) + X(ts[i + 1])) / 2 : W; const tip = when(t) + ' · ' + sets.map(s => s.name + ' ' + (s.points[i] && s.points[i].y != null ? fmt(s.points[i].y) : '—')).join(' · '); return '<rect x="' + x0.toFixed(1) + '" y="0" width="' + Math.max(0.5, x1 - x0).toFixed(1) + '" height="' + H + '" fill="transparent" data-tip="' + esc(tip) + '"/>'; }).join('');
      const tl = (t) => new Date(t).toLocaleString([], to - from > 3 * 86400000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
      body = '<div class="series"><span class="ymax">' + esc(fmt(max)) + '</span><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px"><line x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '" stroke="var(--line)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>' + marks + lines + hover + '</svg><div class="xaxis"><span>' + esc(tl(from)) + '</span><span>' + esc(tl(from + (to - from) / 2)) + '</span><span>' + esc(tl(to)) + '</span></div></div>';
    }
    const legend = '<div class="legend">' + sets.map(s => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('') + (opts.note ? '<span class="muted" style="margin-left:auto">' + esc(opts.note) + '</span>' : '') + '</div>';
    return '<div class="card chart" ' + (opts.id ? 'data-card="' + esc(opts.id) + '"' : '') + '><h3>' + esc(title) + (opts.right || '') + '</h3>' + legend + body + '</div>';
  }

  // ---- columns: vertical stacked bars, one per label. points: [{ x, values: [..], tip? }], opts: { sets: [{ name, color }], fmt, note, empty, right, id, height }
  function columns(points, title, opts = {}) {
    const fmt = opts.fmt || fmtN;
    const sets = opts.sets || [{ name: '', color: 'var(--accent)' }];
    const W = 600, H = opts.height || 150, pad = 2;
    const pts = (points || []).filter(p => p && Array.isArray(p.values));
    const totals = pts.map(p => p.values.reduce((a, v) => a + (v || 0), 0));
    const max = Math.max(0, ...totals);
    let body;
    if (!pts.length || !max) body = '<div class="empty">' + esc(opts.empty || 'No data yet') + '</div>';
    else {
      const n = pts.length, slot = (W - 2 * pad) / n, bw = Math.max(1, slot * 0.72);
      const cols = pts.map((p, i) => {
        let y = H - pad; const x = pad + i * slot + (slot - bw) / 2;
        const parts = p.values.map((v, j) => { const h = (v || 0) / max * (H - 2 * pad); y -= h; return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (sets[j] ? sets[j].color : 'var(--accent)') + '"/>'; }).join('');
        const tip = p.tip || (p.x + ': ' + p.values.map((v, j) => (sets[j] && sets[j].name ? sets[j].name + ' ' : '') + fmt(v || 0)).join(' · '));
        return '<g data-tip="' + esc(tip) + '"><rect x="' + (pad + i * slot).toFixed(1) + '" y="0" width="' + slot.toFixed(1) + '" height="' + H + '" fill="transparent"/>' + parts + '</g>';
      }).join('');
      body = '<div class="series"><span class="ymax">' + esc(fmt(max)) + '</span><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px"><line x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '" stroke="var(--line)" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>' + cols + '</svg><div class="xaxis"><span>' + esc(pts[0].x) + '</span><span>' + esc(pts[Math.floor(n / 2)].x) + '</span><span>' + esc(pts[n - 1].x) + '</span></div></div>';
    }
    const legend = '<div class="legend">' + sets.filter(s => s.name).map(s => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('') + (opts.note ? '<span class="muted" style="margin-left:auto">' + esc(opts.note) + '</span>' : '') + '</div>';
    return '<div class="card chart" ' + (opts.id ? 'data-card="' + esc(opts.id) + '"' : '') + '><h3>' + esc(title) + (opts.right || '') + '</h3>' + legend + body + '</div>';
  }

  // ---- tooltip: one floating element for every [data-tip]; [data-href] navigates on click
  let tipEl = null;
  function ensureTip() { if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tooltip'; tipEl.hidden = true; document.body.append(tipEl); } return tipEl; }
  document.addEventListener('mouseover', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (!t) return; const el = ensureTip(); el.textContent = t.dataset.tip; el.hidden = false; });
  document.addEventListener('mousemove', e => { if (!tipEl || tipEl.hidden) return; const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8), y = e.clientY + 16; tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px'; });
  document.addEventListener('mouseout', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && tipEl) tipEl.hidden = true; });
  document.addEventListener('click', e => { const t = e.target.closest && e.target.closest('[data-href]'); if (t) location.hash = t.dataset.href; });

  window.Cards = { configure, number, bars, donut, trend, series, columns, colorFor };
})();
