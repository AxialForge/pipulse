'use strict';
// SQLite store on Node's built-in node:sqlite. No native addon, no npm install.
//
// Times are integer milliseconds since the epoch (UTC) everywhere; the renderer formats them.
// The app supplies its base schema and an append-only list of migrations; migrate() copies the
// file aside before it runs anything. Two small tables come with the kit: `kv` (remembered values)
// and `jobs` (last run / last error per named job).
//
//   const db = new Db(file, { schema, migrations, log, counts: ['items'] });
//   db.run(sql, ...args); db.get(sql, ...args); db.all(sql, ...args); db.transaction(fn);
//   db.kvGet(k, dflt); db.kvSet(k, v); db.jobDone(name, ok, error, detail); db.backup(label); db.copyTo(dest)
//
// node:sqlite binds JavaScript numbers as REAL. Integer division in SQL (`ts / ?`) therefore is
// not integer division: write `CAST(ts / ? AS INTEGER)` when a result has to sit on a grid.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const KIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  name        TEXT PRIMARY KEY,
  last_run    INTEGER,
  last_ok     INTEGER,
  last_error  TEXT,
  detail      TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

class Db {
  /**
   * @param {string} file       the database path (created with its folder)
   * @param {object} opts       { schema: string, migrations: [{ version, name, sql }], log, counts: [tables for stats()] }
   */
  constructor(file, { schema = '', migrations = [], log, counts = [] } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.log = log || (() => {});
    this.migrations = migrations;
    this.counts = counts;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(KIT_SCHEMA);
    if (schema) this.db.exec(schema);
    this._stmts = new Map();
    this.migrate();
  }

  get userVersion() { return Number(this.db.prepare('PRAGMA user_version').get().user_version); }

  /** Append-only migrations: never edit an old one, add a new { version, name, sql }. Tolerates re-added columns. */
  migrate() {
    const current = this.userVersion;
    const pending = this.migrations.filter(m => m.version > current);
    if (!pending.length) return;
    this.backup('pre-migration-v' + current);
    for (const m of pending) {
      this.log(`db migrate → v${m.version} (${m.name})`);
      this.db.exec('BEGIN');
      try {
        const stripped = m.sql.replace(/--[^\n]*/g, '');
        for (const stmt of stripped.split(';').map(s => s.trim()).filter(Boolean)) {
          try { this.db.exec(stmt); }
          catch (e) { if (!/duplicate column name/i.test(e.message)) throw new Error(`${e.message} in: ${stmt.slice(0, 80)}`); }
        }
        this.db.exec(`PRAGMA user_version = ${m.version}`);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }

  /** Consistent copy of the live database via VACUUM INTO (safe while the service writes). */
  copyTo(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
  }
  /** Local safety copies (before migrations), newest 10 kept in <file>.backups/. */
  backup(label = 'manual') {
    const dir = this.file + '.backups';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = this.copyTo(path.join(dir, `${stamp}-${label}.db`));
    const all = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 10))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
    return dest;
  }
  /** File size, schema version and a row count per table named in `counts`. */
  stats() {
    const st = fs.statSync(this.file);
    const out = { file: this.file, size: st.size, version: this.userVersion };
    for (const t of this.counts) { try { out[t] = this.get(`SELECT COUNT(*) n FROM ${t}`).n; } catch { out[t] = null; } }
    return out;
  }

  kvGet(k, dflt = null) { const r = this.get('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : dflt; }
  kvSet(k, v) { this.run('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v)); }
  jobDone(name, ok, error = null, detail = null) {
    this.run('INSERT INTO jobs(name, last_run, last_ok, last_error, detail) VALUES(?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run, last_ok=CASE WHEN excluded.last_ok IS NULL THEN jobs.last_ok ELSE excluded.last_ok END, last_error=excluded.last_error, detail=excluded.detail',
      name, Date.now(), ok ? Date.now() : null, error, detail == null ? null : JSON.stringify(detail));
  }
  jobs(prefix = '') { return this.all('SELECT * FROM jobs WHERE name LIKE ? ORDER BY name', prefix + '%').map(j => ({ ...j, detail: j.detail ? JSON.parse(j.detail) : null })); }

  prep(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }
  run(sql, ...args) { return this.prep(sql).run(...args); }
  get(sql, ...args) { return this.prep(sql).get(...args); }
  all(sql, ...args) { return this.prep(sql).all(...args); }
  exec(sql) { return this.db.exec(sql); }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { try { this.db.close(); } catch { /* ignore */ } }
}

module.exports = { Db };
