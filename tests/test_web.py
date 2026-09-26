"""The dashboard's web layer (hub/web.py on the Bracket contract): channel contract, roles,
re-authentication, LAN-only, same-origin, lockout, the status URL, and the 0.4 password upgrade.

    python -m unittest discover tests
"""
import hashlib
import http.cookiejar
import json
import re
import secrets
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(REPO / "hub"), str(REPO / "tests")]
import hub as hubmod  # noqa: E402
import web as webmod  # noqa: E402
from test_link import ApiError, free_port, report  # noqa: E402


def shape_channels():
    """Every request channel named in bridge-shape.js (the page side of the contract)."""
    src = (REPO / "hub" / "web" / "bridge-shape.js").read_text(encoding="utf-8")
    body = src[src.index("this, {"):]
    return set(re.findall(r"'([a-zA-Z]+:[a-zA-Z]+)'", body))


class InProcessHub(unittest.TestCase):
    """A hub served from this process, so tests can reach into its session state."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.hub = hubmod.Hub(Path(cls.tmp.name), free_port(), free_port())
        cls.web = hubmod.make_web(cls.hub)
        hubmod.Base.hub, hubmod.WebHandler.web = cls.hub, cls.web
        cls.srv = hubmod.QuietServer(("127.0.0.1", cls.hub.web_port), hubmod.WebHandler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.hub.web_port}"
        cls.password = secrets.token_urlsafe(12)
        cls.admin = cls.opener()
        cls.post(cls.admin, "/api/login", {"username": "admin", "password": cls.password})

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.hub.store.db.close()
        cls.tmp.cleanup()

    @staticmethod
    def opener():
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    @classmethod
    def post(cls, opener, path, body, headers=None):
        req = urllib.request.Request(cls.base + path, json.dumps(body).encode(), {"Content-Type": "application/json", **(headers or {})})
        try:
            with opener.open(req, timeout=10) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, json.load(e)) from None

    @classmethod
    def call(cls, opener, channel, *args, headers=None):
        return cls.post(opener, "/api/" + urllib.parse.quote(channel, safe=""), list(args), headers)["result"]

    # ---- the contract ------------------------------------------------------------------------------
    def test_every_page_channel_is_served_and_nothing_else(self):
        shape, served = shape_channels(), set(self.web.handlers)
        self.assertEqual(shape - served, set(), "listed in bridge-shape.js but nobody answers")
        self.assertEqual(served - shape, set(), "served but not listed in bridge-shape.js")

    def test_role_lists_name_real_channels(self):
        for role, chans in hubmod.ROLES.items():
            for ch in chans:
                self.assertIn(ch, self.web.handlers, f"{role} lists unknown channel {ch}")

    # ---- accounts and roles ---------------------------------------------------------------------------
    def test_first_run_is_over_once_an_account_exists(self):
        with urllib.request.urlopen(self.base + "/api/firstrun") as r:
            self.assertFalse(json.load(r)["firstRun"])
        with self.assertRaises(ApiError) as e:
            self.post(self.opener(), "/api/login", {"username": "intruder", "password": "whatever123"})
        self.assertEqual(e.exception.status, 401)

    def test_standard_user_reads_but_cannot_act(self):
        self.call(self.admin, "security:addUser", "viewer", "viewerpass1", "standard")
        viewer = self.opener()
        self.post(viewer, "/api/login", {"username": "viewer", "password": "viewerpass1"})
        self.assertIn("nodes", self.call(viewer, "fleet:state"))
        for ch, args in (("fleet:install", ()), ("pi:action", ("x", {"type": "update"})), ("hub:guards", ([],)), ("nas:run", ("backup",))):
            with self.assertRaises(ApiError) as e:
                self.call(viewer, ch, *args)
            self.assertEqual(e.exception.status, 403, ch)

    def test_install_command_only_for_admins_and_carries_the_token(self):
        cmd = self.call(self.admin, "fleet:install")["command"]
        self.assertIn(self.hub.token, cmd)
        self.assertNotIn("localhost", cmd)

    # ---- request gates ------------------------------------------------------------------------------
    def test_cross_origin_post_refused(self):
        with self.assertRaises(ApiError) as e:
            self.call(self.admin, "fleet:state", headers={"Origin": "http://evil.example"})
        self.assertEqual(e.exception.status, 403)

    def test_lan_only_refuses_a_public_address_behind_the_proxy(self):
        # Behind Caddy the socket is loopback and X-Forwarded-For carries the real client.
        with self.assertRaises(ApiError) as e:
            self.call(self.admin, "fleet:state", headers={"X-Forwarded-For": "8.8.8.8"})
        self.assertEqual(e.exception.status, 403)
        self.assertIn("nodes", self.call(self.admin, "fleet:state", headers={"X-Forwarded-For": "192.168.1.50"}))

    def test_sensitive_action_asks_for_the_password_again(self):
        sid = next(k for k, s in self.web.web["sessions"].items() if s["user"] == "admin")
        self.web.web["sessions"][sid]["reauthAt"] = 0  # pretend the last password entry was long ago
        with self.assertRaises(ApiError) as e:
            self.call(self.admin, "pi:power", "nope", "reboot")
        self.assertEqual((e.exception.status, e.exception.body["reason"]), (401, "reauth"))
        with self.assertRaises(ApiError):
            self.post(self.admin, "/api/reauth", {"password": "wrong-password"})
        self.post(self.admin, "/api/reauth", {"password": self.password})
        with self.assertRaises(ApiError) as e:  # past the gate now: fails on the unknown Pi instead
            self.call(self.admin, "pi:power", "nope", "reboot")
        self.assertIn("no such Pi", e.exception.body["error"])

    def test_lockout_after_repeated_failures(self):
        ip = "192.168.9.9"
        for _ in range(webmod.LOCK_FAILS):
            with self.assertRaises(ApiError):
                self.post(self.opener(), "/api/login", {"username": "admin", "password": "nope-nope"}, {"X-Forwarded-For": ip})
        with self.assertRaises(ApiError) as e:  # even the right password, from that address
            self.post(self.opener(), "/api/login", {"username": "admin", "password": self.password}, {"X-Forwarded-For": ip})
        self.assertEqual(e.exception.status, 429)

    def test_status_url_for_home_assistant(self):
        url = self.call(self.admin, "status:info")["url"]
        key = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["key"][0]
        with urllib.request.urlopen(f"{self.base}/api/status?key={key}") as r:
            s = json.load(r)
        self.assertEqual((s["app"], s["total"]), ("PiPulse", len(self.hub.live)))
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"{self.base}/api/status?key=wrong")
        self.assertEqual(e.exception.code, 401)

    def test_pages_and_kit_are_served_with_a_strict_policy(self):
        for path in ("/", "/app.js", "/terms.js", "/kit/renderer/ui.js", "/kit/renderer/glossary.js"):
            with urllib.request.urlopen(self.base + path) as r:
                self.assertEqual(r.status, 200, path)
                self.assertIn("default-src 'self'", r.headers["Content-Security-Policy"])
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/kit/renderer/../../hub/hub.py")


class LegacyPasswordTest(unittest.TestCase):
    def test_0_4_password_becomes_the_admin_account(self):
        with tempfile.TemporaryDirectory() as d:
            salt = secrets.token_hex(16)
            legacy = f"pbkdf2$200000${salt}${hashlib.pbkdf2_hmac('sha256', b'oldpass123', bytes.fromhex(salt), 200000).hex()}"
            w = webmod.Web(meta={"slug": "pipulse"}, data=Path(d), renderer=Path(d), kit=Path(d), version="x", roles={}, legacy_hash=legacy, log=lambda s: None)
            self.assertEqual(w.web["users"]["admin"]["hash"], legacy)
            r = w._login("127.0.0.1", "test", {"username": "admin", "password": "oldpass123"})
            self.assertTrue(r["ok"])
            self.assertFalse(w.web["users"]["admin"]["hash"].startswith("pbkdf2$"), "moved to the kit's scrypt format on sign-in")
            self.assertFalse(w._login("127.0.0.1", "test", {"username": "admin", "password": "wrong"})["ok"])


if __name__ == "__main__":
    unittest.main()
