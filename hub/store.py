"""SQLite storage for the hub: settings, Pis, metric history, events, sessions.

Raw samples are buffered in memory and flushed every 30 s. An SD card does not
enjoy a commit every 5 s per Pi. Raw rows are rolled up into hourly rows that
outlive them. Retention for each tier comes from settings; nas.py archives rows
to the NAS before they are pruned.
"""
import json
import os
import sqlite3
import sys
import threading
import time

ON_PI = sys.platform.startswith("linux")

DEFAULTS = {
    "interval": 5,           # seconds between client reports
    "raw_days": 7,           # full-detail history
    "hourly_days": 365,      # hourly averages
    "event_days": 365,
    "offline_after": 30,     # seconds without a report
    "sustain": 60,           # a problem must last this long before it alerts
    "temp_warn": 70, "temp_crit": 80,
    "mem_warn": 80, "mem_crit": 90,      # % used
    "disk_warn": 90, "disk_crit": 95,    # % used
    "swap_warn": 50,                     # % used
    "load_warn": 1.5,                    # 5-min load per core
    "write_warn": 0,                     # MB written per minute (SD wear); 0 = off
    # NAS (nas.py). Empty path = that feature is off.
    "nas_data_dir": "/mnt/pipulse/Local_APP_Tank/PiPulse" if ON_PI else "",
    "nas_backup_dir": "/mnt/pipulse/Backup_Pool/PiPulse Backup" if ON_PI else "",
    "mirror_hours": 1,       # snapshot the database to the NAS this often; 0 = off
    "archive": 1,            # move data past retention to the NAS instead of deleting it
    "backup_hour": 3,        # nightly backup at this hour (local time)
    "backup_keep": 30,       # backups kept on the NAS
    "update_check": 1,       # check GitHub for new releases daily
    "guards": [],            # guard rules (guards.py); validated by set_guards
}
# key -> (min, max). Anything not listed here (or in PATHS) can't be set from the dashboard.
LIMITS = {
    "interval": (2, 300), "raw_days": (1, 90), "hourly_days": (7, 3650), "event_days": (7, 3650),
    "offline_after": (10, 3600), "sustain": (0, 3600),
    "temp_warn": (40, 100), "temp_crit": (40, 100), "mem_warn": (10, 100), "mem_crit": (10, 100),
    "disk_warn": (10, 100), "disk_crit": (10, 100), "swap_warn": (1, 100), "load_warn": (0.1, 20),
    "write_warn": (0, 10000), "mirror_hours": (0, 24), "archive": (0, 1), "backup_hour": (0, 23),
    "backup_keep": (1, 365), "update_check": (0, 1),
}
PATHS = ("nas_data_dir", "nas_backup_dir")
METRICS = ("cpu", "mem", "temp", "load1", "disk", "rx", "tx", "wr", "rtt")
HOURLY = ("cpu", "cpu_max", "mem", "mem_max", "temp", "temp_max", "load1", "disk", "rx", "tx", "n", "wr", "rtt")


class Store:
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.buffer = []
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            self._migrate()
        self.settings = self._load_settings()

    def _migrate(self):
        v = self.db.execute("PRAGMA user_version").fetchone()[0]
        if v < 1:
            self.db.executescript("""
                BEGIN;
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', hostname TEXT NOT NULL DEFAULT '',
                                    info TEXT NOT NULL DEFAULT '{}', first_seen REAL, last_seen REAL);
                CREATE TABLE samples (node TEXT NOT NULL, ts INTEGER NOT NULL, cpu REAL, mem REAL, temp REAL,
                                      load1 REAL, disk REAL, rx REAL, tx REAL);
                CREATE INDEX samples_node_ts ON samples (node, ts);
                CREATE TABLE hourly (node TEXT NOT NULL, ts INTEGER NOT NULL, cpu REAL, cpu_max REAL, mem REAL, mem_max REAL,
                                     temp REAL, temp_max REAL, load1 REAL, disk REAL, rx REAL, tx REAL, n INTEGER,
                                     PRIMARY KEY (node, ts));
                CREATE TABLE events (id INTEGER PRIMARY KEY, ts REAL NOT NULL, node TEXT, level TEXT NOT NULL,
                                     kind TEXT NOT NULL, msg TEXT NOT NULL);
                CREATE INDEX events_ts ON events (ts);
                CREATE INDEX events_node ON events (node, ts);
                CREATE TABLE sessions (key TEXT PRIMARY KEY, expires REAL NOT NULL);
                PRAGMA user_version = 1;
                COMMIT;
            """)
        if v < 2:  # 0.4: disk writes, link latency, per-Pi preferences (watched services)
            self.db.executescript("""
                BEGIN;
                ALTER TABLE samples ADD COLUMN wr REAL;
                ALTER TABLE samples ADD COLUMN rtt REAL;
                ALTER TABLE hourly ADD COLUMN wr REAL;
                ALTER TABLE hourly ADD COLUMN rtt REAL;
                ALTER TABLE nodes ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
                PRAGMA user_version = 2;
                COMMIT;
            """)

    # ------------------------------------------------------------ settings
    # Keys starting with "_" are secrets or internal state and never leave the hub.

    def _load_settings(self):
        s = json.loads(json.dumps(DEFAULTS))
        for row in self.db.execute("SELECT key, value FROM settings"):
            s[row["key"]] = json.loads(row["value"])
        return s

    def put(self, key, value):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (key, json.dumps(value)))
            self.settings[key] = value

    def public_settings(self):
        return {k: v for k, v in self.settings.items() if not k.startswith("_")}

    def update_settings(self, changes):
        clean = {}
        for k, v in changes.items():
            if k in PATHS:
                v = str(v).strip()
                if v and (len(v) > 300 or ".." in v.replace("\\", "/").split("/")
                          or not (v.startswith("/") or v.startswith("\\\\") or v[1:3] in (":\\", ":/"))):
                    raise ValueError(f"{k} must be an absolute folder path")
                clean[k] = v
                continue
            if k not in LIMITS:
                raise ValueError(f"unknown setting {k}")
            lo, hi = LIMITS[k]
            v = float(v)
            if not lo <= v <= hi:
                raise ValueError(f"{k} must be between {lo} and {hi}")
            clean[k] = int(round(v)) if isinstance(lo, int) else v
        merged = self.settings | clean
        for a, b in (("temp_warn", "temp_crit"), ("mem_warn", "mem_crit"), ("disk_warn", "disk_crit")):
            if merged[a] > merged[b]:
                raise ValueError(f"{a} can't be above {b}")
        with self.lock:
            for k, v in clean.items():
                self.put(k, v)
        return clean

    # ------------------------------------------------------------ nodes

    def nodes(self):
        with self.lock:
            return [dict(r) | {"info": json.loads(r["info"]), "prefs": json.loads(r["prefs"])}
                    for r in self.db.execute("SELECT * FROM nodes")]

    def upsert_node(self, nid, hostname, info, now):
        with self.lock:
            self.db.execute("""INSERT INTO nodes (id, hostname, info, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT (id) DO UPDATE SET hostname = excluded.hostname, info = excluded.info,
                               last_seen = excluded.last_seen""", (nid, hostname, json.dumps(info), now, now))

    def touch_node(self, nid, now):
        with self.lock:
            self.db.execute("UPDATE nodes SET last_seen = ? WHERE id = ?", (now, nid))

    def set_label(self, nid, label):
        with self.lock:
            self.db.execute("UPDATE nodes SET label = ? WHERE id = ?", (label, nid))

    def set_prefs(self, nid, prefs):
        with self.lock:
            self.db.execute("UPDATE nodes SET prefs = ? WHERE id = ?", (json.dumps(prefs), nid))

    def delete_node(self, nid):
        with self.lock:
            self.flush()
            for t in ("nodes", "samples", "hourly"):
                self.db.execute(f"DELETE FROM {t} WHERE {'id' if t == 'nodes' else 'node'} = ?", (nid,))

    # ------------------------------------------------------------ samples

    def add_sample(self, nid, ts, values):
        with self.lock:
            self.buffer.append((nid, int(ts)) + tuple(values.get(k) for k in METRICS))

    def flush(self):
        with self.lock:
            if not self.buffer:
                return
            rows, self.buffer = self.buffer, []
            self.db.execute("BEGIN")
            self.db.executemany(f"INSERT INTO samples (node, ts, {', '.join(METRICS)}) VALUES "
                                f"({', '.join('?' * (len(METRICS) + 2))})", rows)
            self.db.execute("COMMIT")

    def rollup(self, since):
        """Recompute hourly rows from raw samples at or after `since`. Idempotent."""
        start = int(since) // 3600 * 3600
        with self.lock:
            self.flush()
            self.db.execute(f"""
                INSERT OR REPLACE INTO hourly (node, ts, {', '.join(HOURLY)})
                SELECT node, ts / 3600 * 3600, avg(cpu), max(cpu), avg(mem), max(mem), avg(temp), max(temp),
                       avg(load1), avg(disk), avg(rx), avg(tx), count(*), avg(wr), avg(rtt)
                FROM samples WHERE ts >= ? GROUP BY node, ts / 3600""", (start,))

    def history(self, nid, seconds, points=400):
        """Chart data for the last `seconds`: raw samples averaged into buckets, or
        hourly rows once the range reaches past the raw data."""
        now = time.time()
        since = now - seconds
        self.flush()
        cols = ("ts", "cpu", "cpu_max", "mem", "mem_max", "temp", "temp_max", "load1", "disk", "rx", "tx", "wr", "rtt")
        with self.lock:
            if seconds <= self.settings["raw_days"] * 86400:
                bucket = max(1, int(seconds / points))
                rows = self.db.execute(f"""
                    SELECT ts / {bucket} * {bucket} AS t, avg(cpu), max(cpu), avg(mem), max(mem), avg(temp), max(temp),
                           avg(load1), avg(disk), avg(rx), avg(tx), avg(wr), avg(rtt)
                    FROM samples WHERE node = ? AND ts >= ? GROUP BY t ORDER BY t""", (nid, since)).fetchall()
                res = "raw" if bucket <= self.settings["interval"] else f"{bucket}s"
            else:
                rows = self.db.execute(f"SELECT {', '.join(cols)} FROM hourly WHERE node = ? AND ts >= ? ORDER BY ts",
                                       (nid, since)).fetchall()
                res = "hourly"
        return {"resolution": res, "cols": cols,
                "points": [[round(v, 2) if isinstance(v, float) else v for v in r] for r in rows]}

    # ------------------------------------------------------------ events

    def add_event(self, nid, level, kind, msg, ts=None):
        with self.lock:
            self.db.execute("INSERT INTO events (ts, node, level, kind, msg) VALUES (?, ?, ?, ?, ?)",
                            (ts or time.time(), nid, level, kind, msg))

    def events(self, nid=None, level=None, q=None, before=None, limit=100):
        sql, args = ["SELECT * FROM events WHERE 1=1"], []
        if nid:
            sql.append("AND node = ?"); args.append(nid)
        if level:
            sql.append("AND level = ?"); args.append(level)
        if q:
            sql.append("AND msg LIKE ?"); args.append(f"%{q}%")
        if before:
            sql.append("AND id < ?"); args.append(int(before))
        sql.append("ORDER BY id DESC LIMIT ?"); args.append(min(int(limit), 500))
        with self.lock:
            return [dict(r) for r in self.db.execute(" ".join(sql), args)]

    # ------------------------------------------------------------ sessions

    def add_session(self, key, expires):
        with self.lock:
            self.db.execute("INSERT INTO sessions VALUES (?, ?)", (key, expires))

    def session_ok(self, key):
        with self.lock:
            r = self.db.execute("SELECT expires FROM sessions WHERE key = ?", (key,)).fetchone()
        return bool(r and r[0] > time.time())

    def drop_session(self, key=None):
        with self.lock:
            if key is None:
                self.db.execute("DELETE FROM sessions")
            else:
                self.db.execute("DELETE FROM sessions WHERE key = ?", (key,))

    # ------------------------------------------------------------ archive / housekeeping

    def rows_between(self, table, lo, hi):
        """All rows of samples/hourly/events with lo <= ts < hi, oldest first."""
        assert table in ("samples", "hourly", "events")
        with self.lock:
            self.flush()
            cur = self.db.execute(f"SELECT * FROM {table} WHERE ts >= ? AND ts < ? ORDER BY ts", (lo, hi))
            return [d[0] for d in cur.description], [tuple(r) for r in cur.fetchall()]

    def oldest(self, table):
        with self.lock:
            r = self.db.execute(f"SELECT min(ts) FROM {table}").fetchone()
        return r[0]

    def delete_before(self, table, ts):
        with self.lock:
            self.flush()
            self.db.execute(f"DELETE FROM {table} WHERE ts < ?", (ts,))

    def drop_expired_sessions(self):
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))

    def vacuum_into(self, path):
        """A consistent single-file copy of the live database (safe while it's being written)."""
        if os.path.exists(path):
            os.remove(path)
        with self.lock:
            self.flush()
            self.db.execute("VACUUM INTO ?", (str(path),))

    def size(self):
        with self.lock:
            pages = self.db.execute("PRAGMA page_count").fetchone()[0]
            psize = self.db.execute("PRAGMA page_size").fetchone()[0]
            counts = {t: self.db.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("samples", "hourly", "events")}
        return {"bytes": pages * psize} | counts
