"""0.4 features: NAS mirror/archive/backup, guard rules, watchdog, reboot detection,
settings validation, deterministic packaging.

    python -m unittest discover tests
"""
import csv
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tarfile
import tempfile
import time
import types
import unittest
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(REPO / "hub"), str(REPO / "tests")]
os.environ["PIPULSE_NAS_ALLOW_LOCAL"] = "1"  # the test "NAS" is a temp folder on the same disk
import guards  # noqa: E402
import hub as hubmod  # noqa: E402
from nas import Nas, check_dir  # noqa: E402
from store import Store  # noqa: E402
from test_link import HubTest, report  # noqa: E402


class NasTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data, self.logs, self.backups = root / "data", root / "logs", root / "backups"
        for d in (self.data, self.logs, self.backups):
            d.mkdir()
        (self.data / "hub-cert.pem").write_text("CERT")
        (self.data / "hub-key.pem").write_text("KEY")
        self.store = Store(str(self.data / "pipulse.db"))
        self.store.update_settings({"nas_data_dir": str(self.logs), "nas_backup_dir": str(self.backups), "raw_days": 1})
        self.nas = Nas(types.SimpleNamespace(store=self.store, data=self.data, version="9.9.9"))

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_mirror_is_a_readable_database(self):
        self.store.add_event("n1", "info", "test", "hello")
        self.nas.mirror()
        self.assertTrue(self.nas.status["mirror"]["ok"], self.nas.status["mirror"])
        db = sqlite3.connect(self.logs / "pipulse-live.db")
        self.assertEqual(db.execute("SELECT msg FROM events WHERE kind = 'test'").fetchone()[0], "hello")
        db.close()

    def test_archive_moves_old_rows_to_day_files(self):
        now = int(time.time())
        old = now - 3 * 86400
        self.store.add_sample("n1", old, {"cpu": 42.0})
        self.store.add_sample("n1", now, {"cpu": 7.0})
        self.store.flush()
        self.nas.archive()
        self.assertTrue(self.nas.status["archive"]["ok"], self.nas.status["archive"])
        files = list((self.logs / "archive" / "samples").rglob("*.csv.gz"))
        self.assertEqual(len(files), 1)
        rows = list(csv.reader(gzip.open(files[0], "rt")))
        self.assertEqual(rows[0][:3], ["node", "ts", "cpu"])
        self.assertEqual(float(rows[1][2]), 42.0)
        left = self.store.db.execute("SELECT cpu FROM samples").fetchall()
        self.assertEqual([r[0] for r in left], [7.0])  # only the recent row stays on the Pi
        self.assertTrue((self.logs / "archive" / "nodes.csv").exists())

    def test_archive_keeps_rows_while_nas_is_away(self):
        self.store.put("_archived_samples", int(time.time()) - 2 * 86400)  # recent backlog, under a week
        self.store.update_settings({"nas_data_dir": str(self.logs / "missing")})
        self.store.add_sample("n1", int(time.time()) - int(1.5 * 86400), {"cpu": 1.0})
        self.store.flush()
        self.nas.archive()
        self.assertFalse(self.nas.status["archive"]["ok"])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM samples").fetchone()[0], 1)

    def test_backup_contains_db_cert_key_and_rotates(self):
        self.store.update_settings({"backup_keep": 2})
        for n in range(3):
            (self.backups / f"pipulse-backup-2020-01-0{n + 1}_0300.tar.gz").write_bytes(b"old")
        self.nas.backup()
        self.assertTrue(self.nas.status["backup"]["ok"], self.nas.status["backup"])
        kept = sorted(p.name for p in self.backups.glob("pipulse-backup-*.tar.gz"))
        self.assertEqual(len(kept), 2)
        with tarfile.open(self.backups / kept[-1]) as t:
            self.assertEqual(sorted(t.getnames()), ["RESTORE.txt", "VERSION", "hub-cert.pem", "hub-key.pem", "pipulse.db"])

    def test_refuses_missing_folder(self):
        ok, msg = check_dir(str(self.logs / "nope"))
        self.assertFalse(ok)
        self.nas.store.update_settings({"nas_backup_dir": str(self.logs / "nope")})
        self.nas.backup()
        self.assertFalse(self.nas.status["backup"]["ok"])


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "g.db"))
        self.store.put("guards", guards.validate([{"name": "hog", "match": "docker*", "metric": "cpu",
                                                   "above": 150, "minutes": 1, "cap": 100}]))
        self.g = guards.Guards(self.store)

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def svc(self, unit, cpu, quota=None):
        return {"unit": unit, "cpu": cpu, "mem": 100 << 20, "cpu_quota": quota, "mem_max": 256 << 20, "cpu_weight": 100}

    def test_fires_after_sustained_and_keeps_other_limits(self):
        self.assertEqual(self.g.check("n", [self.svc("docker.service", 200)], 1000), [])
        out = self.g.check("n", [self.svc("docker.service", 200)], 1061)
        self.assertEqual(len(out), 1)
        action, text = out[0]
        self.assertEqual((action["cpu_quota"], action["mem_max_mb"]), (100, 256))
        self.assertIn("docker.service", text)

    def test_spike_resets_and_capped_or_protected_are_left_alone(self):
        self.g.check("n", [self.svc("docker.service", 200)], 1000)
        self.g.check("n", [self.svc("docker.service", 10)], 1030)
        self.assertEqual(self.g.check("n", [self.svc("docker.service", 200)], 1070), [])
        self.assertEqual(self.g.check("n", [self.svc("docker.service", 500, quota=100)], 2000), [])
        self.store.put("guards", guards.validate([{"match": "*", "metric": "cpu", "above": 1, "minutes": 0.5, "cap": 50}]))
        self.g.check("n", [self.svc("ssh.service", 90)], 3000)
        self.assertEqual(self.g.check("n", [self.svc("ssh.service", 90)], 3100), [])

    def test_validation(self):
        with self.assertRaises(ValueError):
            guards.validate([{"match": "rm -rf", "metric": "cpu", "above": 100, "minutes": 1, "cap": 50}])
        with self.assertRaises(ValueError):
            guards.validate([{"match": "*", "metric": "mem", "above": 100, "minutes": 1, "cap": 8}])


class HubFeatureTest(HubTest):
    """Runs against the real hub process that HubTest starts."""

    def test_watchdog_alerts_and_restarts(self):
        self.link.request("POST", "/api/report", report("wd01"))
        self.call("/api/settings", {"sustain": 0})
        self.call("/api/node/wd01/watch", {"unit": "app.service", "watch": True, "restart": True})
        reply = json.loads(self.link.request("POST", "/api/report", report("wd01")))
        self.assertEqual(reply["watch"], ["app.service"])
        body = json.loads(report("wd01"))
        body["watch"] = {"app.service": "failed"}
        reply = json.loads(self.link.request("POST", "/api/report", json.dumps(body).encode()))
        self.assertEqual([(a["type"], a["unit"]) for a in reply["actions"]], [("restart", "app.service")])
        node = next(n for n in self.call("/api/state")["nodes"] if n["id"] == "wd01")
        self.assertIn(["crit", "app.service is failed"], node["alerts"])
        # Still failed on the next report: no second restart within 2 minutes.
        reply = json.loads(self.link.request("POST", "/api/report", json.dumps(body).encode()))
        self.assertEqual(reply["actions"], [])

    def test_reboot_detected(self):
        for boot in ("boot-a", "boot-b"):
            body = json.loads(report("rb01"))
            body["info"]["boot_id"] = boot
            self.link.request("POST", "/api/report", json.dumps(body).encode())
        msgs = [e["msg"] for e in self.call("/api/events?node=rb01")["events"]]
        self.assertTrue(any(m.startswith("rebooted, not from PiPulse") for m in msgs), msgs)

    def test_path_settings_validated(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.call("/api/settings", {"nas_data_dir": "relative/path"})
        with self.assertRaises(urllib.error.HTTPError):
            self.call("/api/settings", {"nas_data_dir": "/mnt/pipulse/../etc"})
        self.assertEqual(self.call("/api/settings", {"nas_data_dir": ""})["settings"]["nas_data_dir"], "")

    def test_about_and_update_not_managed(self):
        about = self.call("/api/about")
        self.assertFalse(about["update"]["managed"])
        with self.assertRaises(urllib.error.HTTPError):
            self.call("/api/update/hub", {})

    def test_bundle_is_deterministic_and_matches_sums(self):
        a = urllib.request.urlopen(self.base + "/hub/pipulse-hub.tar.gz").read()
        b = urllib.request.urlopen(self.base + "/hub/pipulse-hub.tar.gz").read()
        self.assertEqual(a, b)
        sums = urllib.request.urlopen(self.base + "/hub/SHA256SUMS").read().decode()
        self.assertEqual(sums.split()[0], hashlib.sha256(a).hexdigest())
        import io
        with tarfile.open(fileobj=io.BytesIO(a)) as t:
            names = t.getnames()
        for want in ("REPO", "VERSION", "hub/update.sh", "hub/nas-setup.sh", "hub/pipulse-hub.sh", "client/client.py"):
            self.assertIn(want, names)


del HubTest  # imported only to subclass; don't run its tests twice

if __name__ == "__main__":
    unittest.main()
