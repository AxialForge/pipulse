"""Tests for kit/python/bracket_fastapi.py: static files, the sign-in flow, roles, re-authentication,
secret redaction, the status URL, LAN-only and proxy handling. Needs fastapi and httpx:

    python kit/python/test_bracket_fastapi.py
"""
import sys, tempfile, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from kit.python.bracket_fastapi import Bracket

data = tempfile.mkdtemp()
bk = Bracket(app_json=ROOT / "app/app.json", data_dir=data, renderer_dir=ROOT / "app/renderer", kit_dir=ROOT / "kit/renderer",
             roles={"GUEST": ["data:dashboard"], "STANDARD": ["items:list"], "SENSITIVE": ["items:delete"]}, secrets=["notify.email.pass"], version="0.1.0")

@bk.handler("items:list")
def items_list(): return [{"id": 1}]

@bk.handler("items:delete")
def items_delete(i): return i

@bk.handler("data:dashboard", ctx=True)
def dashboard(ctx): return {"role": ctx["role"]}

@bk.handler("data:status")
def status(): return {"app": "smoke", "ok": True}

app = FastAPI(); bk.mount(app)
LAN = ("192.168.1.50", 40000)
c = TestClient(app, client=LAN)

r = c.get("/"); assert r.status_code == 200 and "<title>Bracket</title>" in r.text, r.text[:200]
r = c.get("/kit/renderer/ui.js"); assert r.status_code == 200 and "UI" in r.text
r = c.get("/kit/renderer/../../app/app.json"); assert r.status_code in (404, 400)
r = c.post("/api/items:list", json=[]); assert r.status_code == 401 and r.json()["reason"] == "login", r.text
r = c.post("/api/login", json={"username": "admin", "password": "x"}); assert r.status_code == 503 and r.json()["reason"] == "nopassword"
bk.set_password("smoke-test-pw")
r = c.post("/api/login", json={"username": "admin", "password": "wrong"}); assert r.status_code == 401
r = c.post("/api/login", json={"username": "admin", "password": "smoke-test-pw"}); assert r.status_code == 200 and r.json()["role"] == "admin", r.text
assert "bracket_session" in c.cookies
r = c.post("/api/app:info", json=[]); assert r.json()["ok"] and r.json()["result"]["name"] == "Bracket", r.text
r = c.post("/api/items:list", json=[]); assert r.json()["result"] == [{"id": 1}]
r = c.post("/api/items:delete", json=[7]); assert r.status_code == 200 and r.json()["result"] == 7, r.text  # fresh login = re-authed
r = c.post("/api/security:status", json=[]); j = r.json()["result"]; assert j["passwordSet"] and j["users"][0]["username"] == "admin" and len(j["checks"]) == 5
r = c.post("/api/settings:set", json=[{"notify": {"email": {"pass": "s3cret"}}}]); assert r.json()["result"]["notify"]["email"]["pass"] == "••••"
r = c.post("/api/settings:set", json=[{"notify": {"email": {"pass": "••••", "host": "h"}}}]); assert bk.settings["notify"]["email"]["pass"] == "s3cret" and bk.settings["notify"]["email"]["host"] == "h"
r = c.post("/api/security:addUser", json=["bob", "password123", "standard"]); assert r.json()["ok"], r.text
r = c.post("/api/status:info", json=[]); url = r.json()["result"]["url"]; assert "/api/status?key=" in url
r = c.get(url); assert r.status_code == 200 and r.json()["app"] == "smoke", r.text
r = c.get("/api/status?key=bad"); assert r.status_code == 401
r = c.post("/api/prefs:set", json=[{"dashboard": {"cards": []}}]); assert r.json()["result"] == {"dashboard": {"cards": []}}
r = c.post("/api/sys:stats", json=[]); assert r.json()["ok"] and r.json()["result"]["disks"][0]["total"] > 0
r = c.post("/api/nope:x", json=[]); assert r.status_code == 404
r = c.post("/api/logout", json=[]); assert r.status_code == 200
r = c.post("/api/items:list", json=[]); assert r.status_code == 401
# standard user: allowed STANDARD, forbidden SENSITIVE
c2 = TestClient(app, client=LAN); r = c2.post("/api/login", json={"username": "bob", "password": "password123"}); assert r.status_code == 200
assert c2.post("/api/items:list", json=[]).status_code == 200
assert c2.post("/api/items:delete", json=[1]).status_code == 403
assert c2.post("/api/security:addUser", json=["x", "password123"]).status_code == 403
# non-LAN address refused
assert TestClient(app, client=("8.8.8.8", 1)).post("/api/security:me", json=[]).status_code == 403, "direct non-LAN socket refused"
assert TestClient(app, client=("127.0.0.1", 1), headers={"x-forwarded-for": "8.8.8.8"}).post("/api/security:me", json=[]).status_code == 403, "proxied non-LAN refused"
assert TestClient(app, client=LAN, headers={"x-forwarded-for": "8.8.8.8"}).post("/api/security:me", json=[]).status_code != 403, "XFF ignored from a non-loopback socket"
assert TestClient(app, client=("127.0.0.1", 1), headers={"x-forwarded-for": "192.168.1.9"}).post("/api/security:me", json=[]).status_code != 403, "proxied LAN allowed"
# guest
bk.web["guestEnabled"] = True; c3 = TestClient(app, client=LAN)
r = c3.post("/api/data:dashboard", json=[]); assert r.json()["result"] == {"role": "guest"}, r.text
assert c3.post("/api/items:list", json=[]).status_code == 401
print("fastapi adapter smoke test passed")
