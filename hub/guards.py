"""Guard rules: automatic limits for services that hog a Pi.

A rule reads like this: "when a service matching `match` stays above `above`
(CPU as % of one core, or memory in MB) for `minutes`, cap it at `cap`".
Firing queues an ordinary `limit` action, keeps whatever other limits the
service already has, and logs an event. A service that already has a cap on
that metric is left alone, so a rule fires once rather than fighting you.
"""
import fnmatch
import re
import secrets

# Never auto-limit these: they are how you get back in, or how PiPulse itself works.
PROTECTED = {"pipulse-client.service", "pipulse-hub.service", "ssh.service", "sshd.service", "dbus.service",
             "systemd-journald.service", "systemd-logind.service", "systemd-udevd.service", "init.scope"}
MATCH_RE = re.compile(r"^[A-Za-z0-9@._:*?\[\]-]{1,100}$")


def validate(rules):
    out = []
    for r in rules:
        rule = {
            "id": str(r.get("id") or secrets.token_hex(4))[:16],
            "name": str(r.get("name") or "").strip()[:60] or "guard",
            "match": str(r.get("match") or "*").strip(),
            "metric": r.get("metric"),
            "above": float(r.get("above")),
            "minutes": float(r.get("minutes")),
            "cap": float(r.get("cap")),
            "node": str(r.get("node") or ""),
            "on": bool(r.get("on", True)),
        }
        if not MATCH_RE.match(rule["match"]):
            raise ValueError(f"'{rule['match']}' isn't a service name pattern (letters, digits, . - _ @ and * ?)")
        if rule["metric"] not in ("cpu", "mem"):
            raise ValueError("metric must be cpu or mem")
        if not 0.5 <= rule["minutes"] <= 1440:
            raise ValueError("minutes must be 0.5..1440")
        if rule["metric"] == "cpu" and not (5 <= rule["cap"] <= 6400 and 1 <= rule["above"] <= 6400):
            raise ValueError("CPU values are % of one core, 5..6400")
        if rule["metric"] == "mem" and not (rule["cap"] >= 16 and rule["above"] >= 16):
            raise ValueError("memory values are MB, at least 16")
        out.append(rule)
    return out


class Guards:
    def __init__(self, store):
        self.store = store
        self.since = {}   # (node, rule, unit) -> when it first went over
        self.fired = {}   # (node, rule, unit) -> when we last queued a cap

    def check(self, nid, services, now):
        """Returns [(limit_action, event_text)] for rules that fire on this report."""
        out = []
        for rule in self.store.settings.get("guards", []):
            if not rule["on"] or (rule["node"] and rule["node"] != nid):
                continue
            for s in services:
                unit = s["unit"]
                key = (nid, rule["id"], unit)
                if unit in PROTECTED or not fnmatch.fnmatchcase(unit, rule["match"]):
                    continue
                value = s["cpu"] if rule["metric"] == "cpu" else s["mem"] / 1048576
                capped = s["cpu_quota"] if rule["metric"] == "cpu" else s["mem_max"]
                if value <= rule["above"] or capped:
                    self.since.pop(key, None)
                    continue
                first = self.since.setdefault(key, now)
                if now - first < rule["minutes"] * 60 or now - self.fired.get(key, 0) < 600:
                    continue
                self.fired[key] = now
                self.since.pop(key, None)
                action = {
                    "type": "limit", "unit": unit,
                    "cpu_quota": int(rule["cap"]) if rule["metric"] == "cpu" else s["cpu_quota"],
                    "mem_max_mb": int(rule["cap"]) if rule["metric"] == "mem" else
                    (s["mem_max"] // 1048576 if s["mem_max"] else None),
                    "cpu_weight": s["cpu_weight"] if s["cpu_weight"] not in (None, 100) else None,
                }
                what = f"{rule['cap'] / 100:g} cores" if rule["metric"] == "cpu" else f"{rule['cap']:g} MB"
                seen = f"{value:.0f}% CPU" if rule["metric"] == "cpu" else f"{value:.0f} MB"
                out.append((action, f"guard '{rule['name']}': {unit} used {seen} for {rule['minutes']:g} min, capped at {what}"))
        return out
