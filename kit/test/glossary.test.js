'use strict';
// The glossary: term markup, escaping, [[links]], app overrides, and that the kit's own entries
// only point at terms that exist. glossary.js is a browser script; it runs here in a vm with a bare
// window and no document (its listeners are skipped then).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/glossary.js'), 'utf8'), { window });
  return window.Glossary;
}

const G = load();

// ---- the kit's entries are complete and their links resolve ----
const LINK = /\[\[([a-z0-9][a-z0-9_.-]*)(?:\|[^\]]+)?\]\]/gi;
for (const t of G.all()) {
  assert.ok(t.term && t.short, `${t.key}: needs term and short`);
  for (const r of t.related) assert.ok(G.get(r), `${t.key}: related '${r}' is not a term`);
  for (const field of ['long', 'healthy', 'fix']) for (const m of String(t[field] || '').matchAll(LINK)) assert.ok(G.get(m[1]), `${t.key}.${field}: [[${m[1]}]] is not a term`);
}

// ---- markup ----
const html = G.term('cpu', 'CPU');
assert.ok(html.includes('class="term"') && html.includes('data-term="cpu"') && html.includes('>CPU<'));
assert.strictEqual(G.term('no-such-term', 'a < b'), 'a &lt; b', 'unknown key: plain escaped text, never a broken page');
assert.ok(G.term('cpu').includes('>CPU usage<'), 'no text: the entry\'s own name');
assert.ok(G.term('cpu', '<img onerror=x>').includes('&lt;img'), 'labels are escaped');

// ---- rich text: paragraphs, bold, links, escaping ----
const r = G.rich('One **two** [[swap]] and [[memory|RAM]] <b>no</b>\n\nSecond');
assert.strictEqual((r.match(/<p>/g) || []).length, 2);
assert.ok(r.includes('<b>two</b>'));
assert.ok(r.includes('data-term="swap"') && r.includes('>RAM<'));
assert.ok(r.includes('&lt;b&gt;no&lt;/b&gt;'), 'raw HTML in entries is escaped');

// ---- an app's entry replaces the kit's ----
G.add({ cpu: { term: 'Processor', short: 'Said the app\'s way.' }, widget: { term: 'Widget', short: 'x', related: ['cpu'] } });
assert.strictEqual(G.get('cpu').term, 'Processor');
assert.strictEqual(G.get('cpu').related.length, 0, 'defaults filled in'); // (a vm array: compare by length)
assert.ok(G.get('widget'));

console.log('glossary tests passed');
