"""NAS storage: the hourly database mirror, the archive of data past retention,
and nightly backups.

The live database never lives on the NAS. SQLite over SMB has unreliable
locking and WAL doesn't work there, and logging would stop whenever the NAS
sleeps. Instead:

  * mirror  - every `mirror_hours`, VACUUM INTO a local temp file, then copy it to
              <nas_data_dir>/pipulse-live.db (via .partial + rename, so a reader
              never sees half a file);
  * archive - rows about to fall out of retention are appended to day files under
              <nas_data_dir>/archive/<table>/<year>/<table>-<date>.csv.gz before
              they're deleted, so the NAS keeps everything forever;
  * backup  - nightly at `backup_hour`: database snapshot + the hub certificate and
              key in pipulse-backup-<date>.tar.gz under <nas_backup_dir>, keeping
              the newest `backup_keep`. `pipulse-hub restore <file>` puts one back.

Every write first checks that the folder really is on a mounted share. An
unmounted mountpoint is just a folder on the SD card, and filling it would take
the Pi down.
"""
import csv
import datetime
import gzip
import io
import os
import shutil
import tarfile
import threading
import time
from pathlib import Path

TABLES = (("samples", "raw_days"), ("hourly", "hourly_days"), ("events", "event_days"))
BACKUP_PREFIX = "pipulse-backup-"
RESTORE_TXT = """PiPulse Hub backup
==================
Contains the hub database (settings, Pis, history, events), and the hub's TLS
certificate and key. With those restored, existing clients keep trusting the hub.

Restore on the hub Pi (install the hub first if it's a new Pi):

    sudo pipulse-hub restore "/mnt/pipulse/Backup_Pool/PiPulse Backup/<this file>"
"""


def check_dir(path):
    """(ok, message): is `path` a writable folder on a mounted share?"""
    if not path:
        return False, "not set"
    p = Path(path)
    try:
        if not p.is_dir():
            return False, "folder not found (is the NAS mounted?)"
        if os.name != "nt" and os.environ.get("PIPULSE_NAS_ALLOW_LOCAL") != "1" \
                and p.stat().st_dev == os.stat("/").st_dev:
            return False, "the NAS share isn't mounted; refusing to write to the SD card instead"
        probe = p / ".pipulse-write-test"
        probe.write_text("ok")
        probe.unlink()
        return True, "ok"
    except OSError as e:
        return False, e.strerror or str(e)


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


class Nas:
    def __init__(self, hub):
        self.hub, self.store = hub, hub.store
        self.tmp = hub.data / "tmp"
        self.tmp.mkdir(exist_ok=True)
        self.status = dict(self.store.settings.get("_nas", {}))  # job -> {at, ok, msg}
        self.busy = threading.Lock()  # one NAS job at a time
        self.running = None

    # ------------------------------------------------------------ bookkeeping

    def _record(self, job, ok, msg, event_on_ok=None):
        prev = self.status.get(job, {})
        self.status[job] = {"at": time.time(), "ok": ok, "msg": msg}
        self.store.put("_nas", self.status)
        names = {"mirror": "NAS mirror", "backup": "NAS backup", "archive": "NAS archive"}
        if not ok and (prev.get("ok", True) or prev.get("msg") != msg):
            self.store.add_event(None, "error", "nas", f"{names[job]} failed: {msg}")
        elif ok and event_on_ok:
            self.store.add_event(None, "ok", "nas", event_on_ok)
        elif ok and prev and not prev.get("ok", True):
            self.store.add_event(None, "ok", "nas", f"{names[job]} working again")

    def start(self, job):
        """Run a job in the background. Returns False if another NAS job is running."""
        if not self.busy.acquire(blocking=False):
            return False

        def work():
            self.running = job
            try:
                getattr(self, job)()
            except Exception as e:  # never let a NAS problem take the hub down
                self._record(job if job in ("mirror", "backup") else "archive", False, repr(e))
            finally:
                self.running = None
                self.busy.release()
        threading.Thread(target=work, daemon=True).start()
        return True

    def due(self, now):
        """Called from the hub's upkeep loop; starts whatever is due. A slow or hung
        CIFS mount only ever blocks the worker thread, never the hub."""
        s = self.store.settings
        last = lambda job: self.status.get(job, {}).get("at", 0)  # noqa: E731
        if now - last("archive") >= 3600:
            return self.start("archive")
        if s["mirror_hours"] and s["nas_data_dir"] and now - last("mirror") >= s["mirror_hours"] * 3600:
            return self.start("mirror")
        lt = time.localtime(now)
        done_today = time.strftime("%Y-%m-%d", time.localtime(last("backup"))) == time.strftime("%Y-%m-%d", lt)
        if s["nas_backup_dir"] and lt.tm_hour == s["backup_hour"] and not done_today:
            return self.start("backup")

    # ------------------------------------------------------------ jobs

    def mirror(self):
        d = self.store.settings["nas_data_dir"]
        ok, msg = check_dir(d)
        if not ok:
            return self._record("mirror", False, msg)
        snap = self.tmp / "mirror.db"
        self.store.vacuum_into(snap)
        dest = Path(d) / "pipulse-live.db"
        part = dest.with_name(dest.name + ".partial")
        shutil.copyfile(snap, part)
        os.replace(part, dest)
        size = snap.stat().st_size
        snap.unlink()
        self._record("mirror", True, f"pipulse-live.db ({human(size)})")

    def archive(self):
        """Archive (if on) and then prune each table past its retention."""
        s = self.store.settings
        now = time.time()
        d = s["nas_data_dir"] if s["archive"] else ""
        ok, msg = check_dir(d) if d else (False, "off")
        notes, failed = [], None
        for table, key in TABLES:
            cutoff = int(now - s[key] * 86400)
            mark_key = f"_archived_{table}"
            mark = s.get(mark_key) or self.store.oldest(table) or cutoff
            if not d:
                self.store.delete_before(table, cutoff)
                self.store.put(mark_key, cutoff)
                continue
            if mark >= cutoff:
                continue
            if ok:
                try:
                    n = self._export(Path(d), table, int(mark), cutoff)
                    self.store.delete_before(table, cutoff)
                    self.store.put(mark_key, cutoff)
                    if n:
                        notes.append(f"{n:,} {table}")
                    continue
                except OSError as e:
                    failed = f"{table}: {e.strerror or e}"
            else:
                failed = msg
            # The NAS is away. Keep the rows for it, but not forever: past a week of
            # backlog (or one retention period, if longer) the SD card wins.
            if cutoff - mark > max(7 * 86400, s[key] * 86400):
                self.store.delete_before(table, cutoff)
                self.store.put(mark_key, cutoff)
                self.store.add_event(None, "warn", "nas",
                                     f"NAS unavailable too long: deleted old {table} without archiving them")
        self.store.drop_expired_sessions()
        if not d:
            return self._record("archive", True, "archiving off; old data deleted")
        if failed:
            return self._record("archive", False, failed)
        self._record("archive", True, ("archived " + ", ".join(notes)) if notes else "nothing new to archive")

    def _export(self, root, table, lo, hi):
        """Append rows lo <= ts < hi to per-day gzip CSVs. Returns the row count."""
        total = 0
        self._write_nodes(root)
        day = datetime.datetime.fromtimestamp(lo).replace(hour=0, minute=0, second=0, microsecond=0)
        while day.timestamp() < hi:
            nxt = day + datetime.timedelta(days=1)
            cols, rows = self.store.rows_between(table, max(lo, int(day.timestamp())), min(hi, int(nxt.timestamp())))
            if rows:
                folder = root / "archive" / table / f"{day:%Y}"
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / f"{table}-{day:%Y-%m-%d}.csv.gz"
                buf = io.StringIO()
                w = csv.writer(buf, lineterminator="\n")
                if not path.exists():
                    w.writerow(cols)
                w.writerows(rows)
                # Appending a gzip member keeps the file a valid .gz (zcat reads them all).
                with open(path, "ab") as f:
                    f.write(gzip.compress(buf.getvalue().encode()))
                total += len(rows)
            day = nxt
        return total

    def _write_nodes(self, root):
        """nodes.csv maps the node ids in the archive to names."""
        (root / "archive").mkdir(parents=True, exist_ok=True)
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["id", "label", "hostname", "first_seen", "last_seen"])
        for n in self.store.nodes():
            w.writerow([n["id"], n["label"], n["hostname"], n["first_seen"], n["last_seen"]])
        (root / "archive" / "nodes.csv").write_text(buf.getvalue(), newline="")

    def backup(self):
        s = self.store.settings
        d = s["nas_backup_dir"]
        ok, msg = check_dir(d)
        if not ok:
            return self._record("backup", False, msg)
        snap = self.tmp / "pipulse.db"
        self.store.vacuum_into(snap)
        name = f"{BACKUP_PREFIX}{datetime.datetime.now():%Y-%m-%d_%H%M}.tar.gz"
        local = self.tmp / name
        with tarfile.open(local, "w:gz") as t:
            t.add(snap, "pipulse.db")
            for f in ("hub-cert.pem", "hub-key.pem"):
                t.add(self.hub.data / f, f)
            for fname, text in (("VERSION", self.hub.version + "\n"), ("RESTORE.txt", RESTORE_TXT)):
                info = tarfile.TarInfo(fname)
                data = text.encode()
                info.size, info.mtime = len(data), int(time.time())
                t.addfile(info, io.BytesIO(data))
        size = local.stat().st_size
        dest = Path(d) / name
        shutil.copyfile(local, dest.with_name(name + ".partial"))
        os.replace(dest.with_name(name + ".partial"), dest)
        local.unlink()
        snap.unlink()
        old = sorted(p for p in Path(d).glob(BACKUP_PREFIX + "*.tar.gz"))[:-s["backup_keep"]]
        for p in old:
            p.unlink()
        self._record("backup", True, f"{name} ({human(size)})", event_on_ok=f"backup saved to the NAS: {name} ({human(size)})")

    # ------------------------------------------------------------ view

    def view(self):
        s = self.store.settings
        out = {"status": self.status, "running": self.running, "dirs": {}}
        for key in ("nas_data_dir", "nas_backup_dir"):
            ok, msg = check_dir(s[key])
            out["dirs"][key] = {"path": s[key], "ok": ok, "msg": msg}
        backups = []
        if out["dirs"]["nas_backup_dir"]["ok"]:
            for p in sorted(Path(s["nas_backup_dir"]).glob(BACKUP_PREFIX + "*.tar.gz"), reverse=True)[:50]:
                st = p.stat()
                backups.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
        out["backups"] = backups
        out["archived"] = {t: s.get(f"_archived_{t}") for t, _ in TABLES}
        return out
