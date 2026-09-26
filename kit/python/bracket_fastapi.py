"""Bracket adapter for FastAPI apps.

The Bracket renderer (kit/renderer) talks to its backend through one contract: POST /api/<channel>
with a JSON array of arguments → { ok, result } | { ok: false, reason, error }, and GET /api/events
as a server-sent-events stream of { channel, payload }. This module gives a FastAPI app that
contract plus the kit's own channels (sign-in, sessions, roles, preferences, settings with secret
redaction, the status URL, system stats, log tail, update check), so the same pages, cards and
dashboard editor run in front of a Python backend.

    from kit.python.bracket_fastapi import Bracket
    bk = Bracket(app_json="app/app.json", data_dir="data", renderer_dir="app/renderer", kit_dir="kit/renderer",
                 roles={"GUEST": ["data:dashboard"], "STANDARD": ["items:list"], "SENSITIVE": ["items:delete"]},
                 secrets=["notify.email.pass"])
    @bk.handler("items:list")
    def items_list(): ...
    bk.mount(fastapi_app)                # routes + static files
    bk.send("items:changed", {"id": 3})  # push an event to every open page

Not implemented here (they answer "not available"): two-factor codes and the self-signed HTTPS
switch. Put Caddy in front for TLS, as the Node shell does on the Pi.
Requires Python 3.11+, FastAPI and uvicorn; nothing else.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import shutil
import socket
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

REDACTED = "••••"
SESSION_DAYS = 30
REAUTH_MINUTES = 5
LOCK_FAILS, LOCK_WINDOW, LOCK_FOR = 8, 15 * 60, 15 * 60
MIN_PASSWORD = 8
CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
WEB_CHANNELS = ["app:info", "update:check", "settings:get", "settings:set", "settings:replace", "security:me", "security:status", "security:tlsEnable", "security:changePassword", "security:totpSetup", "security:totpEnable", "security:totpDisable", "security:setOptions", "security:revoke", "security:revokeOthers", "security:users", "security:addUser", "security:setRole", "security:resetPassword", "security:deleteUser", "prefs:get", "prefs:set", "status:info", "status:rotate", "dialog:pickFolder", "dialog:pickFile", "shell:open", "shell:openExternal", "shell:showItem", "update:install", "update:status", "sys:stats", "db:stats", "log:tail", "notify:test"]


def _hash(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    return salt + ":" + hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()


def _check(pw: str, stored: str | None) -> bool:
    if not stored or ":" not in stored:
        return False
    salt, hexed = stored.split(":", 1)
    return hmac.compare_digest(hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex(), hexed)


def _private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip.removeprefix("::ffff:"))
    except ValueError:
        return False
    return a.is_private or a.is_loopback or a.is_link_local or (a.version == 4 and ipaddress.ip_address("100.64.0.0") <= a <= ipaddress.ip_address("100.127.255.255"))


def _get_path(o: Any, dotted: str) -> Any:
    for k in dotted.split("."):
        if not isinstance(o, dict):
            return None
        o = o.get(k)
    return o


def _set_path(o: dict, dotted: str, v: Any) -> None:
    keys = dotted.split(".")
    for k in keys[:-1]:
        o = o.setdefault(k, {})
    o[keys[-1]] = v


def _merge(base: Any, patch: Any) -> Any:
    if isinstance(patch, dict):
        out = dict(base) if isinstance(base, dict) else {}
        for k, v in patch.items():
            out[k] = _merge(out.get(k), v)
        return out
    return patch


class Bracket:
    def __init__(self, app_json: str | Path, data_dir: str | Path, renderer_dir: str | Path, kit_dir: str | Path, *, roles: dict | None = None, secrets: list[str] | None = None, defaults: dict | None = None, version: str = "0.0.0", status_channel: str = "data:status", log: Callable[[str], None] | None = None) -> None:
        self.meta = json.loads(Path(app_json).read_text("utf-8"))
        self.slug = self.meta.get("slug", "bracket")
        self.data = Path(data_dir); self.data.mkdir(parents=True, exist_ok=True)
        self.renderer = Path(renderer_dir); self.kit = Path(kit_dir)
        self.version = version
        self.status_channel = status_channel
        self.secrets = secrets or []
        self.log = log or (lambda s: print(s, flush=True))
        self.handlers: dict[str, Callable] = {}
        self.ctx_handlers: set[str] = set()
        roles = roles or {}
        self.GUEST = {"app:info", "security:me", "prefs:get", *roles.get("GUEST", [])}
        self.STANDARD = {*self.GUEST, "settings:get", "sys:stats", "db:stats", "security:changePassword", "prefs:set", *roles.get("STANDARD", [])}
        self.SENSITIVE = {"security:changePassword", "security:setOptions", "security:revokeOthers", "security:addUser", "security:setRole", "security:resetPassword", "security:deleteUser", "settings:replace", "status:rotate", *roles.get("SENSITIVE", [])}
        self.settings_file = self.data / "settings.json"
        self.settings: dict = _merge({"ui": {"prefs": {}}, "notify": {"webhookUrl": "", "email": {"enabled": False, "host": "", "port": 587, "secure": False, "user": "", "pass": "", "from": "", "to": ""}, "events": {}, "dailyTime": "08:00"}, "githubToken": ""}, defaults or {})
        if self.settings_file.exists():
            self.settings = _merge(self.settings, json.loads(self.settings_file.read_text("utf-8")))
        self.web_file = self.data / "web.json"
        self.web: dict = {"users": {}, "guestEnabled": False, "lanOnly": True, "idleMinutes": 0, "sessions": {}, "statusKey": None}
        if self.web_file.exists():
            self.web.update(json.loads(self.web_file.read_text("utf-8")))
        self.cookie = f"{self.slug}_session"
        self.fails: dict[str, list[float]] = {}
        self.bans: dict[str, float] = {}
        self.audit_log: list[dict] = []
        self.queues: set[asyncio.Queue] = set()
        self._register_kit_handlers()

    # ---- persistence -----------------------------------------------------------------------------
    def _save_web(self) -> None:
        self.web_file.write_text(json.dumps(self.web, indent=2), "utf-8")
        try: os.chmod(self.web_file, 0o600)
        except OSError: pass

    def _save_settings(self) -> None:
        self.settings_file.write_text(json.dumps(self.settings, indent=2), "utf-8")
        try: os.chmod(self.settings_file, 0o600)
        except OSError: pass

    def audit(self, event: str, ip: str | None, detail: str = "", user: str | None = None) -> None:
        e = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, "ip": ip, "user": user, "detail": detail}
        self.audit_log.append(e); self.audit_log = self.audit_log[-300:]
        try:
            with open(self.data / "security.log", "a", encoding="utf-8") as f: f.write(json.dumps(e) + "\n")
        except OSError: pass
        self.log(f"security: {event} {user + '@' if user else ''}{ip or ''} {detail}".strip())

    # ---- registry --------------------------------------------------------------------------------
    def handler(self, channel: str, *, ctx: bool = False):
        """Register a handler. With ctx=True it receives { session, ip, role } as its first argument."""
        def deco(fn: Callable):
            self.handlers[channel] = fn
            if ctx: self.ctx_handlers.add(channel)
            return fn
        return deco

    def send(self, channel: str, payload: Any = None) -> None:
        """Push an event to every open page (the renderer's `!channel` listeners)."""
        msg = json.dumps({"channel": channel, "payload": payload})
        for q in list(self.queues):
            try: q.put_nowait(msg)
            except asyncio.QueueFull: pass

    def set_password(self, pw: str) -> None:
        """Create or reset the admin account (for a CLI / installer)."""
        if len(pw) < MIN_PASSWORD: raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
        self.web["users"]["admin"] = {**self.web["users"].get("admin", {"created": int(time.time() * 1000)}), "hash": _hash(pw), "role": "admin"}
        self.web["sessions"] = {}; self._save_web()

    # ---- sessions --------------------------------------------------------------------------------
    def _session_of(self, request: Request) -> dict | None:
        sid = request.cookies.get(self.cookie)
        s = self.web["sessions"].get(sid) if sid else None
        if not s: return None
        now = time.time() * 1000
        idle = self.web["idleMinutes"] * 60000
        if s["expires"] < now or (idle and now - s["lastSeen"] > idle) or s["user"] not in self.web["users"]:
            self.web["sessions"].pop(sid, None); self._save_web(); return None
        if now - s["lastSeen"] > 60000: s["lastSeen"] = now; self._save_web()
        return {"id": sid, **s, "role": self.web["users"][s["user"]]["role"]}

    def _client_ip(self, request: Request) -> str:
        sock = (request.client.host if request.client else "") or ""
        if sock in ("127.0.0.1", "::1") and request.headers.get("x-forwarded-for"):
            return request.headers["x-forwarded-for"].split(",")[0].strip()
        return sock

    def _proxied(self, request: Request) -> bool:
        sock = (request.client.host if request.client else "") or ""
        return sock in ("127.0.0.1", "::1") and bool(request.headers.get("x-forwarded-for"))

    def _proto(self, request: Request) -> str:
        return "https" if self._proxied(request) and request.headers.get("x-forwarded-proto", "").lower() == "https" else request.url.scheme

    def _failed(self, ip: str) -> None:
        now = time.time(); l = [t for t in self.fails.get(ip, []) if now - t < LOCK_WINDOW]; l.append(now); self.fails[ip] = l
        if len(l) >= LOCK_FAILS: self.bans[ip] = now + LOCK_FOR; self.fails.pop(ip, None); self.audit("ip_locked", ip, f"{LOCK_FAILS} failures")

    def _banned(self, ip: str) -> bool:
        u = self.bans.get(ip)
        if u and u > time.time(): return True
        self.bans.pop(ip, None); return False

    def _login(self, ip: str, ua: str, body: dict) -> dict:
        if self._banned(ip): self.audit("login_blocked", ip, "locked out"); return {"ok": False, "reason": "locked"}
        if not self.web["users"]: return {"ok": False, "reason": "nopassword"}
        u = str(body.get("username", "")).strip().lower(); user = self.web["users"].get(u)
        if not user or not _check(str(body.get("password", "")), user.get("hash")):
            self._failed(ip); self.audit("login_failed", ip, "wrong password" if user else "unknown user", u or None); return {"ok": False, "reason": "password"}
        self.fails.pop(ip, None)
        sid = secrets.token_hex(32); now = time.time() * 1000
        self.web["sessions"][sid] = {"user": u, "role": user["role"], "created": now, "expires": now + SESSION_DAYS * 86400000, "lastSeen": now, "ip": ip, "ua": ua[:160], "reauthAt": now}
        user["lastLogin"] = now; self._save_web(); self.audit("login", ip, user["role"], u)
        return {"ok": True, "id": sid, "role": user["role"], "username": u}

    def _redact(self, s: dict) -> dict:
        out = json.loads(json.dumps(s))
        for p in self.secrets:
            if _get_path(out, p): _set_path(out, p, REDACTED)
        return out

    def _keep_secrets(self, patch: dict) -> dict:
        for p in self.secrets:
            if _get_path(patch, p) == REDACTED: _set_path(patch, p, _get_path(self.settings, p))
        return patch

    # ---- kit handlers ----------------------------------------------------------------------------
    def _register_kit_handlers(self) -> None:
        h, hc = self.handler, lambda ch: self.handler(ch, ctx=True)

        @h("app:info")
        def app_info():
            return {"version": self.version, "kit": (self.kit.parent / "VERSION").read_text().strip() if (self.kit.parent / "VERSION").exists() else None, "node": None, "python": os.sys.version.split()[0], "web": True, "https": False, "platform": f"{os.uname().sysname} {os.uname().release} ({os.uname().machine})" if hasattr(os, "uname") else os.name, "hostname": socket.gethostname(), "cpus": os.cpu_count(), "dataDir": str(self.data), "logFile": None, "dbFile": None, "repo": self.meta.get("repo"), "db": None, "name": self.meta.get("name"), "slug": self.slug}

        @h("update:check")
        def update_check():
            repo = (self.meta.get("repo") or "").split("github.com/")[-1]
            if not repo: return {"state": "error", "message": "No GitHub repository configured for this app."}
            try:
                req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest", headers={"user-agent": f"{self.slug}-server", "accept": "application/vnd.github+json"})
                with urllib.request.urlopen(req, timeout=8) as r: latest = json.load(r).get("tag_name", "").lstrip("v")
                newer = [int(x) for x in latest.split(".")[:3]] > [int(x) for x in self.version.split(".")[:3]]
                return {"state": "available" if newer else "current", "version": latest, "message": f"Version {latest} is available." if newer else f"You are on the latest version ({self.version})."}
            except Exception as e:  # noqa: BLE001
                return {"state": "error", "message": f"Could not reach GitHub: {e}"}

        @h("settings:get")
        def settings_get(): return self._redact(self.settings)

        @h("settings:set")
        def settings_set(patch=None):
            self.settings = _merge(self.settings, self._keep_secrets(patch or {})); self._save_settings(); return self._redact(self.settings)

        @h("settings:replace")
        def settings_replace(nxt=None):
            self.settings = _merge({}, self._keep_secrets(nxt or {})); self._save_settings(); return self._redact(self.settings)

        @hc("security:me")
        def me(ctx): return {"available": True, "guest": ctx["role"] == "guest", "username": ctx["session"]["user"] if ctx["session"] else None, "role": ctx["role"], "guestEnabled": self.web["guestEnabled"], "hasUsers": bool(self.web["users"])}

        @hc("security:status")
        def status(ctx):
            now = time.time() * 1000; cur = ctx["session"]
            admins = sum(1 for u in self.web["users"].values() if u["role"] == "admin")
            checks = [
                {"ok": admins > 0, "name": "Admin account", "detail": f"{admins} admin, {len(self.web['users']) - admins} standard user(s)", "level": "ok" if admins else "bad"},
                {"ok": False, "name": "Two-factor codes for admins", "detail": "not available in the Python adapter", "level": "warn"},
                {"ok": self.web["lanOnly"], "name": "LAN-only access", "detail": "connections from outside private address ranges are refused" if self.web["lanOnly"] else "off", "level": "ok" if self.web["lanOnly"] else "warn"},
                {"ok": not self.web["guestEnabled"], "name": "Guest access", "detail": "on" if self.web["guestEnabled"] else "off: every page needs an account", "level": "ok" if not self.web["guestEnabled"] else "warn"},
                {"ok": ctx["proxyHttps"], "name": "HTTPS", "detail": "terminated by the reverse proxy in front of this app" if ctx["proxyHttps"] else "plain HTTP: put Caddy with tls internal in front", "level": "ok" if ctx["proxyHttps"] else "warn"},
            ]
            return {"available": True, "https": False, "proxy": ctx["proxy"], "proxyHttps": ctx["proxyHttps"], "port": None, "bindHost": None, "dataDir": str(self.data), "checks": checks, "opensslAvailable": False,
                    "passwordSet": bool(self.web["users"]), "totpEnabled": False, "totpPending": False, "lanOnly": self.web["lanOnly"], "idleMinutes": self.web["idleMinutes"], "guestEnabled": self.web["guestEnabled"],
                    "me": {"username": cur["user"], "role": cur["role"]} if cur else None,
                    "users": sorted([{"username": n, "role": u["role"], "created": u.get("created"), "lastLogin": u.get("lastLogin"), "sessions": sum(1 for s in self.web["sessions"].values() if s["user"] == n)} for n, u in self.web["users"].items()], key=lambda x: x["username"]),
                    "sessions": sorted([{"id": sid[:8], "current": bool(cur and sid == cur["id"]), "user": s["user"], "role": s["role"], "created": s["created"], "lastSeen": s["lastSeen"], "expires": s["expires"], "ip": s["ip"], "ua": s["ua"]} for sid, s in self.web["sessions"].items()], key=lambda x: -x["lastSeen"]),
                    "events": list(reversed(self.audit_log[-100:])), "banned": [{"ip": ip, "until": u * 1000} for ip, u in self.bans.items() if u > time.time()],
                    "failedLogins24h": sum(1 for e in self.audit_log if e["event"] == "login_failed"), "limits": {"lockFails": LOCK_FAILS, "lockMinutes": LOCK_FOR // 60, "reauthMinutes": REAUTH_MINUTES, "sessionDays": SESSION_DAYS, "minPassword": MIN_PASSWORD}}

        @hc("security:changePassword")
        def change_password(ctx, current=None, nxt=None):
            u = self.web["users"][ctx["session"]["user"]]
            if not _check(str(current or ""), u["hash"]): self._failed(ctx["ip"]); raise ValueError("Current password is wrong")
            if not nxt or len(nxt) < MIN_PASSWORD: raise ValueError(f"New password must be at least {MIN_PASSWORD} characters")
            u["hash"] = _hash(nxt)
            for sid in [k for k, s in self.web["sessions"].items() if s["user"] == ctx["session"]["user"] and k != ctx["session"]["id"]]: self.web["sessions"].pop(sid)
            self._save_web(); self.audit("password_changed", ctx["ip"], "", ctx["session"]["user"]); return True

        @hc("security:setOptions")
        def set_options(ctx, opts=None):
            opts = opts or {}
            for k in ("lanOnly", "guestEnabled"):
                if isinstance(opts.get(k), bool): self.web[k] = opts[k]
            if opts.get("idleMinutes") is not None: self.web["idleMinutes"] = max(0, min(10080, int(opts["idleMinutes"] or 0)))
            self._save_web(); self.audit("options_changed", ctx["ip"], json.dumps(opts), ctx["session"]["user"]); return True

        @hc("security:users")
        def users(ctx): return status(ctx)["users"]

        @hc("security:addUser")
        def add_user(ctx, name=None, password=None, role="standard"):
            u = str(name or "").strip().lower()
            if not (2 <= len(u) <= 32) or not u.replace(".", "").replace("_", "").replace("-", "").isalnum(): raise ValueError("Username: 2–32 characters, letters, digits, dot, dash or underscore")
            if u in self.web["users"]: raise ValueError("That username already exists")
            if role not in ("admin", "standard"): raise ValueError("Role must be admin or standard")
            if not password or len(password) < MIN_PASSWORD: raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
            self.web["users"][u] = {"hash": _hash(password), "role": role, "created": int(time.time() * 1000)}; self._save_web(); self.audit("user_added", ctx["ip"], f"{u} ({role})", ctx["session"]["user"]); return True

        @hc("security:setRole")
        def set_role(ctx, name=None, role=None):
            u = str(name or "").lower()
            if u not in self.web["users"]: raise ValueError("No such user")
            if role not in ("admin", "standard"): raise ValueError("Role must be admin or standard")
            if self.web["users"][u]["role"] == "admin" and role != "admin" and sum(1 for x in self.web["users"].values() if x["role"] == "admin") == 1: raise ValueError("That is the last admin")
            self.web["users"][u]["role"] = role
            for s in self.web["sessions"].values():
                if s["user"] == u: s["role"] = role
            self._save_web(); self.audit("role_changed", ctx["ip"], f"{u} → {role}", ctx["session"]["user"]); return True

        @hc("security:resetPassword")
        def reset_password(ctx, name=None, password=None):
            u = str(name or "").lower()
            if u not in self.web["users"]: raise ValueError("No such user")
            if not password or len(password) < MIN_PASSWORD: raise ValueError(f"Password must be at least {MIN_PASSWORD} characters")
            self.web["users"][u]["hash"] = _hash(password)
            for sid in [k for k, s in self.web["sessions"].items() if s["user"] == u]: self.web["sessions"].pop(sid)
            self._save_web(); self.audit("password_reset", ctx["ip"], u, ctx["session"]["user"]); return True

        @hc("security:deleteUser")
        def delete_user(ctx, name=None):
            u = str(name or "").lower()
            if u not in self.web["users"]: raise ValueError("No such user")
            if self.web["users"][u]["role"] == "admin" and sum(1 for x in self.web["users"].values() if x["role"] == "admin") == 1: raise ValueError("That is the last admin")
            self.web["users"].pop(u)
            for sid in [k for k, s in self.web["sessions"].items() if s["user"] == u]: self.web["sessions"].pop(sid)
            self._save_web(); self.audit("user_deleted", ctx["ip"], u, ctx["session"]["user"]); return True

        @hc("security:revoke")
        def revoke(ctx, short=None):
            for sid in list(self.web["sessions"]):
                if sid[:8] == short and sid != ctx["session"]["id"]: self.web["sessions"].pop(sid); self._save_web(); self.audit("session_revoked", ctx["ip"], short, ctx["session"]["user"]); return True
            return False

        @hc("security:revokeOthers")
        def revoke_others(ctx):
            n = 0
            for sid in list(self.web["sessions"]):
                if sid != ctx["session"]["id"]: self.web["sessions"].pop(sid); n += 1
            self._save_web(); self.audit("sessions_revoked", ctx["ip"], f"{n} other session(s)", ctx["session"]["user"]); return n

        for ch in ("security:totpSetup", "security:totpEnable", "security:totpDisable", "security:tlsEnable"):
            self.handlers[ch] = (lambda *_a, **_k: (_ for _ in ()).throw(ValueError("Not available in the Python adapter; put Caddy in front for HTTPS")))

        @hc("prefs:get")
        def prefs_get(ctx):
            u = self.web["users"].get(ctx["session"]["user"]) if ctx["session"] else next((x for x in self.web["users"].values() if x["role"] == "admin"), None)
            return (u or {}).get("prefs", {})

        @hc("prefs:set")
        def prefs_set(ctx, patch=None):
            if not ctx["session"]: raise ValueError("Sign in to save preferences")
            u = self.web["users"][ctx["session"]["user"]]; p = {**u.get("prefs", {}), **(patch or {})}
            u["prefs"] = {k: v for k, v in p.items() if v is not None}; self._save_web(); return u["prefs"]

        @hc("status:info")
        def status_info(ctx):
            if not self.web.get("statusKey"): self.web["statusKey"] = secrets.token_urlsafe(18); self._save_web(); self.audit("status_key", ctx["ip"], "created", ctx["session"]["user"] if ctx["session"] else None)
            return {"available": True, "url": f"{ctx['proto']}://{ctx['host']}/api/status?key={self.web['statusKey']}"}

        @hc("status:rotate")
        def status_rotate(ctx):
            self.web["statusKey"] = secrets.token_urlsafe(18); self._save_web(); self.audit("status_key", ctx["ip"], "rotated", ctx["session"]["user"]); return status_info(ctx)

        for ch, val in (("dialog:pickFolder", None), ("dialog:pickFile", None), ("shell:open", False), ("shell:openExternal", False), ("shell:showItem", False), ("update:install", {"ok": False}), ("update:status", {"state": "idle"})):
            self.handlers[ch] = (lambda v: (lambda *_a: v))(val)

        @h("sys:stats")
        def sys_stats():
            total, used, free = shutil.disk_usage(self.data)
            load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
            mem = {"total": 0, "used": 0, "available": 0, "pct": 0, "swap": None, "process": 0}
            try:
                info = {l.split(":")[0]: int(l.split()[1]) * 1024 for l in Path("/proc/meminfo").read_text().splitlines() if l.startswith(("MemTotal", "MemAvailable"))}
                mem = {"total": info["MemTotal"], "available": info["MemAvailable"], "used": info["MemTotal"] - info["MemAvailable"], "pct": round(100 * (info["MemTotal"] - info["MemAvailable"]) / info["MemTotal"]), "swap": None, "process": 0}
            except (OSError, KeyError): pass
            disk = {"label": "Data folder", "path": str(self.data), "ok": True, "total": total, "free": free, "used": used, "pct": round(100 * used / total) if total else 0}
            s = {"ts": int(time.time() * 1000), "host": {"hostname": socket.gethostname(), "platform": os.name, "uptimeS": (time.time() - os.stat("/proc/1").st_ctime) if os.path.exists("/proc/1") else 0, "isPi": False, "isLinux": os.name == "posix"},
                 "cpu": {"pct": None, "perCore": None, "cores": os.cpu_count() or 1, "model": None, "load": [round(x, 2) for x in load]}, "memory": mem, "disks": [disk], "network": {"interfaces": [], "rate": None}, "pi": None,
                 "service": {"pid": os.getpid(), "node": None, "uptimeS": 0, "rss": 0, "busy": False, "dbBytes": None}, "history": [], "sampleMs": 5000}
            level, reasons = "ok", []
            if disk["pct"] >= 97: level, reasons = "bad", [f"data folder {disk['pct']}% full"]
            elif disk["pct"] >= 90: level, reasons = "warn", [f"data folder {disk['pct']}% full"]
            s["health"] = {"level": level, "reasons": reasons}
            return s

        @h("db:stats")
        def db_stats(): return {"file": None, "size": 0, "version": None}

        @h("log:tail")
        def log_tail(n=300):
            p = self.data / f"{self.slug}.log"
            return p.read_text("utf-8").rstrip().splitlines()[-min(int(n or 300), 3000):] if p.exists() else []

        @h("notify:test")
        def notify_test():
            url = self.settings.get("notify", {}).get("webhookUrl")
            if not url: return {"webhook": None, "email": None}
            try:
                req = urllib.request.Request(url, data=json.dumps({"app": self.meta.get("name"), "event": "test", "title": "Test notification", "message": "If you can read this, notifications work.", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}).encode(), headers={"content-type": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as r: return {"webhook": {"ok": 200 <= r.status < 300, "status": r.status}, "email": None}
            except Exception as e:  # noqa: BLE001
                return {"webhook": {"ok": False, "error": str(e)}, "email": None}

    # ---- FastAPI wiring --------------------------------------------------------------------------
    def mount(self, app: FastAPI) -> None:
        bk = self

        def json_resp(status: int, body: dict) -> JSONResponse:
            r = JSONResponse(body, status_code=status)
            r.headers["cache-control"] = "no-store"
            return r

        @app.middleware("http")
        async def _headers(request: Request, call_next):
            ip = bk._client_ip(request)
            if bk.web["lanOnly"] and not _private(ip):
                bk.audit("refused_non_lan", ip, request.url.path); return JSONResponse({"ok": False, "error": "LAN only"}, status_code=403)
            resp = await call_next(request)
            for k, v in {"content-security-policy": CSP, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin"}.items(): resp.headers[k] = v
            return resp

        @app.get("/api/status")
        async def api_status(request: Request, key: str = ""):
            if not bk.web.get("statusKey") or not hmac.compare_digest(key, bk.web["statusKey"]): bk.audit("status_refused", bk._client_ip(request), "bad key"); return json_resp(401, {"ok": False, "error": "bad key"})
            fn = bk.handlers.get(bk.status_channel)
            return json_resp(200, fn() if fn else {"ok": True, "app": bk.meta.get("name")})

        @app.post("/api/login")
        async def api_login(request: Request):
            body = await request.json()
            r = bk._login(bk._client_ip(request), request.headers.get("user-agent", ""), body if isinstance(body, dict) else {})
            if r["ok"]:
                resp = json_resp(200, {"ok": True, "username": r["username"], "role": r["role"]})
                resp.set_cookie(bk.cookie, r["id"], max_age=SESSION_DAYS * 86400, httponly=True, samesite="strict", path="/"); return resp
            code = {"locked": 429, "nopassword": 503}.get(r["reason"], 401)
            return json_resp(code, {"ok": False, "reason": r["reason"], "error": {"locked": "Too many failed attempts; this address is locked for 15 minutes", "nopassword": "No account exists yet.", "password": "Wrong username or password"}.get(r["reason"], "Sign-in failed")})

        @app.get("/api/events")
        async def api_events(request: Request):
            if not bk._role(request): return json_resp(401, {"ok": False, "reason": "login", "error": "sign in required"})
            q: asyncio.Queue = asyncio.Queue(maxsize=200); bk.queues.add(q)

            async def gen():
                yield ": connected\n\n"
                try:
                    while True:
                        try: yield f"data: {await asyncio.wait_for(q.get(), 25)}\n\n"
                        except asyncio.TimeoutError: yield ": ping\n\n"
                finally: bk.queues.discard(q)
            return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-store", "x-accel-buffering": "no"})

        @app.post("/api/{channel}")
        async def api_call(channel: str, request: Request):
            ip = bk._client_ip(request)
            origin = request.headers.get("origin")
            if origin and origin.split("//", 1)[-1] != request.headers.get("host"): bk.audit("cross_origin_refused", ip, origin); return json_resp(403, {"ok": False, "error": "cross-origin request refused"})
            session = bk._session_of(request); role = session["role"] if session else ("guest" if bk.web["guestEnabled"] else None)
            if channel == "logout":
                resp = json_resp(200, {"ok": True})
                if session: bk.web["sessions"].pop(session["id"], None); bk._save_web(); bk.audit("logout", ip, "", session["user"]); resp.delete_cookie(bk.cookie, path="/")
                return resp
            if not role: return json_resp(401, {"ok": False, "reason": "login", "error": "sign in required"})
            if channel == "reauth":
                body = await request.json(); u = bk.web["users"][session["user"]]
                if bk._banned(ip) or not _check(str(body.get("password", "")), u["hash"]): bk._failed(ip); bk.audit("reauth_failed", ip, "", session["user"]); return json_resp(401, {"ok": False, "reason": "reauth_bad", "error": "Wrong password"})
                bk.web["sessions"][session["id"]]["reauthAt"] = time.time() * 1000; bk._save_web(); bk.audit("reauth", ip, "", session["user"]); return json_resp(200, {"ok": True})
            fn = bk.handlers.get(channel)
            if not fn: return json_resp(404, {"ok": False, "error": f"unknown channel {channel}"})
            allowed = role == "admin" or (channel in bk.STANDARD if role == "standard" else channel in bk.GUEST)
            if not allowed:
                if not session: return json_resp(401, {"ok": False, "reason": "login", "error": "sign in required"})
                bk.audit("forbidden", ip, channel, session["user"]); return json_resp(403, {"ok": False, "reason": "forbidden", "error": "Your account is not allowed to do that"})
            args = await request.json()
            if not isinstance(args, list): return json_resp(400, {"ok": False, "error": "arguments must be an array"})
            if channel in bk.SENSITIVE:
                if not session or time.time() * 1000 - session.get("reauthAt", 0) > REAUTH_MINUTES * 60000: return json_resp(401, {"ok": False, "reason": "reauth", "error": "Please re-enter your password for this action"})
                bk.audit("sensitive_action", ip, channel, session["user"])
            proxied = bk._proxied(request)
            ctx = {"session": session, "ip": ip, "role": role, "proxy": proxied, "proxyHttps": proxied and bk._proto(request) == "https", "proto": bk._proto(request), "host": request.headers.get("host", "")}
            try:
                result = fn(ctx, *args) if channel in bk.ctx_handlers else fn(*args)
                if asyncio.iscoroutine(result): result = await result
                return json_resp(200, {"ok": True, "result": result})
            except ValueError as e:
                return json_resp(500, {"ok": False, "error": str(e)})
            except Exception as e:  # noqa: BLE001
                bk.log(f"{channel}: {e}"); return json_resp(500, {"ok": False, "error": str(e)})

        @app.get("/kit/renderer/{name:path}")
        async def kit_static(name: str):
            p = (bk.kit / name).resolve()
            if not str(p).startswith(str(bk.kit.resolve())) or not p.is_file(): return json_resp(404, {"ok": False})
            return FileResponse(p, headers={"cache-control": "no-cache"})

        @app.get("/{name:path}")
        async def app_static(name: str):
            p = (bk.renderer / (name or "index.html")).resolve()
            if not str(p).startswith(str(bk.renderer.resolve())) or not p.is_file(): return json_resp(404, {"ok": False})
            return FileResponse(p, headers={"cache-control": "no-cache"})

    def _role(self, request: Request) -> str | None:
        s = self._session_of(request)
        return s["role"] if s else ("guest" if self.web["guestEnabled"] else None)
