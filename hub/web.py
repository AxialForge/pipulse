"""Bracket's web contract on the standard library, for the PiPulse Hub.

The Bracket renderer (kit/renderer, vendored whole) talks to its server through one contract:
POST /api/<channel> with a JSON array of arguments -> {ok, result} | {ok: false, reason, error},
POST /api/login | /api/logout | /api/reauth, and GET /api/events (server-sent events). This is a
port of kit/python/bracket_fastapi.py onto http.server, because the hub is stdlib-only (no
FastAPI, no pip). It keeps that adapter's security model: accounts with admin/standard roles,
cookie sessions named <slug>_session, lockout after repeated failures, LAN-only, guest access off,
re-authentication for SENSITIVE channels, an audit log, the Home Assistant status URL, and a
same-origin check on every POST.

PiPulse additions:
  * the first account can be created from the sign-in dialog while no account exists (the
    installer normally creates it on the Pi), and 0.4's single dashboard password becomes the
    "admin" account on upgrade;
  * password hashes may be PiPulse 0.4's "pbkdf2$..." format as well as the kit's scrypt one.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import queue
import secrets
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

SESSION_DAYS = 30
REAUTH_MINUTES = 5
LOCK_FAILS, LOCK_WINDOW, LOCK_FOR = 8, 15 * 60, 15 * 60
MIN_PASSWORD = 8
CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
SEC_HEADERS = {"Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
               "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin", "Cache-Control": "no-store"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
         ".webmanifest": "application/manifest+json"}


def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    return salt + ":" + hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()


def check_password(pw: str, stored: str | None) -> bool:
    if not stored:
        return False
    if stored.startswith("pbkdf2$"):  # PiPulse 0.4
        try:
            _, rounds, salt, digest = stored.split("$")
            got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(rounds)).hex()
            return hmac.compare_digest(got, digest)
        except ValueError:
            return False
    if ":" not in stored:
        return False
    salt, hexed = stored.split(":", 1)
    return hmac.compare_digest(hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex(), hexed)


def is_private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip.removeprefix("::ffff:"))
    except ValueError:
        return False
    cgnat = a.version == 4 and ipaddress.ip_address("100.64.0.0") <= a <= ipaddress.ip_address("100.127.255.255")
    return a.is_private or a.is_loopback or a.is_link_local or cgnat


class Web:
    def __init__(self, *, meta: dict, data: Path, renderer: Path, kit: Path, version: str, roles: dict,
                 status_fn=None, log=print, legacy_hash: str | None = None):
        self.meta, self.slug = meta, meta.get("slug", "app")
        self.data, self.renderer, self.kit = Path(data), Path(renderer), Path(kit)
        self.version, self.log, self.status_fn = version, log, status_fn
        self.cookie = f"{self.slug}_session"
        self.lock = threading.RLock()
        self.handlers: dict = {}
        self.ctx_handlers: set = set()
        self.GUEST = {"app:info", "security:me", "prefs:get", *roles.get("GUEST", [])}
        self.STANDARD = {*self.GUEST, "settings:get", "sys:stats", "db:stats", "security:changePassword", "prefs:set",
                         *roles.get("STANDARD", [])}
        self.SENSITIVE = {"security:changePassword", "security:setOptions", "security:revokeOthers", "security:addUser",
                          "security:setRole", "security:resetPassword", "security:deleteUser", "settings:replace",
                          "status:rotate", *roles.get("SENSITIVE", [])}
        self.web_file = self.data / "web.json"
        self.web = {"users": {}, "guestEnabled": False, "lanOnly": True, "idleMinutes": 0, "sessions": {}, "statusKey": None}
        if self.web_file.exists():
            self.web.update(json.loads(self.web_file.read_text("utf-8")))
        if not self.web["users"] and legacy_hash:
            self.web["users"]["admin"] = {"hash": legacy_hash, "role": "admin", "created": int(time.time() * 1000)}
            self._save_web()
            self.log("web: PiPulse 0.4's dashboard password is now the 'admin' account")
        self.settings_file = self.data / "kit-settings.json"
        self.settings = json.loads(self.settings_file.read_text("utf-8")) if self.settings_file.exists() else {}
        self.fails: dict = {}
        self.bans: dict = {}
        self.audit_log: list = []
        self.queues: set = set()
        self._register_kit_handlers()

    # ---- persistence, audit, events -----------------------------------------------------------
    def _save_web(self):
        with self.lock:
            tmp = self.web_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.web, indent=1), "utf-8")
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.web_file)

    def audit(self, event, ip, detail="", user=None):
        e = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, "ip": ip, "user": user, "detail": detail}
        with self.lock:
            self.audit_log.append(e)
            self.audit_log = self.audit_log[-300:]
        try:
            with open(self.data / "security.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(e) + "\n")
        except OSError:
            pass
        self.log(f"security: {event} {user + '@' if user else ''}{ip or ''} {detail}".strip())

    def handler(self, channel, *, ctx=False):
        def deco(fn):
            self.handlers[channel] = fn
            if ctx:
                self.ctx_handlers.add(channel)
            return fn
        return deco

    def send(self, channel, payload=None):
        msg = json.dumps({"channel": channel, "payload": payload})
        for q in list(self.queues):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass

    def set_password(self, pw, user="admin"):
        if len(pw) < MIN_PASSWORD:
            raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
        with self.lock:
            old = self.web["users"].get(user, {"created": int(time.time() * 1000)})
            self.web["users"][user] = {**old, "hash": hash_password(pw), "role": "admin"}
            self.web["sessions"] = {k: s for k, s in self.web["sessions"].items() if s["user"] != user}
            self._save_web()

    def has_users(self):
        return bool(self.web["users"])

    # ---- request context -------------------------------------------------------------------------
    @staticmethod
    def _sock_ip(h):
        return (h.client_address[0] if h.client_address else "") or ""

    def client_ip(self, h):
        sock = self._sock_ip(h)
        fwd = h.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if sock in ("127.0.0.1", "::1") and fwd else sock

    def proxied(self, h):
        return self._sock_ip(h) in ("127.0.0.1", "::1") and bool(h.headers.get("X-Forwarded-For"))

    def proto(self, h):
        return "https" if self.proxied(h) and h.headers.get("X-Forwarded-Proto", "").lower() == "https" else "http"

    def session_of(self, h):
        c = SimpleCookie(h.headers.get("Cookie", ""))
        sid = c[self.cookie].value if self.cookie in c else None
        with self.lock:
            s = self.web["sessions"].get(sid) if sid else None
            if not s:
                return None
            now = time.time() * 1000
            idle = self.web["idleMinutes"] * 60000
            if s["expires"] < now or (idle and now - s["lastSeen"] > idle) or s["user"] not in self.web["users"]:
                self.web["sessions"].pop(sid, None)
                self._save_web()
                return None
            if now - s["lastSeen"] > 60000:
                s["lastSeen"] = now
                self._save_web()
            return {"id": sid, **s, "role": self.web["users"][s["user"]]["role"]}

    def role_of(self, session):
        return session["role"] if session else ("guest" if self.web["guestEnabled"] else None)

    def refused(self, h):
        """LAN-only gate for every request (pages, API and install scripts alike)."""
        ip = self.client_ip(h)
        if self.web["lanOnly"] and not is_private(ip):
            self.audit("refused_non_lan", ip, urlparse(h.path).path)
            return True
        return False

    def _failed(self, ip):
        now = time.time()
        with self.lock:
            fl = [t for t in self.fails.get(ip, []) if now - t < LOCK_WINDOW] + [now]
            self.fails[ip] = fl
            if len(fl) >= LOCK_FAILS:
                self.bans[ip] = now + LOCK_FOR
                self.fails.pop(ip, None)
                self.audit("ip_locked", ip, f"{LOCK_FAILS} failures")

    def _banned(self, ip):
        u = self.bans.get(ip)
        if u and u > time.time():
            return True
        self.bans.pop(ip, None)
        return False

    def _login(self, ip, ua, body):
        if self._banned(ip):
            self.audit("login_blocked", ip, "locked out")
            return {"ok": False, "reason": "locked"}
        u = str(body.get("username", "")).strip().lower()
        pw = str(body.get("password", ""))
        with self.lock:
            if not self.web["users"]:
                # First run: the first account made from the sign-in dialog becomes the admin.
                if not (2 <= len(u) <= 32) or not u.replace(".", "").replace("_", "").replace("-", "").isalnum():
                    return {"ok": False, "reason": "firstrun", "error": "Choose a username: 2–32 letters, digits, dot, dash or underscore."}
                if len(pw) < MIN_PASSWORD:
                    return {"ok": False, "reason": "firstrun", "error": f"Choose a password of at least {MIN_PASSWORD} characters."}
                self.web["users"][u] = {"hash": hash_password(pw), "role": "admin", "created": int(time.time() * 1000)}
                self.audit("first_admin", ip, "created from the sign-in page", u)
            user = self.web["users"].get(u)
            if not user or not check_password(pw, user.get("hash")):
                self._failed(ip)
                self.audit("login_failed", ip, "wrong password" if user else "unknown user", u or None)
                return {"ok": False, "reason": "password"}
            self.fails.pop(ip, None)
            if user["hash"].startswith("pbkdf2$"):
                user["hash"] = hash_password(pw)  # move 0.4's hash to the kit's format on the way in
            sid = secrets.token_hex(32)
            now = time.time() * 1000
            self.web["sessions"][sid] = {"user": u, "role": user["role"], "created": now, "expires": now + SESSION_DAYS * 86400000,
                                         "lastSeen": now, "ip": ip, "ua": ua[:160], "reauthAt": now}
            user["lastLogin"] = now
            self._save_web()
        self.audit("login", ip, user["role"], u)
        return {"ok": True, "id": sid, "role": user["role"], "username": u}

    # ---- the kit's own channels (Security page, About, settings sections) ------------------------
    def _register_kit_handlers(self):
        h = self.handler

        def hc(ch):
            return self.handler(ch, ctx=True)

        @hc("security:me")
        def me(ctx):
            return {"available": True, "guest": ctx["role"] == "guest", "username": ctx["session"]["user"] if ctx["session"] else None,
                    "role": ctx["role"], "guestEnabled": self.web["guestEnabled"], "hasUsers": bool(self.web["users"])}

        @hc("security:status")
        def status(ctx):
            cur = ctx["session"]
            admins = sum(1 for u in self.web["users"].values() if u["role"] == "admin")
            checks = [
                {"ok": admins > 0, "name": "Admin account", "detail": f"{admins} admin, {len(self.web['users']) - admins} standard user(s)", "level": "ok" if admins else "bad"},
                {"ok": False, "name": "Two-factor codes for admins", "detail": "not available on the PiPulse hub yet", "level": "warn"},
                {"ok": self.web["lanOnly"], "name": "LAN-only access", "detail": "connections from outside private address ranges are refused" if self.web["lanOnly"] else "off", "level": "ok" if self.web["lanOnly"] else "warn"},
                {"ok": not self.web["guestEnabled"], "name": "Guest access", "detail": "on" if self.web["guestEnabled"] else "off: every page needs an account", "level": "ok" if not self.web["guestEnabled"] else "warn"},
                {"ok": ctx["proxyHttps"], "name": "HTTPS", "detail": "terminated by Caddy in front of the hub" if ctx["proxyHttps"] else "plain HTTP: open it through https://pipulse.home (Caddy) instead", "level": "ok" if ctx["proxyHttps"] else "warn"},
            ]
            return {"available": True, "https": False, "proxy": ctx["proxy"], "proxyHttps": ctx["proxyHttps"], "port": ctx.get("port"),
                    "bindHost": None, "dataDir": str(self.data), "checks": checks, "opensslAvailable": False,
                    "passwordSet": bool(self.web["users"]), "totpEnabled": False, "totpPending": False, "lanOnly": self.web["lanOnly"],
                    "idleMinutes": self.web["idleMinutes"], "guestEnabled": self.web["guestEnabled"],
                    "me": {"username": cur["user"], "role": cur["role"]} if cur else None,
                    "users": sorted([{"username": n, "role": u["role"], "created": u.get("created"), "lastLogin": u.get("lastLogin"),
                                      "sessions": sum(1 for s in self.web["sessions"].values() if s["user"] == n)}
                                     for n, u in self.web["users"].items()], key=lambda x: x["username"]),
                    "sessions": sorted([{"id": sid[:8], "current": bool(cur and sid == cur["id"]), "user": s["user"], "role": s["role"],
                                         "created": s["created"], "lastSeen": s["lastSeen"], "expires": s["expires"], "ip": s["ip"], "ua": s["ua"]}
                                        for sid, s in self.web["sessions"].items()], key=lambda x: -x["lastSeen"]),
                    "events": list(reversed(self.audit_log[-100:])),
                    "banned": [{"ip": ip, "until": u * 1000} for ip, u in self.bans.items() if u > time.time()],
                    "failedLogins24h": sum(1 for e in self.audit_log if e["event"] == "login_failed"),
                    "limits": {"lockFails": LOCK_FAILS, "lockMinutes": LOCK_FOR // 60, "reauthMinutes": REAUTH_MINUTES,
                               "sessionDays": SESSION_DAYS, "minPassword": MIN_PASSWORD}}

        @hc("security:changePassword")
        def change_password(ctx, current=None, nxt=None):
            u = self.web["users"][ctx["session"]["user"]]
            if not check_password(str(current or ""), u["hash"]):
                self._failed(ctx["ip"])
                raise ValueError("Current password is wrong")
            if not nxt or len(nxt) < MIN_PASSWORD:
                raise ValueError(f"New password must be at least {MIN_PASSWORD} characters")
            with self.lock:
                u["hash"] = hash_password(nxt)
                for sid in [k for k, s in self.web["sessions"].items() if s["user"] == ctx["session"]["user"] and k != ctx["session"]["id"]]:
                    self.web["sessions"].pop(sid)
                self._save_web()
            self.audit("password_changed", ctx["ip"], "", ctx["session"]["user"])
            return True

        @hc("security:setOptions")
        def set_options(ctx, opts=None):
            opts = opts or {}
            with self.lock:
                for k in ("lanOnly", "guestEnabled"):
                    if isinstance(opts.get(k), bool):
                        self.web[k] = opts[k]
                if opts.get("idleMinutes") is not None:
                    self.web["idleMinutes"] = max(0, min(10080, int(opts["idleMinutes"] or 0)))
                self._save_web()
            self.audit("options_changed", ctx["ip"], json.dumps(opts), ctx["session"]["user"])
            return True

        @hc("security:users")
        def users(ctx):
            return status(ctx)["users"]

        @hc("security:addUser")
        def add_user(ctx, name=None, password=None, role="standard"):
            u = str(name or "").strip().lower()
            if not (2 <= len(u) <= 32) or not u.replace(".", "").replace("_", "").replace("-", "").isalnum():
                raise ValueError("Username: 2–32 characters, letters, digits, dot, dash or underscore")
            if u in self.web["users"]:
                raise ValueError("That username already exists")
            if role not in ("admin", "standard"):
                raise ValueError("Role must be admin or standard")
            if not password or len(password) < MIN_PASSWORD:
                raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
            with self.lock:
                self.web["users"][u] = {"hash": hash_password(password), "role": role, "created": int(time.time() * 1000)}
                self._save_web()
            self.audit("user_added", ctx["ip"], f"{u} ({role})", ctx["session"]["user"])
            return True

        def _admins():
            return sum(1 for x in self.web["users"].values() if x["role"] == "admin")

        @hc("security:setRole")
        def set_role(ctx, name=None, role=None):
            u = str(name or "").lower()
            if u not in self.web["users"]:
                raise ValueError("No such user")
            if role not in ("admin", "standard"):
                raise ValueError("Role must be admin or standard")
            if self.web["users"][u]["role"] == "admin" and role != "admin" and _admins() == 1:
                raise ValueError("That is the last admin")
            with self.lock:
                self.web["users"][u]["role"] = role
                for s in self.web["sessions"].values():
                    if s["user"] == u:
                        s["role"] = role
                self._save_web()
            self.audit("role_changed", ctx["ip"], f"{u} → {role}", ctx["session"]["user"])
            return True

        @hc("security:resetPassword")
        def reset_password(ctx, name=None, password=None):
            u = str(name or "").lower()
            if u not in self.web["users"]:
                raise ValueError("No such user")
            if not password or len(password) < MIN_PASSWORD:
                raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
            with self.lock:
                self.web["users"][u]["hash"] = hash_password(password)
                for sid in [k for k, s in self.web["sessions"].items() if s["user"] == u]:
                    self.web["sessions"].pop(sid)
                self._save_web()
            self.audit("password_reset", ctx["ip"], u, ctx["session"]["user"])
            return True

        @hc("security:deleteUser")
        def delete_user(ctx, name=None):
            u = str(name or "").lower()
            if u not in self.web["users"]:
                raise ValueError("No such user")
            if self.web["users"][u]["role"] == "admin" and _admins() == 1:
                raise ValueError("That is the last admin")
            with self.lock:
                self.web["users"].pop(u)
                for sid in [k for k, s in self.web["sessions"].items() if s["user"] == u]:
                    self.web["sessions"].pop(sid)
                self._save_web()
            self.audit("user_deleted", ctx["ip"], u, ctx["session"]["user"])
            return True

        @hc("security:revoke")
        def revoke(ctx, short=None):
            with self.lock:
                for sid in list(self.web["sessions"]):
                    if sid[:8] == short and sid != ctx["session"]["id"]:
                        self.web["sessions"].pop(sid)
                        self._save_web()
                        self.audit("session_revoked", ctx["ip"], short, ctx["session"]["user"])
                        return True
            return False

        @hc("security:revokeOthers")
        def revoke_others(ctx):
            with self.lock:
                others = [sid for sid in self.web["sessions"] if sid != ctx["session"]["id"]]
                for sid in others:
                    self.web["sessions"].pop(sid)
                self._save_web()
            self.audit("sessions_revoked", ctx["ip"], f"{len(others)} other session(s)", ctx["session"]["user"])
            return len(others)

        def unavailable(*_a, **_k):
            raise ValueError("Not available on the PiPulse hub; HTTPS comes from Caddy in front of it")
        for ch in ("security:totpSetup", "security:totpEnable", "security:totpDisable", "security:tlsEnable"):
            self.handlers[ch] = unavailable

        @hc("prefs:get")
        def prefs_get(ctx):
            u = self.web["users"].get(ctx["session"]["user"]) if ctx["session"] else next(
                (x for x in self.web["users"].values() if x["role"] == "admin"), None)
            return (u or {}).get("prefs", {})

        @hc("prefs:set")
        def prefs_set(ctx, patch=None):
            if not ctx["session"]:
                raise ValueError("Sign in to save preferences")
            with self.lock:
                u = self.web["users"][ctx["session"]["user"]]
                p = {**u.get("prefs", {}), **(patch or {})}
                u["prefs"] = {k: v for k, v in p.items() if v is not None}
                self._save_web()
            return u["prefs"]

        @hc("status:info")
        def status_info(ctx):
            with self.lock:
                if not self.web.get("statusKey"):
                    self.web["statusKey"] = secrets.token_urlsafe(18)
                    self._save_web()
            return {"available": True, "url": f"{ctx['proto']}://{ctx['host']}/api/status?key={self.web['statusKey']}"}

        @hc("status:rotate")
        def status_rotate(ctx):
            with self.lock:
                self.web["statusKey"] = secrets.token_urlsafe(18)
                self._save_web()
            self.audit("status_key", ctx["ip"], "rotated", ctx["session"]["user"])
            return status_info(ctx)

        @h("settings:get")
        def settings_get():
            return self.settings

        @h("settings:set")
        def settings_set(patch=None):
            self.settings = {**self.settings, **(patch or {})}
            self.settings_file.write_text(json.dumps(self.settings, indent=1), "utf-8")
            return self.settings

        @h("settings:replace")
        def settings_replace(nxt=None):
            self.settings = dict(nxt or {})
            self.settings_file.write_text(json.dumps(self.settings, indent=1), "utf-8")
            return self.settings

        for ch, val in (("dialog:pickFolder", None), ("dialog:pickFile", None), ("shell:open", False),
                        ("shell:openExternal", False), ("shell:showItem", False), ("update:install", {"ok": False}),
                        ("update:status", {"state": "idle"}), ("db:stats", {"file": None, "size": 0, "version": None}),
                        ("log:tail", []), ("notify:test", {"webhook": None, "email": None})):
            self.handlers[ch] = (lambda v: (lambda *_a, **_k: v))(val)

    # ---- HTTP -------------------------------------------------------------------------------------
    def _reply(self, h, code, body, cookie=None):
        data = json.dumps(body).encode()
        h.send_response(code)
        h.send_header("Content-Type", "application/json")
        h.send_header("Content-Length", str(len(data)))
        for k, v in SEC_HEADERS.items():
            h.send_header(k, v)
        if cookie is not None:
            h.send_header("Set-Cookie", cookie)
        h.end_headers()
        h.wfile.write(data)

    def _body(self, h):
        n = int(h.headers.get("Content-Length") or 0)
        if n > 2_000_000:
            raise ValueError("body too large")
        return json.loads(h.rfile.read(n) or b"null")

    def _cookie(self, value, max_age):
        return f"{self.cookie}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"

    def get(self, h, path):
        """GET: status URL, events, static files. Returns False when the path isn't ours."""
        url = urlparse(h.path)
        if path == "/api/status":
            key = parse_qs(url.query).get("key", [""])[0]
            if not self.web.get("statusKey") or not hmac.compare_digest(key, self.web["statusKey"]):
                self.audit("status_refused", self.client_ip(h), "bad key")
                self._reply(h, 401, {"ok": False, "error": "bad key"})
            else:
                self._reply(h, 200, self.status_fn() if self.status_fn else {"ok": True})
            return True
        if path == "/api/firstrun":
            self._reply(h, 200, {"firstRun": not self.web["users"]})
            return True
        if path == "/api/events":
            if not self.role_of(self.session_of(h)):
                self._reply(h, 401, {"ok": False, "reason": "login", "error": "sign in required"})
                return True
            self._events(h)
            return True
        if path.startswith("/kit/renderer/"):
            return self._static(h, self.kit, path[len("/kit/renderer/"):])
        return self._static(h, self.renderer, path.lstrip("/") or "index.html")

    def _static(self, h, root, name):
        root = root.resolve()
        p = (root / name).resolve()
        if root not in p.parents or not p.is_file():
            return False
        data = p.read_bytes()
        h.send_response(200)
        h.send_header("Content-Type", TYPES.get(p.suffix, "application/octet-stream"))
        h.send_header("Content-Length", str(len(data)))
        for k, v in SEC_HEADERS.items():
            h.send_header(k, "no-cache" if k == "Cache-Control" else v)
        h.end_headers()
        h.wfile.write(data)
        return True

    def _events(self, h):
        q = queue.Queue(maxsize=200)
        self.queues.add(q)
        try:
            h.send_response(200)
            h.send_header("Content-Type", "text/event-stream")
            h.send_header("Cache-Control", "no-store")
            h.send_header("X-Accel-Buffering", "no")
            h.end_headers()
            h.wfile.write(b": connected\n\n")
            h.wfile.flush()
            while True:
                try:
                    h.wfile.write(f"data: {q.get(timeout=25)}\n\n".encode())
                except queue.Empty:
                    h.wfile.write(b": ping\n\n")
                h.wfile.flush()
        except OSError:
            pass
        finally:
            self.queues.discard(q)

    def post(self, h, path, extra_ctx=None):
        """POST /api/login | logout | reauth | <channel>. Returns False when the path isn't ours."""
        if not path.startswith("/api/"):
            return False
        channel = unquote(path[len("/api/"):])  # webbridge encodes the ':' in channel names
        ip = self.client_ip(h)
        origin = h.headers.get("Origin")
        if origin and origin.split("//", 1)[-1] != h.headers.get("Host"):
            self.audit("cross_origin_refused", ip, origin)
            self._reply(h, 403, {"ok": False, "error": "cross-origin request refused"})
            return True
        try:
            body = self._body(h)
        except ValueError:
            self._reply(h, 400, {"ok": False, "error": "request body must be JSON"})
            return True
        if channel == "login":
            r = self._login(ip, h.headers.get("User-Agent", ""), body if isinstance(body, dict) else {})
            if r["ok"]:
                self._reply(h, 200, {"ok": True, "username": r["username"], "role": r["role"]}, self._cookie(r["id"], SESSION_DAYS * 86400))
            else:
                code = {"locked": 429, "firstrun": 400}.get(r["reason"], 401)
                err = r.get("error") or {"locked": "Too many failed attempts; this address is locked for 15 minutes",
                                         "password": "Wrong username or password"}.get(r["reason"], "Sign-in failed")
                self._reply(h, code, {"ok": False, "reason": r["reason"], "error": err})
            return True
        session = self.session_of(h)
        role = self.role_of(session)
        if channel == "logout":
            cookie = None
            if session:
                with self.lock:
                    self.web["sessions"].pop(session["id"], None)
                    self._save_web()
                self.audit("logout", ip, "", session["user"])
                cookie = self._cookie("", 0)
            self._reply(h, 200, {"ok": True}, cookie)
            return True
        if not role:
            self._reply(h, 401, {"ok": False, "reason": "login", "error": "sign in required"})
            return True
        if channel == "reauth":
            u = self.web["users"].get(session["user"]) if session else None
            if not u or self._banned(ip) or not check_password(str((body or {}).get("password", "")), u["hash"]):
                self._failed(ip)
                self.audit("reauth_failed", ip, "", session["user"] if session else None)
                self._reply(h, 401, {"ok": False, "reason": "reauth_bad", "error": "Wrong password"})
            else:
                with self.lock:
                    self.web["sessions"][session["id"]]["reauthAt"] = time.time() * 1000
                    self._save_web()
                self.audit("reauth", ip, "", session["user"])
                self._reply(h, 200, {"ok": True})
            return True
        fn = self.handlers.get(channel)
        if not fn:
            self._reply(h, 404, {"ok": False, "error": f"unknown channel {channel}"})
            return True
        allowed = role == "admin" or (channel in self.STANDARD if role == "standard" else channel in self.GUEST)
        if not allowed:
            if not session:
                self._reply(h, 401, {"ok": False, "reason": "login", "error": "sign in required"})
            else:
                self.audit("forbidden", ip, channel, session["user"])
                self._reply(h, 403, {"ok": False, "reason": "forbidden", "error": "Your account is not allowed to do that"})
            return True
        if not isinstance(body, list):
            self._reply(h, 400, {"ok": False, "error": "arguments must be an array"})
            return True
        if channel in self.SENSITIVE:
            if not session or time.time() * 1000 - session.get("reauthAt", 0) > REAUTH_MINUTES * 60000:
                self._reply(h, 401, {"ok": False, "reason": "reauth", "error": "Please re-enter your password for this action"})
                return True
            self.audit("sensitive_action", ip, channel, session["user"])
        proxied = self.proxied(h)
        ctx = {"session": session, "ip": ip, "role": role, "proxy": proxied, "proxyHttps": proxied and self.proto(h) == "https",
               "proto": self.proto(h), "host": h.headers.get("Host", ""), **(extra_ctx or {})}
        try:
            result = fn(ctx, *body) if channel in self.ctx_handlers else fn(*body)
            self._reply(h, 200, {"ok": True, "result": result})
        except (ValueError, KeyError, TypeError) as e:
            self._reply(h, 400, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001 -- report, never crash the handler thread
            self.log(f"{channel}: {e!r}")
            self._reply(h, 500, {"ok": False, "error": str(e)})
        return True
