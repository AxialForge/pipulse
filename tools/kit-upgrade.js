#!/usr/bin/env node
'use strict';
// Bring a newer Bracket kit into this app. kit/ is vendored and never edited in an app, so an
// upgrade is a whole-folder replacement, shown as a diff first.
//
//   node tools/kit-upgrade.js                       compare with AxialForge/bracket@main (downloaded)
//   node tools/kit-upgrade.js --from ../Bracket     compare with a local checkout
//   node tools/kit-upgrade.js --from AxialForge/bracket@v0.2.0
//   node tools/kit-upgrade.js --apply               replace kit/ with the source's kit/
//
// Read CHANGELOG.md in the source for what changed between the two kit versions.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const apply = args.includes('--apply');
const from = opt('--from') || 'AxialForge/bracket@main';

async function sourceKit() {
  if (fs.existsSync(path.join(from, 'kit', 'VERSION'))) return path.join(from, 'kit');
  if (fs.existsSync(path.join(from, 'VERSION'))) return from;
  const m = /^([^/@]+\/[^/@]+)(?:@(.+))?$/.exec(from);
  if (!m) throw new Error(`--from must be a folder or owner/repo[@ref]: ${from}`);
  const [, repo, ref = 'main'] = m;
  const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-up-'));
  const r = await fetch(url, { headers: { 'user-agent': 'bracket-kit-upgrade' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${url}`);
  fs.writeFileSync(path.join(tmp, 'src.tar.gz'), Buffer.from(await r.arrayBuffer()));
  execFileSync('tar', ['-xzf', 'src.tar.gz'], { cwd: tmp });
  const dir = fs.readdirSync(tmp).find(d => fs.statSync(path.join(tmp, d)).isDirectory());
  return path.join(tmp, dir, 'kit');
}
function tree(dir, base = dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { for (const [k, v] of tree(p, base)) out.set(k, v); }
    else out.set(path.relative(base, p).split(path.sep).join('/'), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
  }
  return out;
}

(async () => {
  const src = await sourceKit();
  const local = path.join(root, 'kit');
  const a = tree(local), b = tree(src);
  const va = fs.existsSync(path.join(local, 'VERSION')) ? fs.readFileSync(path.join(local, 'VERSION'), 'utf8').trim() : '?';
  const vb = fs.readFileSync(path.join(src, 'VERSION'), 'utf8').trim();
  const added = [...b.keys()].filter(k => !a.has(k)), removed = [...a.keys()].filter(k => !b.has(k)), changed = [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k));
  console.log(`kit ${va} (here) → ${vb} (${from})`);
  for (const k of added) console.log('  + ' + k);
  for (const k of changed) console.log('  ~ ' + k);
  for (const k of removed) console.log('  - ' + k);
  if (!added.length && !changed.length && !removed.length) { console.log('  nothing to do: the kits are identical'); return; }
  if (!apply) { console.log('\nRun again with --apply to take the new kit (kit/ is replaced as a whole; app/ is untouched).'); return; }
  const backup = path.join(root, `.kit-${va}-backup`);
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(local)) fs.renameSync(local, backup);
  fs.cpSync(src, local, { recursive: true });
  console.log(`\napplied: kit ${vb}. The previous kit is in ${path.basename(backup)} (delete it once the app runs). Now run: npm test`);
})().catch(e => { console.error(e.message); process.exit(1); });
