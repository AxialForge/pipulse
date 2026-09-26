'use strict';
/* The dashboard: a grid of cards picked from a catalog the app supplies, arranged and sized per
   account. Sizes are grid columns out of six: S = 1 (a tile), M = 2, L = 3 (half width), XL = 6.
   Edit mode adds a handle to every card (drag to move, ▲ ▼ for phones, size buttons, options,
   remove) and an "Add card" picker. Layouts are saved through api.prefs (per account on the web
   server, per machine on the desktop; guests see the admin's) with a copy in this browser.

     Dash.mount({
       catalog: [{ type, group, label, help, sizes, def, period?, rule?, list?, guest?, render(ctx) }],
       defaults: ['wan', 'clients', { type: 'chart', size: 'xl' }],
       load: async () => ({ d, S })      // whatever the renders need; called once per render
       header: (ctx) => html,             // optional line under the title
       guest: () => bool,                 // hide cards without `guest: true`
       title: 'Dashboard',
     });
     UI.views.dashboard = Dash.render;

   render(ctx) gets { ...loaded, range, o (the card's options), rule, item, def } and returns HTML
   (may be async). A card that returns null is skipped. Colour-rule tiles should use UI.tile with
   Cards.colorFor(num, ctx.rule) so per-card thresholds apply. */
(function () {
  const { $, esc, store, toast, openModal, closeModal, RANGE_LABEL, rangePicker } = window.UI;
  const api = () => window.UI.api();
  const SIZES = ['s', 'm', 'l', 'xl'];
  const SIZE_LABEL = { s: 'Small', m: 'Medium', l: 'Half width', xl: 'Full width' };
  const uid = () => 'c' + Math.random().toString(36).slice(2, 8);
  let cfg = { catalog: [], defaults: [], load: async () => ({}), header: null, guest: () => window.UI.isGuest(), title: 'Dashboard', prefKey: 'dashboard' };
  let byType = {}, layout = null, editing = false, layoutSource = 'default';
  let range = store.get('range', '24h');

  function mount(options) {
    cfg = { ...cfg, ...options };
    byType = Object.fromEntries(cfg.catalog.map(c => [c.type, c]));
    layout = null;
  }
  const G = () => !!cfg.guest();
  const ruleOf = (def, o) => (def.rule ? { higher: !!def.rule.higher, warn: o.warn != null && o.warn !== '' ? Number(o.warn) : def.rule.warn, bad: o.bad != null && o.bad !== '' ? Number(o.bad) : def.rule.bad } : null);

  // ---- layout persistence ---------------------------------------------------------------------
  const normalise = (cards) => (Array.isArray(cards) ? cards : []).map(c => (typeof c === 'string' ? { type: c } : c)).filter(c => c && byType[c.type]).map(c => ({ id: c.id || uid(), type: c.type, size: SIZES.includes(c.size) ? c.size : null, o: c.o && typeof c.o === 'object' ? c.o : {} }));
  async function loadLayout() {
    let cards = null;
    try { const p = await api().prefs.get(); if (p && p[cfg.prefKey] && Array.isArray(p[cfg.prefKey].cards)) { cards = p[cfg.prefKey].cards; layoutSource = 'account'; } } catch { /* offline or not allowed */ }
    if (!cards) { try { const c = JSON.parse(store.get(cfg.prefKey, 'null')); if (Array.isArray(c) && !G()) { cards = c; layoutSource = 'browser'; } } catch { /* ignore */ } }
    layout = normalise(cards);
    if (!layout.length) { layout = normalise(cfg.defaults); layoutSource = 'default'; }
  }
  function saveLayout() {
    const cards = layout.map(c => ({ id: c.id, type: c.type, size: c.size, o: c.o }));
    store.set(cfg.prefKey, JSON.stringify(cards));
    if (!G()) api().prefs.set({ [cfg.prefKey]: { v: 1, cards } }).then(() => { layoutSource = 'account'; }).catch(e => toast('Layout not saved: ' + e.message, true));
  }

  // ---- rendering --------------------------------------------------------------------------------
  const handle = (item, def, size) => `<div class="dhandle" title="drag to move"><span class="grip">⋮⋮</span><b>${esc(item.o.title || def.label)}</b><span class="grow"></span>${def.sizes.map(s => `<button class="tiny ${s === size ? 'on' : ''}" data-act="size" data-size="${s}" title="${SIZE_LABEL[s]}">${s.toUpperCase()}</button>`).join('')}<button class="tiny" data-act="up" title="move up">▲</button><button class="tiny" data-act="down" title="move down">▼</button><button class="tiny" data-act="opts" title="options">⚙</button><button class="tiny" data-act="remove" title="remove">✕</button></div>`;
  async function render() {
    const view = window.UI.view();
    const loaded = await cfg.load({ range });
    if (!layout) await loadLayout();
    const cards = await Promise.all(layout.map(async (item) => {
      const def = byType[item.type];
      if (!def || (G() && !def.guest)) return '';
      const size = def.sizes.includes(item.size) ? item.size : def.def;
      const o = item.o || {};
      const r = def.period && RANGE_LABEL[o.range] ? o.range : range;
      let inner;
      try { inner = await def.render({ ...loaded, range: r, o, rule: ruleOf(def, o), item, def }); }
      catch (e) { inner = `<div class="card"><h3>${esc(def.label)}</h3><div class="empty">${esc(e.message)}</div></div>`; }
      if (inner == null) return '';
      if (o.title) inner = inner.replace(/(<div class="label">)[^<]*|(<h3>)[^<]*/, (m, a, b) => (a || b) + esc(o.title));
      return `<div class="dcard sz-${size}" data-id="${item.id}" ${editing ? 'draggable="true"' : ''}>${editing ? handle(item, def, size) : ''}${inner}</div>`;
    }));
    const bar = editing
      ? `<button class="small primary" id="dashAdd">+ Add card</button><button class="small" id="dashReset">Reset to default</button><span class="muted small">${layout.length} cards · drag by the handle, or use ▲ ▼</span><span class="grow"></span><button class="small primary" id="dashDone">Done</button>`
      : `<span class="muted small">Charts</span>${rangePicker(range)}<span class="grow"></span>${G() ? '' : '<button class="small" id="dashEdit">Edit dashboard</button>'}`;
    const header = typeof cfg.header === 'function' ? cfg.header(loaded) : '';
    view.innerHTML = `<h1>${esc(cfg.title)}</h1>${header}<div class="toolbar dashbar">${bar}</div><div class="dash ${editing ? 'editing' : ''}" id="dashGrid">${cards.join('') || '<div class="empty" style="grid-column:span 6">No cards. Press Edit dashboard → Add card.</div>'}</div>`;
    wire();
  }

  function wire() {
    const sel = $('#rangeSel'); if (sel) sel.onchange = (e) => { range = e.target.value; store.set('range', range); render(); };
    if ($('#dashEdit')) $('#dashEdit').onclick = () => { editing = true; render(); };
    if ($('#dashDone')) $('#dashDone').onclick = () => { editing = false; saveLayout(); render(); };
    if ($('#dashReset')) $('#dashReset').onclick = () => { if (!confirm('Put the default cards back? Your arrangement is replaced.')) return; layout = normalise(cfg.defaults); saveLayout(); render(); };
    if ($('#dashAdd')) $('#dashAdd').onclick = openAdd;
    const grid = $('#dashGrid'); if (!grid) return;
    grid.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const card = b.closest('.dcard'); const i = layout.findIndex(c => c.id === card.dataset.id); if (i < 0) return;
      const act = b.dataset.act;
      if (act === 'size') layout[i].size = b.dataset.size;
      else if (act === 'up' && i > 0) [layout[i - 1], layout[i]] = [layout[i], layout[i - 1]];
      else if (act === 'down' && i < layout.length - 1) [layout[i + 1], layout[i]] = [layout[i], layout[i + 1]];
      else if (act === 'remove') layout.splice(i, 1);
      else if (act === 'opts') return openOptions(layout[i]);
      saveLayout(); render();
    };
    if (!editing) return;
    let dragId = null;
    grid.querySelectorAll('.dcard').forEach(c => {
      c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch { /* ignore */ } });
      c.addEventListener('dragend', () => { dragId = null; grid.querySelectorAll('.dcard').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
      c.addEventListener('dragover', (e) => { if (!dragId || c.dataset.id === dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const r = c.getBoundingClientRect(); const before = (e.clientX - r.left) < r.width / 2; c.classList.toggle('drop-before', before); c.classList.toggle('drop-after', !before); });
      c.addEventListener('dragleave', () => c.classList.remove('drop-before', 'drop-after'));
      c.addEventListener('drop', (e) => {
        e.preventDefault(); if (!dragId || c.dataset.id === dragId) return;
        const before = c.classList.contains('drop-before');
        const from = layout.findIndex(x => x.id === dragId); const item = layout.splice(from, 1)[0];
        let to = layout.findIndex(x => x.id === c.dataset.id); if (!before) to++;
        layout.splice(to, 0, item);
        dragId = null; saveLayout(); render();
      });
    });
  }

  function openOptions(item) {
    const def = byType[item.type]; const o = item.o || {};
    const card = openModal(`<h2>${esc(def.label)}</h2><div class="path">${esc(def.help || '')}</div>
      <div class="field"><label>Title</label><input type="text" id="coTitle" value="${esc(o.title || '')}" placeholder="${esc(def.label)}"></div>
      <div class="field"><label>Size</label><select id="coSize">${def.sizes.map(s => `<option value="${s}" ${(item.size || def.def) === s ? 'selected' : ''}>${SIZE_LABEL[s]}</option>`).join('')}</select></div>
      ${def.period ? `<div class="field"><label>Period</label><select id="coRange"><option value="">follow the dashboard (${RANGE_LABEL[range]})</option>${Object.entries(RANGE_LABEL).map(([k, v]) => `<option value="${k}" ${o.range === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>` : ''}
      ${def.rule ? `<div class="field"><label>Colour thresholds</label><div class="inline">amber ${def.rule.higher ? 'at or below' : 'at or above'} <input type="number" id="coWarn" value="${o.warn ?? def.rule.warn}" style="width:90px"> · red ${def.rule.higher ? 'at or below' : 'at or above'} <input type="number" id="coBad" value="${o.bad ?? def.rule.bad}" style="width:90px"></div><div class="hint">Defaults: ${def.rule.warn} / ${def.rule.bad}. Leave a box empty to use the default.</div></div>` : ''}
      ${def.list ? `<div class="field"><label>Rows</label><input type="number" id="coLimit" min="3" max="40" value="${o.limit || ''}" placeholder="default" style="width:90px"></div>` : ''}
      ${typeof def.options === 'function' ? def.options(o) : ''}
      <div class="actions"><span class="grow"></span><button id="coCancel">Cancel</button><button class="primary" id="coSave">Save</button></div>`);
    $('#coCancel', card).onclick = closeModal;
    $('#coSave', card).onclick = () => {
      const next = { ...o };
      const title = $('#coTitle', card).value.trim(); if (title) next.title = title; else delete next.title;
      item.size = $('#coSize', card).value;
      if (def.period) { const r = $('#coRange', card).value; if (r) next.range = r; else delete next.range; }
      if (def.rule) { const w = $('#coWarn', card).value, b = $('#coBad', card).value; if (w !== '') next.warn = Number(w); else delete next.warn; if (b !== '') next.bad = Number(b); else delete next.bad; }
      if (def.list) { const l = Number($('#coLimit', card).value); if (l) next.limit = l; else delete next.limit; }
      if (typeof def.readOptions === 'function') Object.assign(next, def.readOptions(card, next));
      item.o = next; closeModal(); saveLayout(); render();
    };
  }

  function openAdd() {
    const groups = [...new Set(cfg.catalog.map(c => c.group))];
    const counts = layout.reduce((m, c) => { m[c.type] = (m[c.type] || 0) + 1; return m; }, {});
    const card = openModal(`<h2>Add a card</h2><div class="path">Cards can be added more than once, for example the same chart with two periods.</div><div class="catalog">${groups.map(g => `<h3>${esc(g)}</h3><div class="catgrid">${cfg.catalog.filter(c => c.group === g && !(G() && !c.guest)).map(c => `<div class="catcard"><b>${esc(c.label)}${counts[c.type] ? ` <span class="muted tiny">× ${counts[c.type]}</span>` : ''}</b><span class="muted tiny">${esc(c.help || '')}</span><button class="small" data-add="${c.type}">Add</button></div>`).join('')}</div>`).join('')}</div><div class="actions"><span class="grow"></span><button id="caClose">Close</button></div>`);
    $('#caClose', card).onclick = closeModal;
    card.querySelectorAll('[data-add]').forEach(b => { b.onclick = () => { const def = byType[b.dataset.add]; layout.push({ id: uid(), type: def.type, size: def.def, o: {} }); saveLayout(); closeModal(); render().then(() => { const n = $('#dashGrid').lastElementChild; if (n) n.scrollIntoView({ behavior: 'smooth', block: 'center' }); }); }; });
  }

  window.Dash = { mount, render, editing: () => editing, reset: () => { layout = null; }, range: () => range };
})();
