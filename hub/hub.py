#!/usr/bin/env python3
"""PiPulse Hub: the home of the dashboard, settings, logging and alerts.

Two listeners:
  * dashboard  (HTTP, --port, default 8750): the web UI, its JSON API behind a
    password, and the client/hub install scripts;
  * client link (HTTPS, --link-port, default port+1): where PiPulse Clients send
    reports. The certificate is the hub's own and every client pins its fingerprint.

Standard library only. Runs as the pipulse-hub service on a Pi, or by hand on
Windows for development.
"""
import argparse
import collections
import getpass
import hashlib
import hmac
import io
import json
import os
import secrets
import socket
import ssl
import sys
import tarfile
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import alerts as alerting  # noqa: E402
import tls  # noqa: E402
from store import DEFAULTS, LIMITS, Store  # noqa: E402

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent
STATIC = ROOT / "static"
CLIENT = BASE / "client"
VERSION = (BASE / "VERSION").read_text().strip() if (BASE / "VERSION").exists() else "dev"
SESSION_DAYS = 30
RECENT = 720  # sparkline points kept in memory per Pi (one hour at 5 s)
RANGES = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "1y": 31536000}
STATIC_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}


# ---------------------------------------------------------------- helpers

def hash_pw(pw, salt=None, rounds=200_000):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), rounds).hex()
    return f"pbkdf2${rounds}${salt}${digest}"


def check_pw(pw, stored):
    try:
        _, rounds, salt, digest = stored.split("$")
        return hmac.compare_digest(hash_pw(pw, salt, int(rounds)).rsplit("$", 1)[1], digest)
    except (ValueError, AttributeError):
        return False


def sid_key(cookie):
    return hashlib.sha256(cookie.encode()).hexdigest()


def lan_ip():
    # The default route can be a VPN tunnel (NordVPN hands out 10.5.x), so list every
    # address and prefer home-LAN ranges over whatever the route picks.
    ips = set()
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # UDP connect sends nothing; it just picks the outbound interface
        ips.add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()

    def rank(ip):
        if ip.startswith("192.168."):
            return 0
        if ip.startswith("172.") and 16 <= int(ip.split(".")[1]) <= 31:
            return 1
        return 2 if ip.startswith("10.") else 3

    ips = {ip for ip in ips if not ip.startswith("127.")}
    return min(ips, key=lambda ip: (rank(ip), ip)) if ips else "localhost"


def client_source():
    """client.py with this hub's version stamped in, so client and hub always match."""
    src = (CLIENT / "client.py").read_text()
    return src.replace('VERSION = "dev"', f'VERSION = "{VERSION}"', 1).encode()


def bundle():
    """The hub (with the client it hands out) as a tarball, laid out like the repo."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        t.add(BASE / "VERSION", "VERSION")
        for f in sorted(ROOT.iterdir()):
            if f.suffix in (".py", ".sh"):
                t.add(f, f"hub/{f.name}")
        for f in sorted(STATIC.iterdir()):
            if f.is_file():
                t.add(f, f"hub/static/{f.name}")
        for f in sorted(CLIENT.iterdir()):
            if f.suffix in (".py", ".sh"):
                t.add(f, f"client/{f.name}")
    return buf.getvalue()


def fmt_fp(fp):
    return ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)).upper()


# ---------------------------------------------------------------- hub state

class Hub:
    def __init__(self, data: Path, web_port, link_port):
        self.data, self.web_port, self.link_port = data, web_port, link_port
        data.mkdir(parents=True, exist_ok=True)
        self.store = Store(str(data / "pipulse.db"))
        self.alerts = alerting.Alerts(self.store)
        self.lock = threading.RLock()
        self.started = time.time()
        self.migrate_v02()
        if not self.store.settings.get("_token"):
            self.store.put("_token", secrets.token_urlsafe(24))
        self.cert, self.key, self.fp = tls.ensure_cert(data)
        self.live = {}  # id -> runtime state
        for n in self.store.nodes():
            self.live[n["id"]] = self.fresh(n)
            hist = self.store.history(n["id"], 3600, 240)["points"]
            self.live[n["id"]]["recent"].extend([p[0], p[1], p[3], p[5]] for p in hist)
        self.store.rollup(time.time() - self.store.settings["raw_days"] * 86400)
        self.store.add_event(None, "info", "hub", f"hub {VERSION} started")

    @property
    def token(self):
        return self.store.settings["_token"]

    def fresh(self, n):
        return {"id": n["id"], "label": n.get("label", ""), "hostname": n.get("hostname", ""),
                "info": n.get("info", {}), "seen": n.get("last_seen") or 0, "last": None,
                "recent": collections.deque(maxlen=RECENT), "pending": [], "sent": {}}

    def name(self, n):
        return n["label"] or n["hostname"] or n["id"]

    def migrate_v02(self):
        """0.2 kept config.json / nodes.json in the data dir. Bring them across once."""
        cfg = self.data / "config.json"
        if not cfg.exists() or self.store.settings.get("_token"):
            return
        old = json.loads(cfg.read_text())
        self.store.put("_token", old["token"])
        if old.get("password"):
            self.store.put("_password", old["password"])
        nodes_file = self.data / "nodes.json"
        if nodes_file.exists():
            for n in json.loads(nodes_file.read_text()):
                self.store.upsert_node(n["id"], n.get("hostname", ""), n.get("info", {}), n.get("seen") or time.time())
                self.store.set_label(n["id"], n.get("label", ""))
                for e in n.get("events", []):
                    self.store.add_event(n["id"], e["level"], "action", e["msg"], e["ts"])
            nodes_file.rename(nodes_file.with_suffix(".json.v02"))
        cfg.rename(cfg.with_suffix(".json.v02"))
        (self.data / "sessions.json").unlink(missing_ok=True)
        self.store.add_event(None, "info", "hub", "imported settings and Pis from PiPulse 0.2")

    # --- views
    def online(self, n, now):
        return bool(n["seen"]) and now - n["seen"] <= self.store.settings["offline_after"]

    def summary(self, n, now):
        client_v = (n["info"] or {}).get("client") or (n["info"] or {}).get("agent")
        return {
            "id": n["id"], "label": n["label"], "hostname": n["hostname"], "info": n["info"],
            "seen": n["seen"], "online": self.online(n, now),
            "metrics": n["last"]["metrics"] if n["last"] else None,
            "alerts": self.alerts.active(n["id"]) or ([] if n["last"] else [["warn", "waiting for first report"]]),
            "hist": list(n["recent"]), "pending": len(n["pending"]) + len(n["sent"]),
            "client_version": client_v, "outdated": bool(client_v) and client_v != VERSION,
        }

    # --- client reports
    def report(self, r):
        nid = str(r["id"])[:64]
        now = time.time()
        with self.lock:
            n = self.live.get(nid)
            if not n:
                n = self.live[nid] = self.fresh({"id": nid})
                self.store.add_event(nid, "info", "node", f"new Pi: {r.get('hostname')}")
            if n["hostname"] != r.get("hostname") or n["info"] != r.get("info") or not n["last"]:
                n["hostname"], n["info"] = r.get("hostname", nid), r.get("info", {})
                self.store.upsert_node(nid, n["hostname"], n["info"], now)
            n["seen"], n["last"] = now, r
            m = r["metrics"]
            mem = m.get("mem") or {}
            disks = m.get("disks") or []
            root = next((d for d in disks if d["mount"] == "/"), disks[0] if disks else None)
            vals = {
                "cpu": m.get("cpu"), "temp": m.get("temp"),
                "mem": round(100 * (1 - mem["avail"] / mem["total"]), 1) if mem.get("total") else None,
                "load1": (m.get("load") or [None])[0],
                "disk": round(100 * root["used"] / root["total"], 1) if root else None,
                "rx": (m.get("net") or {}).get("rx"), "tx": (m.get("net") or {}).get("tx"),
            }
            self.store.add_sample(nid, now, vals)
            n["recent"].append([round(now), vals["cpu"], vals["mem"], vals["temp"]])
            self.alerts.update(nid, self.name(n), alerting.conditions(m, n["info"], self.store.settings), now)
            for res in r.get("results", []):
                a = n["sent"].pop(res.get("id"), {"text": "action"})
                ok = res.get("ok")
                self.store.add_event(nid, "ok" if ok else "error", "action",
                                     ("done: " if ok else "failed: ") + a["text"] + ("" if ok else f" ({res.get('msg')})"))
            for aid, a in list(n["sent"].items()):
                if now - a["at"] > 60:  # the reply carrying it was lost
                    del n["sent"][aid]
                    self.store.add_event(nid, "error", "action", "no answer from client: " + a["text"])
            actions, n["pending"] = n["pending"], []
            for a in actions:
                n["sent"][a["id"]] = {"text": a["text"], "at": now}
        return {"interval": self.store.settings["interval"],
                "actions": [{k: v for k, v in a.items() if k != "text"} for a in actions]}

    # --- background upkeep
    def maintain(self):
        last_flush = last_roll = last_prune = time.time()
        while True:
            time.sleep(5)
            now = time.time()
            try:
                s = self.store.settings
                if now - self.started > s["offline_after"]:  # give clients a moment after a hub restart
                    with self.lock:
                        for n in self.live.values():
                            gone = {} if self.online(n, now) else {"offline": ("crit", "not reporting")}
                            self.alerts.update(n["id"], self.name(n), gone, now, only={"offline"})
                if now - last_flush >= 30:
                    self.store.flush()
                    with self.lock:
                        for n in self.live.values():
                            if n["seen"]:
                                self.store.touch_node(n["id"], n["seen"])
                    last_flush = now
                if now - last_roll >= 300:
                    self.store.rollup(now - 3 * 3600)
                    last_roll = now
                if now - last_prune >= 3600:
                    self.store.prune()
                    last_prune = now
            except Exception as e:  # keep the loop alive; the log says what broke
                print(f"maintenance error: {e!r}", flush=True)


# ---------------------------------------------------------------- action validation

def clean_action(a, n):
    kind = a.get("type")
    cores = (n["info"] or {}).get("cores", 4)
    if kind == "limit":
        out = {"type": "limit", "unit": str(a.get("unit", ""))}
        for k, lo, hi in (("cpu_quota", 5, cores * 100), ("mem_max_mb", 16, 1 << 20), ("cpu_weight", 1, 10000)):
            v = a.get(k)
            if v in (None, ""):
                out[k] = None
            else:
                v = int(v)
                if not lo <= v <= hi:
                    raise ValueError(f"{k} must be {lo}..{hi}")
                out[k] = v
        bits = [f"CPU ≤ {out['cpu_quota'] / 100:g} cores" if out["cpu_quota"] else "CPU unlimited",
                f"RAM ≤ {out['mem_max_mb']} MB" if out["mem_max_mb"] else "RAM unlimited",
                f"weight {out['cpu_weight']}" if out["cpu_weight"] else "default priority"]
        return out, f"limit {out['unit']}: " + ", ".join(bits)
    if kind == "renice":
        out = {"type": "renice", "pid": int(a["pid"]), "nice": int(a["nice"])}
        return out, f"nice {out['nice']} for pid {out['pid']} ({a.get('name', '?')})"
    if kind == "restart":
        return {"type": "restart", "unit": str(a["unit"])}, f"restart {a['unit']}"
    if kind == "update":
        return {"type": "update", "sha256": hashlib.sha256(client_source()).hexdigest()}, f"update client to {VERSION}"
    raise ValueError(f"unknown action {kind!r}")


# ---------------------------------------------------------------- HTTP plumbing

class Base(BaseHTTPRequestHandler):
    server_version = "PiPulse/" + VERSION
    hub: Hub = None

    def log_message(self, fmt, *args):
        pass  # clients report every few seconds; access logs would drown everything

    def send(self, code, body, ctype="application/json", headers=()):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode() if ctype == "application/json" else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        err = sys.exc_info()[1]
        if isinstance(err, (ssl.SSLError, ConnectionError, TimeoutError, OSError)):
            return  # port scanners and dropped connections are not news
        super().handle_error(request, client_address)


# ---------------------------------------------------------------- client link (HTTPS)

class LinkHandler(Base):
    def setup(self):
        # Handshake here, in the per-connection thread, so a stalled client can't block accept().
        self.request.settimeout(15)
        self.request.do_handshake()
        super().setup()

    def do_GET(self):
        if self.path == "/api/ping":
            return self.send(200, {"ok": True, "version": VERSION})
        if self.path == "/client.py" and self.authorized():
            return self.send(200, client_source(), "text/plain")
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/api/report":
            return self.send(404, {"error": "not found"})
        if not self.authorized():
            return self.send(401, {"error": "bad token"})
        try:
            self.send(200, self.hub.report(self.body()))
        except (ValueError, KeyError, TypeError) as e:
            self.send(400, {"error": str(e)})

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.hub.token)


# ---------------------------------------------------------------- dashboard (HTTP)

class WebHandler(Base):
    def hub_host(self):
        # A Pi can't use "localhost", so swap in this machine's LAN address.
        host = self.headers.get("Host") or "localhost"
        if host.count(":") == 1:
            host = host.split(":")[0]
        return lan_ip() if host in ("localhost", "127.0.0.1", "[::1]") else host

    def web_base(self):
        return f"http://{self.hub_host()}:{self.hub.web_port}"

    def install_cmd(self):
        return f"curl -fsSL '{self.web_base()}/client/install.sh?t={self.hub.token}' | sudo sh"

    # --- sessions
    def cookie(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c["pp"].value if "pp" in c else ""

    def authed(self):
        c = self.cookie()
        return bool(c) and self.hub.store.session_ok(sid_key(c))

    def new_session(self):
        cookie = secrets.token_urlsafe(32)
        self.hub.store.add_session(sid_key(cookie), time.time() + SESSION_DAYS * 86400)
        return ("Set-Cookie", f"pp={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}")

    def do_GET(self):
        url = urlparse(self.path)
        path, q = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        hub, store = self.hub, self.hub.store
        now = time.time()

        if path == "/api/ping":
            return self.send(200, {"ok": True, "version": VERSION})
        if path == "/api/auth":
            return self.send(200, {"setup": not store.settings.get("_password"), "authed": self.authed()})
        # Install scripts and client code are not secret; install.sh still needs the token.
        if path == "/client/install.sh":
            if not hmac.compare_digest(q.get("t", ""), hub.token):
                return self.send(403, "echo 'PiPulse: wrong or missing token'; exit 1\n", "text/plain")
            host = "127.0.0.1" if "local" in q else self.hub_host()
            script = (CLIENT / "install.sh").read_text()
            for k, v in {"__HOST__": host, "__WEB__": self.web_base() if "local" not in q else f"http://127.0.0.1:{hub.web_port}",
                         "__LINK_PORT__": str(hub.link_port), "__TOKEN__": hub.token, "__PIN__": hub.fp,
                         "__SHA256__": hashlib.sha256(client_source()).hexdigest(), "__VERSION__": VERSION}.items():
                script = script.replace(k, v)
            return self.send(200, script, "text/plain")
        if path == "/client/uninstall.sh":
            return self.send(200, (CLIENT / "uninstall.sh").read_bytes(), "text/plain")
        if path == "/client/client.py":
            return self.send(200, client_source(), "text/plain")
        if path == "/hub/install.sh":
            port = q.get("port", "8750")
            if not port.isdigit() or not 1024 <= int(port) < 65535:
                return self.send(400, "echo 'PiPulse: port must be 1024..65534'; exit 1\n", "text/plain")
            script = (ROOT / "install.sh").read_text().replace("__SRC__", self.web_base() + "/hub").replace("__PORT__", port)
            return self.send(200, script, "text/plain")
        if path == "/hub/uninstall.sh":
            return self.send(200, (ROOT / "uninstall.sh").read_bytes(), "text/plain")
        if path == "/hub/pipulse-hub.tar.gz":
            return self.send(200, bundle(), "application/gzip")

        if path.startswith("/api/"):
            if not self.authed():
                return self.send(401, {"error": "sign in"})
            return self.api_get(path, q, now)

        name = "index.html" if path == "/" else path.lstrip("/")
        f = (STATIC / name).resolve()
        if f.parent == STATIC.resolve() and f.is_file():
            return self.send(200, f.read_bytes(), STATIC_TYPES.get(f.suffix, "application/octet-stream"))
        self.send(404, {"error": "not found"})

    def api_get(self, path, q, now):
        hub, store = self.hub, self.hub.store
        if path == "/api/state":
            with hub.lock:
                nodes = [hub.summary(n, now) for n in hub.live.values()]
            return self.send(200, {"now": now, "version": VERSION, "hostname": socket.gethostname(),
                                   "nodes": nodes, "install": self.install_cmd()})
        if path == "/api/settings":
            return self.send(200, {
                "settings": store.public_settings(), "defaults": DEFAULTS, "limits": LIMITS,
                "version": VERSION, "hostname": socket.gethostname(), "started": hub.started,
                "fingerprint": fmt_fp(hub.fp), "link_port": hub.link_port, "web_port": hub.web_port,
                "db": store.size(), "data": str(hub.data), "install": self.install_cmd(),
                "hub_install": f"curl -fsSL '{self.web_base()}/hub/install.sh' | sudo sh",
            })
        if path == "/api/events":
            rows = store.events(q.get("node") or None, q.get("level") or None, q.get("q") or None,
                                q.get("before") or None, q.get("limit") or 100)
            with hub.lock:
                names = {i: hub.name(n) for i, n in hub.live.items()}
            for r in rows:
                r["name"] = names.get(r["node"], r["node"] or "hub")
            return self.send(200, {"events": rows})
        parts = path.split("/")
        if len(parts) >= 4 and parts[2] == "node":
            with hub.lock:
                n = hub.live.get(parts[3])
                if not n:
                    return self.send(404, {"error": "no such Pi"})
                if len(parts) == 5 and parts[4] == "history":
                    secs = RANGES.get(q.get("range", "24h"))
                    if not secs:
                        return self.send(400, {"error": "range must be one of " + ", ".join(RANGES)})
                    return self.send(200, store.history(n["id"], secs))
                data = hub.summary(n, now) | {
                    "procs": n["last"]["procs"] if n["last"] else [],
                    "services": n["last"]["services"] if n["last"] else [],
                    "events": store.events(n["id"], limit=50),
                    "hub_version": VERSION,
                }
            return self.send(200, data)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        hub, store = self.hub, self.hub.store
        # JSON-only plus SameSite=Strict keeps other websites from posting forms here.
        if "application/json" not in self.headers.get("Content-Type", ""):
            return self.send(415, {"error": "JSON only"})
        try:
            if path == "/api/auth/setup":
                pw = str(self.body().get("password", ""))
                with hub.lock:
                    if store.settings.get("_password"):
                        return self.send(409, {"error": "a password is already set"})
                    if len(pw) < 8:
                        return self.send(400, {"error": "use at least 8 characters"})
                    store.put("_password", hash_pw(pw))
                store.add_event(None, "info", "auth", "dashboard password created")
                return self.send(200, {"ok": True}, headers=[self.new_session()])
            if path == "/api/auth/login":
                if not check_pw(str(self.body().get("password", "")), store.settings.get("_password")):
                    time.sleep(1)  # slows guessing without needing lockout state
                    store.add_event(None, "warn", "auth", f"failed sign-in from {self.client_address[0]}")
                    return self.send(401, {"error": "wrong password"})
                return self.send(200, {"ok": True}, headers=[self.new_session()])
            if not self.authed():
                return self.send(401, {"error": "sign in"})
            if path == "/api/auth/logout":
                store.drop_session(sid_key(self.cookie()))
                return self.send(200, {"ok": True}, headers=[("Set-Cookie", "pp=; Path=/; Max-Age=0")])
            if path == "/api/password":
                b = self.body()
                if not check_pw(str(b.get("current", "")), store.settings.get("_password")):
                    time.sleep(1)
                    return self.send(403, {"error": "current password is wrong"})
                if len(str(b.get("new", ""))) < 8:
                    return self.send(400, {"error": "use at least 8 characters"})
                store.put("_password", hash_pw(str(b["new"])))
                store.drop_session()  # sign out every other browser
                store.add_event(None, "info", "auth", "dashboard password changed")
                return self.send(200, {"ok": True}, headers=[self.new_session()])
            if path == "/api/settings":
                changes = self.body()
                store.update_settings(changes)
                store.add_event(None, "info", "settings",
                                "settings changed: " + ", ".join(f"{k}={store.settings[k]}" for k in changes))
                return self.send(200, {"ok": True, "settings": store.public_settings()})
            parts = path.split("/")
            if len(parts) == 5 and parts[1:3] == ["api", "node"]:
                with hub.lock:
                    n = hub.live.get(parts[3])
                    if not n:
                        return self.send(404, {"error": "no such Pi"})
                    if parts[4] == "action":
                        a, text = clean_action(self.body(), n)
                        a["id"], a["text"] = secrets.token_hex(4), text
                        n["pending"].append(a)
                        store.add_event(n["id"], "info", "action", "queued: " + text)
                        return self.send(200, {"ok": True, "id": a["id"]})
                    if parts[4] == "label":
                        n["label"] = str(self.body().get("label", ""))[:60]
                        store.set_label(n["id"], n["label"])
                        return self.send(200, {"ok": True})
            self.send(404, {"error": "not found"})
        except (ValueError, KeyError, TypeError) as e:
            self.send(400, {"error": str(e)})

    def do_DELETE(self):
        if not self.authed():
            return self.send(401, {"error": "sign in"})
        parts = urlparse(self.path).path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "node"]:
            with self.hub.lock:
                n = self.hub.live.pop(parts[3], None)
                self.hub.alerts.forget(parts[3])
                self.hub.store.delete_node(parts[3])
                if n:
                    self.hub.store.add_event(None, "info", "node", f"forgot {self.hub.name(n)}")
            return self.send(200, {"ok": True})
        self.send(404, {"error": "not found"})


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="PiPulse Hub")
    ap.add_argument("--port", type=int, default=8750, help="dashboard port (HTTP)")
    ap.add_argument("--link-port", type=int, help="encrypted client link port (default: port + 1)")
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--data", default=str(ROOT / "data"), help="data directory")
    ap.add_argument("--set-password", action="store_true", help="set the dashboard password and exit")
    args = ap.parse_args()
    data = Path(args.data)

    if args.set_password:
        data.mkdir(parents=True, exist_ok=True)
        store = Store(str(data / "pipulse.db"))
        pw = getpass.getpass("New dashboard password: ")
        if len(pw) < 8 or pw != getpass.getpass("Again: "):
            sys.exit("Passwords must match and be at least 8 characters.")
        store.put("_password", hash_pw(pw))
        store.drop_session()
        store.add_event(None, "info", "auth", "dashboard password reset from the command line")
        return print("Password set. Every browser has been signed out.")

    hub = Hub(data, args.port, args.link_port or args.port + 1)
    Base.hub = hub
    web = QuietServer((args.bind, hub.web_port), WebHandler)
    link = QuietServer((args.bind, hub.link_port), LinkHandler)
    link.socket = tls.server_context(hub.cert, hub.key).wrap_socket(
        link.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=link.serve_forever, daemon=True).start()
    threading.Thread(target=hub.maintain, daemon=True).start()
    print(f"PiPulse Hub {VERSION}: dashboard http://{lan_ip()}:{hub.web_port}, "
          f"client link https://:{hub.link_port} (cert {fmt_fp(hub.fp)[:23]}...), data {data}", flush=True)
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        hub.store.flush()


if __name__ == "__main__":
    main()
