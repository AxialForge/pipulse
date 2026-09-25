#!/usr/bin/env python3
"""Fake Pis for trying the dashboard without hardware.

    python tools/demo.py [hub_host] [count]

Each fake Pi reports over the real encrypted client link (client.Link, pinned
to the hub's certificate) and obeys limit/renice/restart/update actions against
its made-up services, so the whole loop can be clicked through. It reads the
token and certificate from hub/data, so run it next to a dev hub.
"""
import json
import math
import random
import sys
import threading
import time
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(REPO / "client"), str(REPO / "hub")]
import client  # noqa: E402
import tls  # noqa: E402

HUB = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 3
DATA = REPO / "hub" / "data"
TOKEN = json.loads(sqlite3.connect(DATA / "pipulse.db").execute("SELECT value FROM settings WHERE key = '_token'").fetchone()[0])
PIN = tls.fingerprint(DATA / "hub-cert.pem")
VERSION = (REPO / "VERSION").read_text().strip()
MODELS = [("Raspberry Pi 4 Model B Rev 1.5", 4, 4), ("Raspberry Pi 5 Model B Rev 1.0", 4, 8), ("Raspberry Pi Zero 2 W Rev 1.0", 4, 0.5)]
SERVICES = ["medialedger.service", "pihole-FTL.service", "docker.service", "homebridge.service", "mosquitto.service",
            "ssh.service", "cron.service", "systemd-journald.service", "plexmediaserver.service"]


def fake(i):
    model, cores, gb = MODELS[i % len(MODELS)]
    total = int(gb * 1024 ** 3)
    units = {u: {"base": random.uniform(0.2, 40 if j < 3 else 3), "mem": random.randint(8, 400) * 2 ** 20,
                 "cpu_quota": None, "mem_max": None, "cpu_weight": 100}
             for j, u in enumerate(random.sample(SERVICES, 6))}
    hog = list(units)[0]
    results, t0 = [], time.time()
    version = "0.2.0" if i == 1 else VERSION  # one outdated client, to exercise Update
    link = client.Link(HUB, 8751, TOKEN, PIN)
    while True:
        t = time.time() - t0
        svcs = []
        for u, s in units.items():
            want = s["base"] * (1 + 0.5 * math.sin(t / 20 + len(u))) + (120 if u == hog and int(t / 60) % 3 == 1 else 0)
            cpu = min(want, s["cpu_quota"] or 1e9) * random.uniform(0.9, 1.1)
            mem = min(s["mem"] * random.uniform(0.95, 1.05), s["mem_max"] or 1e18)
            svcs.append({"unit": u, "cpu": round(cpu, 1), "mem": int(mem), "tasks": random.randint(1, 30),
                         "cpu_quota": s["cpu_quota"], "mem_max": s["mem_max"],
                         "mem_high": int(s["mem_max"] * 0.9) if s["mem_max"] else None, "cpu_weight": s["cpu_weight"]})
        used = min(total * 0.97, sum(s["mem"] for s in svcs) + total * 0.12)
        cpu = min(100, sum(s["cpu"] for s in svcs) / cores + random.uniform(1, 4))
        procs = [{"pid": 400 + k, "name": s["unit"].split(".")[0][:15], "state": "S", "nice": 0, "rss": s["mem"],
                  "cpu": s["cpu"], "user": "root", "cmd": "/usr/bin/" + s["unit"].split(".")[0], "unit": s["unit"]}
                 for k, s in enumerate(svcs)]
        report = {
            "id": f"demo{i:02d}", "hostname": f"demo-pi-{i + 1}", "ts": time.time(), "results": results,
            "info": {"model": model, "os": "Debian GNU/Linux 13 (trixie)", "kernel": "6.12.47+rpt-rpi-v8",
                     "arch": "aarch64", "cores": cores, "cgroup2": True, "systemd": True, "client": version},
            "metrics": {
                "cpu": round(cpu, 1), "cores": [round(min(100, cpu * random.uniform(0.6, 1.4)), 1) for _ in range(cores)],
                "load": [round(cpu / 100 * cores * f, 2) for f in (1.1, 1, 0.9)],
                "mem": {"total": total, "avail": int(total - used), "swap_total": 512 * 2 ** 20, "swap_free": 480 * 2 ** 20},
                "temp": round(42 + cpu * 0.35 + random.uniform(-1, 1), 1),
                "throttled": 0x50000 if i == 2 else 0,
                "disks": [{"mount": "/", "total": 64 * 10 ** 9, "used": int([20, 40, 58][i % 3] * 10 ** 9)},
                          {"mount": "/boot/firmware", "total": 536 * 10 ** 6, "used": 70 * 10 ** 6}],
                "net": {"rx": random.uniform(1e3, 3e6), "tx": random.uniform(1e3, 5e5)},
                "uptime": 86400 * (i + 1) + t, "nprocs": 140 + i * 20,
            },
            "procs": procs, "services": svcs,
        }
        results = []
        try:
            reply = json.loads(link.request("POST", "/api/report", json.dumps(report).encode()))
        except Exception as e:
            print(f"demo-pi-{i + 1}: {e}")
            time.sleep(5)
            continue
        for a in reply.get("actions", []):
            s = units.get(a.get("unit"))
            if a["type"] == "limit" and s:
                s["cpu_quota"] = a["cpu_quota"]
                s["mem_max"] = a["mem_max_mb"] * 2 ** 20 if a["mem_max_mb"] else None
                s["cpu_weight"] = a["cpu_weight"] or 100
            if a["type"] == "update":
                version = VERSION
            results.append({"id": a["id"], "ok": a["type"] in ("renice", "update") or bool(s), "msg": "demo"})
        time.sleep(reply.get("interval", 5))


def backfill(days=30):
    """Invent history for the demo Pis: 7 days of 1-minute samples, older days as hourly rows."""
    db = sqlite3.connect(DATA / "pipulse.db")
    now = int(time.time())
    for i in range(COUNT):
        nid = f"demo{i:02d}"
        rows, hours = [], []
        for t in range(now - 7 * 86400, now - 120, 60):
            day = math.sin((t % 86400) / 86400 * 2 * math.pi)
            cpu = max(1, 20 + 15 * day + random.uniform(-5, 5) + (60 if random.random() < 0.01 else 0))
            rows.append((nid, t, cpu, 45 + 10 * day + i * 8, 45 + cpu * 0.3, cpu / 25, 30 + i * 20 + (now - t) / -86400,
                         random.uniform(1e4, 2e6), random.uniform(1e3, 3e5)))
        for h in range((now - days * 86400) // 3600 * 3600, now - 7 * 86400, 3600):
            day = math.sin((h % 86400) / 86400 * 2 * math.pi)
            cpu = 20 + 15 * day + random.uniform(-3, 3)
            hours.append((nid, h, cpu, cpu + 30, 45 + 10 * day, 60 + 10 * day, 45 + cpu * 0.3, 55 + cpu * 0.3,
                          cpu / 25, 25 + i * 20, 5e5, 1e5, 60))
        db.executemany("INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        db.executemany("INSERT OR REPLACE INTO hourly VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", hours)
    db.commit()
    print(f"backfilled {days} days for {COUNT} demo Pis; restart the hub so it rolls the new samples up")


if "--backfill" in sys.argv:
    sys.argv.remove("--backfill")
    COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    backfill()
    sys.exit()

for n in range(COUNT):
    threading.Thread(target=fake, args=(n,), daemon=True).start()
print(f"{COUNT} fake Pis reporting to {HUB}; Ctrl+C to stop")
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
