'use strict';
/* Glossary: plain-English definitions for the terms an app's pages use. A term is marked with
   UI.term(key, text); hovering it shows the one-line definition, clicking (or Enter, or a tap on a
   phone) opens a side panel with the full explanation, what a healthy value looks like, what to do
   when it isn't, and related terms that open in the same panel. Loads after ui.js.

     Glossary.add({
       swap: { term: 'Swap', short: 'Disk space used as overflow memory.',
               long: 'Paragraphs, separated by a blank line. [[memory]] links another term; [[memory|RAM]] with a label.',
               healthy: 'What good looks like.', fix: 'What to do when it is not.', related: ['memory'] },
     });
     tile('', UI.term('swap', 'Swap'), '12%')      // any label, heading or sentence

   The kit ships the terms its own pages use (System, Security, About). An app's entries replace
   kit entries with the same key, so an app can say it better for its own audience. Text is
   escaped; the only markup is [[key]] / [[key|label]], **bold** and blank-line paragraphs. */
(function () {
  const UI = window.UI || {};
  const esc = UI.esc || (s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const terms = {};
  const LINK = /\[\[([a-z0-9][a-z0-9_.-]*)(?:\|([^\]]+))?\]\]/gi;

  function add(map) { for (const [k, v] of Object.entries(map || {})) terms[k] = { key: k, related: [], ...v }; }
  const get = (key) => terms[key] || null;
  const all = () => Object.values(terms).sort((a, b) => a.term.localeCompare(b.term));

  /** HTML for a marked term. Unknown keys render as plain text, so a page never breaks on a typo. */
  function term(key, text) {
    const t = terms[key];
    const label = text == null ? (t ? t.term : key) : text;
    if (!t) return esc(label);
    return `<span class="term" data-term="${esc(key)}" tabindex="0" role="button" aria-label="${esc(label)}: what does this mean?">${esc(label)}</span>`;
  }
  // Escaped text with [[key]] links, **bold** and blank-line paragraphs.
  function rich(text) {
    return String(text || '').split(/\n\s*\n/).map(p => `<p>${esc(p.trim())
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(LINK, (_, k, lbl) => term(k, lbl ? lbl : undefined))}</p>`).join('');
  }

  // ---- hover tooltip ---------------------------------------------------------------------------
  let tip = null, tipFor = null, tipTimer = null;
  function showTip(el) {
    const t = terms[el.dataset.term]; if (!t) return;
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip gloss-tip'; tip.hidden = true; document.body.append(tip); }
    tip.innerHTML = `<b>${esc(t.term)}</b> · ${esc(t.short || '')}<span class="gloss-more">Click for more</span>`;
    tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const below = r.bottom + 8 + h < innerHeight;
    tip.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    tip.style.top = (below ? r.bottom + 8 : r.top - h - 8) + 'px';
    tipFor = el;
  }
  function hideTip() { clearTimeout(tipTimer); if (tip) tip.hidden = true; tipFor = null; }

  // ---- side panel -----------------------------------------------------------------------------
  let panel = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('aside');
    panel.className = 'gloss'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Definition');
    document.body.append(panel);
    panel.addEventListener('click', (e) => { if (e.target.closest('.gloss-close')) close(); });
    return panel;
  }
  function open(key) {
    const t = terms[key]; if (!t) return;
    hideTip();
    const p = ensurePanel();
    const rel = (t.related || []).filter(k => terms[k]);
    p.innerHTML = `<div class="gloss-head"><div><div class="gloss-kicker">What does this mean?</div><h2>${esc(t.term)}</h2></div><button class="gloss-close small" aria-label="Close">✕</button></div>
      <p class="gloss-short">${esc(t.short || '')}</p>
      ${t.long ? `<div class="gloss-body">${rich(t.long)}</div>` : ''}
      ${t.healthy ? `<div class="gloss-box ok"><b>Healthy</b>${rich(t.healthy)}</div>` : ''}
      ${t.fix ? `<div class="gloss-box warn"><b>If it isn't</b>${rich(t.fix)}</div>` : ''}
      ${rel.length ? `<div class="gloss-rel"><b>Related</b><div>${rel.map(k => `<span class="chip term" data-term="${esc(k)}" tabindex="0" role="button">${esc(terms[k].term)}</span>`).join('')}</div></div>` : ''}`;
    p.hidden = false;
    p.scrollTop = 0;
    // Force a layout, then add .open, so the slide-in runs without waiting for an animation frame
    // (a paused or background tab never fires one, which left the panel invisible at opacity 0).
    void p.offsetWidth;
    p.classList.add('open');
    const btn = p.querySelector('.gloss-close'); if (btn) btn.focus({ preventScroll: true });
  }
  function close() { if (!panel) return; panel.classList.remove('open'); panel.hidden = true; }

  // ---- wiring: one set of delegated listeners for every term on every page ---------------------
  if (typeof document !== 'undefined' && document.addEventListener) {
    const coarse = () => window.matchMedia && window.matchMedia('(hover: none)').matches;
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest && e.target.closest('.term');
      if (!el || el === tipFor || coarse() || el.closest('.gloss')) return;
      clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el), 250);
    });
    document.addEventListener('mouseout', (e) => { const el = e.target.closest && e.target.closest('.term'); if (el && !el.contains(e.relatedTarget)) hideTip(); });
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('.term');
      if (el) { e.preventDefault(); e.stopPropagation(); open(el.dataset.term); return; }
      if (panel && !panel.hidden && !e.target.closest('.gloss')) close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && !panel.hidden) { close(); return; }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('term')) { e.preventDefault(); open(e.target.dataset.term); }
    });
    window.addEventListener('hashchange', () => { hideTip(); close(); });
    window.addEventListener('scroll', hideTip, true);
  }

  // ---- the kit's own terms (System, Security and About pages) -----------------------------------
  add({
    health: { term: 'Health', short: 'One-word summary of whether anything on this machine needs your attention.',
      long: 'Health rolls the individual checks (disk space, temperature, throttling and the like) into one answer: **All good**, **Attention** (worth a look soon) or **Problem** (act now). The line under it names the check that tripped.',
      healthy: 'All good, with "no rule triggered" underneath.', fix: 'Read the reason under the word: it names the check. Each one has its own entry here.', related: ['disk', 'soc-temp', 'throttling'] },
    cpu: { term: 'CPU usage', short: 'How busy the processor is, as a share of everything it could do.',
      long: '100% means every core is fully busy. Short spikes are normal (installing, compiling, a backup); a machine sitting near 100% for minutes is overloaded and everything on it gets slow.\n\nOn a Raspberry Pi, sustained high CPU also raises the [[soc-temp|temperature]].',
      healthy: 'Mostly under 50%, with short spikes.', fix: 'Find the busy program (the processes or services list), then limit it, move it to another machine or schedule it for quiet hours.', related: ['load', 'cores', 'soc-temp'] },
    cores: { term: 'Cores', short: 'Independent processors inside the CPU; each can run one thing at a time.',
      long: 'A Raspberry Pi 4 or 5 has 4 cores. A program that can only use one core tops out at "100% of one core", which on a 4-core Pi is 25% of the whole CPU. That is why a single stuck program can look like only 25% usage.',
      related: ['cpu', 'load'] },
    load: { term: 'Load average', short: 'How many programs were running or waiting for the CPU, averaged over 1, 5 and 15 minutes.',
      long: 'Compare it with the number of [[cores]]. On a 4-core Pi, a load of 4 means the CPU is exactly fully booked; above 4, programs queue up and wait. The three numbers show the trend: 1-minute higher than 15-minute means it is getting busier.\n\nLoad also counts programs waiting on a slow disk, so a failing SD card can show high load with low CPU.',
      healthy: 'Below the number of cores (under 4 on a Pi 4 or 5).', fix: 'If CPU is also high, find the busy program. If CPU is low but load is high, suspect the disk (a slow or failing SD card, or a stuck network share).', related: ['cpu', 'cores', 'disk'] },
    memory: { term: 'Memory (RAM)', short: 'Fast working space programs use while they run.',
      long: 'The percentage is memory in use by programs. Linux also borrows free memory as a disk cache and hands it back instantly, so that part is not counted as "used".\n\nWhen memory runs out the system starts using [[swap]], which is far slower, and in the end the kernel kills a program to free memory (the OOM killer).',
      healthy: 'Under about 80%.', fix: 'Find the program using the most memory, restart it if it has been growing (a leak), or give it a memory cap so it can not take the whole machine down.', related: ['swap'] },
    swap: { term: 'Swap', short: 'Disk space used as overflow when RAM is full.',
      long: 'Swap lets a machine survive a memory squeeze instead of killing programs, but disk is thousands of times slower than RAM, so heavy swapping makes everything crawl. On a Raspberry Pi the swap lives on the SD card, and constant swapping also wears the card out.',
      healthy: 'Little or none used.', fix: 'Heavy swap use means [[memory]] is too small for what is running. Reduce what runs or cap the biggest program.', related: ['memory', 'disk'] },
    'soc-temp': { term: 'SoC temperature', short: 'How hot the Raspberry Pi\'s main chip is.',
      long: 'The SoC (system on a chip) holds the CPU and GPU. The Pi\'s firmware protects it: from about 80 °C it slows itself down ([[throttling]]), and at 85 °C it throttles hard. Slowing down is safe but it makes everything on the Pi slower.',
      healthy: 'Under 70 °C; 40–60 °C is typical with a heatsink or case fan.', fix: 'Add a heatsink or fan, give the case airflow, move it out of direct sun or a closed cupboard, or find the program keeping the CPU busy.', related: ['throttling', 'cpu'] },
    throttling: { term: 'Throttling', short: 'The Pi slowing itself down to protect itself from heat or low power.',
      long: 'The Pi\'s firmware lowers the CPU speed when it is too hot ([[soc-temp]]) or when the power supply cannot keep up ([[under-voltage]]). "Now" means it is happening right now; "earlier" or "since boot" means it happened at some point since the Pi last started.',
      healthy: 'No throttling or under-voltage since boot.', fix: 'Under-voltage: use the official power supply (5.1 V 3 A for a Pi 4, 5 A for a Pi 5) and a short, thick cable. Heat: see temperature.', related: ['under-voltage', 'soc-temp'] },
    'under-voltage': { term: 'Under-voltage', short: 'The power supply is delivering less than the Pi needs.',
      long: 'Weak phone chargers, long or thin USB cables and power-hungry USB drives are the usual causes. Under-voltage makes the Pi [[throttling|throttle]], and it can corrupt the SD card when it strikes during a write.',
      healthy: 'Never, not even once since boot.', fix: 'Use the official Raspberry Pi power supply, a short good cable, and a powered USB hub for hard drives.', related: ['throttling', 'disk'] },
    disk: { term: 'Disk space', short: 'How full the storage is.',
      long: 'When a disk fills up, programs can not save data, databases stop and logs are lost. On a Raspberry Pi the main disk is usually the SD card; a USB SSD is faster and lasts longer.',
      healthy: 'Under about 80% full.', fix: 'Delete what you no longer need, shorten how long logs and history are kept, or move bulky data to a bigger drive or the NAS.', related: ['load'] },
    network: { term: 'Network rate', short: 'How much data this machine is sending (↑) and receiving (↓) right now.',
      long: 'Shown per second, averaged over the last few seconds. It is this machine\'s own traffic, not the whole home network.', related: [] },
    uptime: { term: 'Uptime', short: 'How long since the machine (or the app) last started.',
      long: 'A machine that restarts unexpectedly shows a short uptime. Many small servers run for weeks between planned restarts for updates.', related: [] },
    session: { term: 'Session', short: 'One signed-in browser. Each device you sign in on gets its own.',
      long: 'Sessions end after a number of days, when you sign out, or when an admin signs them out here. Changing your password signs out every other session.', related: ['reauth', 'two-factor'] },
    'two-factor': { term: 'Two-factor codes (2FA)', short: 'A 6-digit code from an app on your phone, needed on top of the password.',
      long: 'Even if someone learns the password, they can not sign in without the phone. Any authenticator app works (Google Authenticator, Aegis, Bitwarden, 1Password).',
      healthy: 'On for admin accounts.', related: ['session', 'reauth'] },
    'lan-only': { term: 'LAN only', short: 'Only devices on your home network may connect.',
      long: 'Requests from outside private address ranges are refused before they reach the sign-in page. To use the app away from home, connect to home with a VPN first rather than turning this off.',
      healthy: 'On.', related: ['reverse-proxy'] },
    guest: { term: 'Guest access', short: 'Lets anyone on the LAN open a limited, read-only view without an account.',
      long: 'Only the pages the app marks as guest-safe are shown; nothing can be changed.', healthy: 'Off, unless you share a view on purpose.', related: ['lan-only'] },
    reauth: { term: 'Re-enter password', short: 'Risky actions ask for your password again, valid for a few minutes.',
      long: 'Security changes and destructive actions ask again even when you are signed in, so a browser left open can not be used to do damage.', related: ['session'] },
    'status-url': { term: 'Status URL', short: 'A private read-only address for Home Assistant or scripts.',
      long: 'Anyone with the address (it contains a key) can read the status JSON, nothing more. Make a new key if the address leaks; the old one stops working at once.', related: [] },
    'reverse-proxy': { term: 'Reverse proxy', short: 'A web server in front of the app that handles names and HTTPS.',
      long: 'On the home server this is Caddy: it answers https://name.home, holds the certificates and passes each request on to the app\'s own port. The app then trusts the forwarded client address only from the proxy on the same machine.', related: ['lan-only'] },
  });

  const api = { add, get, all, term, open, close, rich };
  window.Glossary = api;
  if (window.UI) window.UI.term = term;
})();
