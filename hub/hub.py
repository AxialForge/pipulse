#!/usr/bin/env python3
"""PiPulse Hub: the home of the dashboard, settings, logging and alerts.

Two listeners:
  * dashboard  (HTTP, --port, default 8750): the web UI (the Bracket kit's renderer, served
    through web.py's contract with accounts and roles), and the client/hub install scripts;
  * client link (HTTPS, --link-port, default port+1): where PiPulse Clients send
    reports. The certificate is the hub's own and every client pins its fingerprint.

Standard library only. Runs as the pipulse-hub service on a Pi, or by hand on
Windows for development.
"""
import argparse
import collections
import getpass
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import socket
import ssl
import sys
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import alerts as alerting  # noqa: E402
import guards as guarding  # noqa: E402
import tls  # noqa: E402
import web as web_mod  # noqa: E402
from nas import Nas  # noqa: E402
from store import DEFAULTS, LIMITS, PATHS, Store  # noqa: E402
from updater import REPO, Updater  # noqa: E402

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent
WEB_DIR = ROOT / "web"          # PiPulse's pages (app.js, terms.js, index.html)
CLIENT = BASE / "client"
KIT_DIR = BASE / "kit" / "renderer"   # the vendored Bracket kit, never edited here
VERSION = (BASE / "VERSION").read_text().strip() if (BASE / "VERSION").exists() else "dev"
RECENT = 720  # sparkline points kept in memory per Pi (one hour at 5 s)
RANGES = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "1y": 31536000}


# ---------------------------------------------------------------- helpers

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
    """The hub (with the client it hands out) as a tarball, laid out like the repo.
    Deterministic (fixed gzip header time, file mtimes from disk), so SHA256SUMS
    served for it stays valid across requests."""
    buf = io.BytesIO()
    files = [(BASE / "VERSION", "VERSION")]
    if (BASE / "CHANGELOG.md").exists():
        files.append((BASE / "CHANGELOG.md", "CHANGELOG.md"))
    files += [(f, f"hub/{f.name}") for f in sorted(ROOT.iterdir()) if f.suffix in (".py", ".sh")]
    files += [(f, f"hub/web/{f.name}") for f in sorted(WEB_DIR.iterdir()) if f.is_file()]
    files += [(BASE / "kit" / "VERSION", "kit/VERSION")]
    files += [(f, f"kit/renderer/{f.name}") for f in sorted(KIT_DIR.iterdir()) if f.is_file()]
    files += [(f, f"client/{f.name}") for f in sorted(CLIENT.iterdir()) if f.suffix in (".py", ".sh")]
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as t:
        for path, name in files:
            info = t.gettarinfo(str(path), name)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mode = 0o755 if name.endswith(".sh") else 0o644
            with open(path, "rb") as f:
                t.addfile(info, f)
        repo = f"{REPO}\n".encode()
        info = tarfile.TarInfo("REPO")
        info.size, info.mode = len(repo), 0o644
        t.addfile(info, io.BytesIO(repo))
    return buf.getvalue()


UNIT_RE = re.compile(r"^[A-Za-z0-9@._:\\-]+\.(service|scope)$")


def os_name():
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip('"')
    except OSError:
        pass
    import platform  # noqa: PLC0415 (only needed off-Pi)
    return platform.platform()


def dur_text(s):
    d, h, m = int(s // 86400), int(s % 86400 // 3600), int(s % 3600 // 60)
    return f"{d}d {h}h" if d else f"{h}h {m}m" if h else f"{m}m {int(s % 60)}s"


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
        self.version = VERSION
        self.nas = Nas(self)
        self.updater = Updater(self)
        self.guards = guarding.Guards(self.store)
        self.store.add_event(None, "info", "hub", f"hub {VERSION} started")

    @property
    def token(self):
        return self.store.settings["_token"]

    def fresh(self, n):
        return {"id": n["id"], "label": n.get("label", ""), "hostname": n.get("hostname", ""),
                "info": n.get("info", {}), "prefs": n.get("prefs") or {}, "seen": n.get("last_seen") or 0,
                "last": None, "recent": collections.deque(maxlen=RECENT), "pending": [], "sent": {},
                "restarts": {}, "gave_up": set(), "power_at": 0}

    def queue(self, n, action, text):
        action["id"], action["text"] = secrets.token_hex(4), text
        n["pending"].append(action)
        self.store.add_event(n["id"], "info", "action", "queued: " + text)
        if action["type"] in ("reboot", "shutdown"):
            n["power_at"] = time.time()
        return action["id"]

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
            "apt": (n["last"] or {}).get("apt"), "watch_status": (n["last"] or {}).get("watch") or {},
            "prefs": n["prefs"],
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
            old_boot, new_boot = (n["info"] or {}).get("boot_id"), (r.get("info") or {}).get("boot_id")
            if old_boot and new_boot and old_boot != new_boot:
                up = dur_text(r["metrics"].get("uptime") or 0)
                if now - n["power_at"] < 900:
                    self.store.add_event(nid, "info", "node", f"rebooted from the dashboard (up {up})")
                else:
                    self.store.add_event(nid, "warn", "node", f"rebooted, not from PiPulse (up {up})")
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
                "wr": (m.get("disk_io") or {}).get("write"), "rtt": m.get("rtt"),
            }
            self.store.add_sample(nid, now, vals)
            n["recent"].append([round(now), vals["cpu"], vals["mem"], vals["temp"]])
            watched = r.get("watch") or {}
            found = alerting.conditions(m, n["info"], self.store.settings) | alerting.watch_conditions(watched)
            self.alerts.update(nid, self.name(n), found, now)
            self.watchdog(n, watched, now)
            for action, text in self.guards.check(nid, r.get("services") or [], now):
                self.queue(n, action, text)
                self.store.add_event(nid, "warn", "guard", text)
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
        return {"interval": self.store.settings["interval"], "watch": sorted((n["prefs"].get("watch") or {})),
                "actions": [{k: v for k, v in a.items() if k != "text"} for a in actions]}

    def watchdog(self, n, watched, now):
        """Restart watched services that stopped, if the user allowed it. At most
        once every 2 minutes and 3 times an hour per service, then give up and say so."""
        prefs = n["prefs"].get("watch") or {}
        for unit, state in watched.items():
            if state in alerting.OK_STATES:
                n["gave_up"].discard(unit)
                continue
            if not (prefs.get(unit) or {}).get("restart") or state not in ("failed", "inactive"):
                continue
            tries = [t for t in n["restarts"].get(unit, []) if now - t < 3600]
            n["restarts"][unit] = tries
            if tries and now - tries[-1] < 120:
                continue
            if len(tries) >= 3:
                if unit not in n["gave_up"]:
                    n["gave_up"].add(unit)
                    self.store.add_event(n["id"], "error", "watchdog", f"gave up restarting {unit}: 3 tries in the last hour")
                continue
            tries.append(now)
            self.queue(n, {"type": "restart", "unit": unit}, f"watchdog: restart {unit} ({state})")

    # --- background upkeep
    def maintain(self):
        last_flush = last_roll = time.time()
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
                self.nas.due(now)       # archive + prune hourly, mirror, nightly backup (own thread)
                self.updater.due(now)   # daily release check; picks up update results
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
    if kind in ("reboot", "shutdown"):
        return {"type": kind}, "reboot the Pi" if kind == "reboot" else "shut the Pi down"
    if kind == "apt_upgrade":
        return {"type": "apt_upgrade"}, "install OS updates (apt upgrade)"
    if kind == "apt_check":
        return {"type": "apt_check"}, "check for OS updates"
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


# ---------------------------------------------------------------- dashboard (HTTP, Bracket contract)

def request_host(host_header):
    """Host name from a Host header, with localhost swapped for the LAN address (a Pi can't use it)."""
    host = host_header or "localhost"
    if host.count(":") == 1:
        host = host.split(":")[0]
    return lan_ip() if host in ("localhost", "127.0.0.1", "[::1]") else host


class WebHandler(Base):
    web: web_mod.Web = None

    def web_base(self):
        return f"http://{request_host(self.headers.get('Host'))}:{self.hub.web_port}"

    def do_GET(self):
        url = urlparse(self.path)
        path, q = url.path, {k: v[0] for k, v in parse_qs(url.query).items()}
        hub = self.hub
        if self.web.refused(self):
            return self.send(403, {"ok": False, "error": "LAN only"})
        if path == "/api/ping":
            return self.send(200, {"ok": True, "version": VERSION})
        # Install scripts and client code are not secret; the client installer still needs the token.
        if path == "/client/install.sh":
            if not hmac.compare_digest(q.get("t", ""), hub.token):
                return self.send(403, "echo 'PiPulse: wrong or missing token'; exit 1\n", "text/plain")
            local = "local" in q
            script = (CLIENT / "install.sh").read_text()
            for k, v in {"__HOST__": "127.0.0.1" if local else request_host(self.headers.get("Host")),
                         "__WEB__": f"http://127.0.0.1:{hub.web_port}" if local else self.web_base(),
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
        if path == "/hub/SHA256SUMS":
            return self.send(200, f"{hashlib.sha256(bundle()).hexdigest()}  pipulse-hub.tar.gz\n", "text/plain")
        if not self.web.get(self, path):
            self.send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.web.refused(self):
            return self.send(403, {"ok": False, "error": "LAN only"})
        if not self.web.post(self, urlparse(self.path).path, {"port": self.hub.web_port}):
            self.send(404, {"ok": False, "error": "not found"})


# ---------------------------------------------------------------- PiPulse channels

ROLES = {
    # Guests (only if an admin turns guest access on): the read-only fleet overview.
    "GUEST": ["fleet:state", "pi:get", "pi:history"],
    # Standard accounts: every page read-only. No install command (it carries the token).
    "STANDARD": ["fleet:state", "pi:get", "pi:history", "events:list", "hub:settings", "nas:view", "hubupdate:view"],
    # Admins may call everything; these ask for the password again (valid 5 minutes).
    "SENSITIVE": ["pi:power", "pi:forget", "hubupdate:hub", "hub:setSettings"],
}


def register_channels(web, hub):
    h = web.handler
    store = hub.store

    def install_cmd(ctx):
        return f"curl -fsSL 'http://{request_host(ctx['host'])}:{hub.web_port}/client/install.sh?t={hub.token}' | sudo sh"

    def node(nid):
        n = hub.live.get(str(nid))
        if not n:
            raise ValueError("no such Pi")
        return n

    @h("app:info")
    def app_info():
        return {"version": VERSION, "kit": (BASE / "kit" / "VERSION").read_text().strip() if (BASE / "kit" / "VERSION").exists() else None,
                "node": f"not used (the hub is Python {sys.version.split()[0]})", "python": sys.version.split()[0], "web": True, "https": False, "platform": os_name(),
                "hostname": socket.gethostname(), "cpus": os.cpu_count(), "dataDir": str(hub.data), "repo": f"https://github.com/{REPO}",
                "db": {"size": store.size()["bytes"], **{k: v for k, v in store.size().items() if k != "bytes"}},
                "name": "PiPulse", "slug": "pipulse"}

    @h("update:check")
    def update_check():
        hub.updater.check_now()
        u = hub.updater.view()
        if u["latest"].get("error"):
            return {"state": "error", "message": f"Could not check GitHub: {u['latest']['error']}"}
        if u["available"]:
            return {"state": "available", "version": u["available"], "message": f"PiPulse {u['available']} is available. Install it below."}
        return {"state": "current", "version": VERSION, "message": f"You are on the latest version ({VERSION})."}

    @h("sys:stats")
    def sys_stats():
        return {"health": {"level": "ok", "reasons": []}, "sampleMs": 5000}

    @h("fleet:state")
    def fleet_state():
        now = time.time()
        with hub.lock:
            nodes = [hub.summary(n, now) for n in hub.live.values()]
        return {"now": now, "version": VERSION, "hostname": socket.gethostname(), "nodes": nodes,
                "update_available": hub.updater.available()}

    @h("fleet:install", ctx=True)
    def fleet_install(ctx):
        return {"command": install_cmd(ctx), "web_port": hub.web_port, "link_port": hub.link_port,
                "uninstall": f"curl -fsSL http://{request_host(ctx['host'])}:{hub.web_port}/client/uninstall.sh | sudo sh"}

    @h("pi:get")
    def pi_get(nid):
        with hub.lock:
            n = node(nid)
            return hub.summary(n, time.time()) | {
                "procs": n["last"]["procs"] if n["last"] else [], "services": n["last"]["services"] if n["last"] else [],
                "events": store.events(n["id"], limit=60), "hub_version": VERSION}

    @h("pi:history")
    def pi_history(nid, rng="24h"):
        secs = RANGES.get(rng)
        if not secs:
            raise ValueError("range must be one of " + ", ".join(RANGES))
        with hub.lock:
            n = node(nid)
        return store.history(n["id"], secs)

    def act(nid, action):
        with hub.lock:
            n = node(nid)
            a, text = clean_action(action or {}, n)
            return {"ok": True, "id": hub.queue(n, a, text)}

    @h("pi:action")
    def pi_action(nid, action=None):
        if (action or {}).get("type") in ("reboot", "shutdown"):
            raise ValueError("use pi:power for reboot and shutdown")
        return act(nid, action)

    @h("pi:power")
    def pi_power(nid, kind=None):
        if kind not in ("reboot", "shutdown"):
            raise ValueError("kind must be reboot or shutdown")
        return act(nid, {"type": kind})

    @h("pi:label")
    def pi_label(nid, label=""):
        with hub.lock:
            n = node(nid)
            n["label"] = str(label or "")[:60]
            store.set_label(n["id"], n["label"])
        return True

    @h("pi:watch")
    def pi_watch(nid, unit="", watch=True, restart=False):
        unit = str(unit)
        if not UNIT_RE.match(unit):
            raise ValueError("not a service name")
        with hub.lock:
            n = node(nid)
            w = dict(n["prefs"].get("watch") or {})
            if watch:
                w[unit] = {"restart": bool(restart)}
            else:
                w.pop(unit, None)
                hub.alerts.update(n["id"], hub.name(n), {}, time.time(), only={f"svc:{unit}"})
            n["prefs"] = n["prefs"] | {"watch": w}
            store.set_prefs(n["id"], n["prefs"])
            store.add_event(n["id"], "info", "watchdog", (f"watching {unit}" + (" (auto-restart)" if w[unit]["restart"] else ""))
                            if watch else f"stopped watching {unit}")
            return n["prefs"]

    @h("pi:forget")
    def pi_forget(nid):
        with hub.lock:
            n = hub.live.pop(str(nid), None)
            hub.alerts.forget(str(nid))
            store.delete_node(str(nid))
            if n:
                store.add_event(None, "info", "node", f"forgot {hub.name(n)}")
        return True

    @h("events:list")
    def events_list(q=None):
        q = q or {}
        rows = store.events(q.get("node") or None, q.get("level") or None, q.get("q") or None, q.get("before") or None, q.get("limit") or 100)
        with hub.lock:
            names = {i: hub.name(n) for i, n in hub.live.items()}
        for r in rows:
            r["name"] = names.get(r["node"], r["node"] or "hub")
        return rows

    @h("hub:settings")
    def hub_settings():
        return {"settings": store.public_settings(), "defaults": DEFAULTS, "limits": LIMITS, "paths": PATHS,
                "fingerprint": fmt_fp(hub.fp), "link_port": hub.link_port, "web_port": hub.web_port,
                "db": store.size(), "data": str(hub.data), "protected": sorted(guarding.PROTECTED), "started": hub.started}

    @h("hub:setSettings")
    def hub_set_settings(changes=None):
        changed = store.update_settings(changes or {})
        if changed:
            store.add_event(None, "info", "settings", "settings changed: " + ", ".join(f"{k}={v}" for k, v in changed.items()))
        return store.public_settings()

    @h("hub:guards")
    def hub_guards(rules=None):
        rules = guarding.validate(rules or [])
        store.put("guards", rules)
        store.add_event(None, "info", "settings", f"guard rules saved ({len(rules)})")
        return rules

    @h("nas:view")
    def nas_view():
        return hub.nas.view()

    @h("nas:run")
    def nas_run(job=None):
        if job not in ("mirror", "backup", "archive"):
            raise ValueError("job must be mirror, backup or archive")
        if not hub.nas.start(job):
            raise ValueError(f"another NAS job is running ({hub.nas.running})")
        store.add_event(None, "info", "nas", f"{job} started from the dashboard")
        return True

    @h("hubupdate:view")
    def hubupdate_view():
        return hub.updater.view() | {"changelog": (BASE / "CHANGELOG.md").read_text(encoding="utf-8") if (BASE / "CHANGELOG.md").exists() else ""}

    @h("hubupdate:check")
    def hubupdate_check():
        hub.updater.check()
        return True

    @h("hubupdate:hub")
    def hubupdate_hub():
        return hub.updater.request()

    @h("hubupdate:clients")
    def hubupdate_clients():
        queued = []
        with hub.lock:
            for n in hub.live.values():
                s = hub.summary(n, time.time())
                if s["online"] and s["outdated"] and not any(a["type"] == "update" for a in n["pending"]):
                    a, text = clean_action({"type": "update"}, n)
                    hub.queue(n, a, text)
                    queued.append(hub.name(n))
        return queued


def fleet_status(hub):
    """/api/status?key=…: a compact fleet summary for Home Assistant REST sensors."""
    now = time.time()
    with hub.lock:
        nodes = [hub.summary(n, now) for n in hub.live.values()]
    pis = {}
    for s in nodes:
        m = s["metrics"] or {}
        mem = m.get("mem") or {}
        pis[s["label"] or s["hostname"] or s["id"]] = {
            "online": s["online"], "cpu": m.get("cpu"), "temp": m.get("temp"),
            "mem": round(100 * (1 - mem["avail"] / mem["total"]), 1) if mem.get("total") else None,
            "alerts": [a[1] for a in s["alerts"]], "client": s["client_version"]}
    return {"ok": True, "app": "PiPulse", "version": VERSION, "online": sum(1 for s in nodes if s["online"]), "total": len(nodes),
            "alerts": sum(len(s["alerts"]) for s in nodes), "pis": pis}


# ---------------------------------------------------------------- main

def make_web(hub):
    web = web_mod.Web(meta={"name": "PiPulse", "slug": "pipulse"}, data=hub.data, renderer=WEB_DIR, kit=KIT_DIR,
                      version=VERSION, roles=ROLES, status_fn=lambda: fleet_status(hub),
                      log=lambda s: print(s, flush=True), legacy_hash=hub.store.settings.get("_password"))
    register_channels(web, hub)
    return web


def main():
    ap = argparse.ArgumentParser(description="PiPulse Hub")
    ap.add_argument("--port", type=int, default=8750, help="dashboard port (HTTP)")
    ap.add_argument("--link-port", type=int, help="encrypted client link port (default: port + 1)")
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--data", default=str(ROOT / "data"), help="data directory")
    ap.add_argument("--set-password", action="store_true", help="create or reset the 'admin' account and exit")
    ap.add_argument("--if-no-account", action="store_true", help="with --set-password: only when no account exists yet")
    args = ap.parse_args()
    data = Path(args.data)

    if args.set_password:
        data.mkdir(parents=True, exist_ok=True)
        store = Store(str(data / "pipulse.db"))
        web = web_mod.Web(meta={"name": "PiPulse", "slug": "pipulse"}, data=data, renderer=WEB_DIR, kit=KIT_DIR, version=VERSION,
                          roles=ROLES, legacy_hash=store.settings.get("_password"))
        if args.if_no_account and web.has_users():
            return print("An account already exists; keeping it.")
        pw = os.environ.get("PIPULSE_PASSWORD") or getpass.getpass("Password for the 'admin' account (8+ characters): ")
        if not os.environ.get("PIPULSE_PASSWORD") and pw != getpass.getpass("Again: "):
            sys.exit("The two passwords differ.")
        try:
            web.set_password(pw)
        except ValueError as e:
            sys.exit(str(e))
        store.add_event(None, "info", "auth", "admin password set from the command line")
        return print("Saved. Sign in as 'admin'. If the hub is running, restart it now (sudo systemctl restart pipulse-hub);\n"
                     "pipulse-hub set-password does that for you.")

    hub = Hub(data, args.port, args.link_port or args.port + 1)
    Base.hub = hub
    WebHandler.web = make_web(hub)
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
