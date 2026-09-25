"""Alert rules and alert state.

`conditions()` says what is wrong with a Pi right now. `Alerts.update()` turns
that into alerts that are *raised* only after a condition has lasted `sustain`
seconds, so a 10-second compile spike doesn't page anyone. Each raise and each
clear becomes an event. Every notifier in NOTIFIERS also gets it; that is where
ntfy, Home Assistant and email plug in.
"""

# Callables taking (node_name, alert_dict). Empty until notification channels land.
NOTIFIERS = []

# Conditions that alert at once instead of waiting for `sustain`.
IMMEDIATE = {"offline", "undervolt", "throttled"}


def conditions(m, info, s):
    """Return {key: (level, text)} for a report's metrics under settings s."""
    out = {}
    t = m.get("temp")
    if t is not None and t >= s["temp_crit"]:
        out["temp"] = ("crit", f"hot: {t:.0f} °C")
    elif t is not None and t >= s["temp_warn"]:
        out["temp"] = ("warn", f"warm: {t:.0f} °C")
    th = m.get("throttled")
    if th:
        if th & 0x1:
            out["undervolt"] = ("crit", "under-voltage now (check the power supply)")
        if th & 0x6:
            out["throttled"] = ("crit", "CPU throttled now")
        if not th & 0xF and th & 0xF0000:
            out["throttle_past"] = ("warn", "throttled or under-voltage since boot")
    mem = m.get("mem") or {}
    if mem.get("total"):
        used = 100 * (1 - mem["avail"] / mem["total"])
        if used >= s["mem_crit"]:
            out["mem"] = ("crit", f"memory {used:.0f}% used")
        elif used >= s["mem_warn"]:
            out["mem"] = ("warn", f"memory {used:.0f}% used")
    if mem.get("swap_total"):
        sw = 100 * (mem["swap_total"] - mem["swap_free"]) / mem["swap_total"]
        if sw >= s["swap_warn"]:
            out["swap"] = ("warn", f"swap {sw:.0f}% used")
    for d in m.get("disks", []):
        use = 100 * d["used"] / d["total"]
        if use >= s["disk_crit"]:
            out["disk:" + d["mount"]] = ("crit", f"{d['mount']} {use:.0f}% full")
        elif use >= s["disk_warn"]:
            out["disk:" + d["mount"]] = ("warn", f"{d['mount']} {use:.0f}% full")
    cores = (info or {}).get("cores") or 1
    if m.get("load") and m["load"][1] > cores * s["load_warn"]:
        out["load"] = ("warn", f"load {m['load'][1]:.1f} on {cores} cores")
    return out


class Alerts:
    def __init__(self, store):
        self.store = store
        self.state = {}  # node -> {key: {"level", "text", "since", "raised"}}

    def active(self, nid):
        return [[a["level"], a["text"]] for a in self.state.get(nid, {}).values() if a["raised"]]

    def update(self, nid, name, found, now, only=None):
        """Apply the current conditions for one Pi. `only` limits which keys this
        call owns: the offline check passes {"offline"} so it doesn't clear the rest."""
        s = self.store.settings
        cur = self.state.setdefault(nid, {})
        for key in list(cur):
            if (only is None or key in only) and key not in found:
                a = cur.pop(key)
                if a["raised"]:
                    self._emit(nid, name, "ok", f"cleared: {a['text']}")
        for key, (level, text) in found.items():
            a = cur.get(key)
            if not a:
                a = cur[key] = {"level": level, "text": text, "since": now, "raised": False}
            escalated = a["raised"] and level == "crit" and a["level"] == "warn"
            a["level"], a["text"] = level, text
            if escalated or (not a["raised"] and (key in IMMEDIATE or now - a["since"] >= s["sustain"])):
                a["raised"] = True
                self._emit(nid, name, level, text)

    def forget(self, nid):
        self.state.pop(nid, None)

    def _emit(self, nid, name, level, text):
        self.store.add_event(nid, level, "alert", text)
        for notify in NOTIFIERS:
            try:
                notify(name, {"level": level, "text": text})
            except Exception as e:  # a broken channel must not take the hub down
                self.store.add_event(nid, "error", "notify", f"notification failed: {e}")
