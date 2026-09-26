"""End-to-end tests: a real hub process, the real client transport.

    python -m unittest discover tests

Needs openssl on PATH (Git for Windows' copy is found automatically).
"""
import http.cookiejar
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(REPO / "client"), str(REPO / "hub")]
import client  # noqa: E402
import tls  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def report(nid="test01", cpu=12.5, **metrics):
    m = {"cpu": cpu, "cores": [cpu] * 4, "load": [0.5, 0.4, 0.3],
         "mem": {"total": 4 << 30, "avail": 3 << 30, "swap_total": 0, "swap_free": 0},
         "temp": 50.0, "throttled": 0, "disks": [{"mount": "/", "total": 100, "used": 40}],
         "net": {"rx": 10, "tx": 5}, "uptime": 100, "nprocs": 90} | metrics
    return json.dumps({"id": nid, "hostname": "testpi", "ts": time.time(), "results": [],
                       "info": {"model": "Test Pi", "cores": 4, "client": "x"},
                       "metrics": m, "procs": [], "services": []}).encode()


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status}: {body.get('error')}")
        self.status, self.body = status, body


class HubTest(unittest.TestCase):
    """A real hub process on free ports, signed in as the first admin through the kit contract."""
    PASSWORD = "testpass123"

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.web, cls.link_port = free_port(), free_port()
        cls.proc = subprocess.Popen([sys.executable, str(REPO / "hub" / "hub.py"), "--bind", "127.0.0.1",
                                     "--port", str(cls.web), "--link-port", str(cls.link_port), "--data", cls.tmp.name],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        cls.base = f"http://127.0.0.1:{cls.web}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/api/ping", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("hub did not start: " + cls.proc.stderr.read().decode())
        db = sqlite3.connect(Path(cls.tmp.name) / "pipulse.db")
        cls.token = json.loads(db.execute("SELECT value FROM settings WHERE key = '_token'").fetchone()[0])
        db.close()
        cls.pin = tls.fingerprint(Path(cls.tmp.name) / "hub-cert.pem")
        cls.link = client.Link("127.0.0.1", cls.link_port, cls.token, cls.pin)
        cls.jar = http.cookiejar.CookieJar()
        cls.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cls.jar))
        cls.post("/api/login", {"username": "admin", "password": cls.PASSWORD})  # first run: creates the admin

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        cls.proc.stderr.close()
        cls.tmp.cleanup()

    @classmethod
    def post(cls, path, body, opener=None):
        req = urllib.request.Request(cls.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with (opener or cls.opener).open(req, timeout=10) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, json.load(e)) from None

    @classmethod
    def call(cls, channel, *args, opener=None):
        """One kit-contract call, as webbridge.js makes it: POST /api/<channel> with a JSON array."""
        return cls.post("/api/" + urllib.parse.quote(channel, safe=""), list(args), opener)["result"]

    def node(self, nid):
        return next(n for n in self.call("fleet:state")["nodes"] if n["id"] == nid)

    def test_report_over_pinned_link(self):
        reply = json.loads(self.link.request("POST", "/api/report", report()))
        self.assertEqual(reply["interval"], 5)
        node = self.node("test01")
        self.assertTrue(node["online"])
        self.assertEqual(node["metrics"]["cpu"], 12.5)

    def test_wrong_pin_sends_nothing(self):
        bad = client.Link("127.0.0.1", self.link_port, self.token, "ab" * 32)
        with self.assertRaises(client.PinMismatch):
            bad.request("POST", "/api/report", report("never"))
        self.assertNotIn("never", [n["id"] for n in self.call("fleet:state")["nodes"]])

    def test_wrong_token_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "401"):
            client.Link("127.0.0.1", self.link_port, "nope", self.pin).request("POST", "/api/report", report())

    def test_plain_http_report_refused(self):
        req = urllib.request.Request(self.base + "/api/report", report(),
                                     {"Content-Type": "application/json", "Authorization": "Bearer " + self.token})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(e.exception.code, 401)

    def test_dashboard_needs_sign_in(self):
        with self.assertRaises(ApiError) as e:
            self.call("fleet:state", opener=urllib.request.build_opener())
        self.assertEqual((e.exception.status, e.exception.body["reason"]), (401, "login"))

    def test_settings_validation(self):
        with self.assertRaises(ApiError) as e:
            self.call("hub:setSettings", {"temp_warn": 90, "temp_crit": 80})
        self.assertEqual(e.exception.status, 400)
        self.assertEqual(self.call("hub:setSettings", {"sustain": 0})["sustain"], 0)

    def test_alert_raised_and_logged(self):
        self.call("hub:setSettings", {"sustain": 0})
        self.link.request("POST", "/api/report", report("hot01", temp=85.0))
        self.assertIn(["crit", "hot: 85 °C"], self.node("hot01")["alerts"])
        self.link.request("POST", "/api/report", report("hot01", temp=50.0))
        msgs = [e["msg"] for e in self.call("events:list", {"node": "hot01"})]
        self.assertIn("hot: 85 °C", msgs)
        self.assertIn("cleared: hot: 85 °C", msgs)

    def test_history_recorded(self):
        self.link.request("POST", "/api/report", report("hist01", cpu=33.0))
        h = self.call("pi:history", "hist01", "1h")
        self.assertEqual(h["points"][-1][1], 33.0)

    def test_actions_round_trip(self):
        self.link.request("POST", "/api/report", report("act01"))
        self.call("pi:action", "act01", {"type": "limit", "unit": "x.service", "cpu_quota": 50, "mem_max_mb": None, "cpu_weight": None})
        reply = json.loads(self.link.request("POST", "/api/report", report("act01")))
        self.assertEqual(reply["actions"][0]["cpu_quota"], 50)
        self.assertNotIn("text", reply["actions"][0])

    def test_client_install_script_filled(self):
        with urllib.request.urlopen(f"{self.base}/client/install.sh?t={self.token}", timeout=5) as r:
            script = r.read().decode()
        for placeholder in ("__HOST__", "__WEB__", "__LINK_PORT__", "__TOKEN__", "__PIN__", "__SHA256__", "__VERSION__"):
            self.assertNotIn(placeholder, script)  # not a bare "__": tokens can contain that
        self.assertIn(self.pin, script)
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(f"{self.base}/client/install.sh?t=wrong", timeout=5)


class ClientParseTest(unittest.TestCase):
    def test_unit_names(self):
        self.assertTrue(client.UNIT_RE.match("docker-3f2a.scope"))
        self.assertTrue(client.UNIT_RE.match("getty@tty1.service"))
        self.assertFalse(client.UNIT_RE.match("bad;rm -rf /.service"))

    def test_limit_refuses_bad_values(self):
        self.assertFalse(client._limit({"unit": "x.service", "cpu_quota": 900, "mem_max_mb": None, "cpu_weight": None}, 4)[0])
        self.assertFalse(client._limit({"unit": "x.service", "cpu_quota": None, "mem_max_mb": 8, "cpu_weight": None}, 4)[0])


if __name__ == "__main__":
    unittest.main()
