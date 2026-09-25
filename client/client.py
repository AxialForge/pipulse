#!/usr/bin/env python3
"""PiPulse Client: reports one Raspberry Pi's resources to a PiPulse Hub and applies
the limits the hub asks for.

Standard library only. Every few seconds it reads /proc and the cgroup v2 tree
and sends one JSON report over HTTPS to the hub's client link. The hub's
certificate must match the SHA-256 fingerprint pinned at install time, or
nothing is sent. The reply carries any actions to run: service limits via
`systemctl set-property`, renice, restart, or self-update. The Pi never listens
on a port.

    client.py            run (config in /etc/pipulse/client.json)
    client.py --check    test the connection to the hub and exit
    client.py --once     print one report and exit
"""
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time

try:
    import pwd
except ImportError:  # only the Windows demo imports this file
    pwd = None

VERSION = "dev"  # stamped by the hub / release packaging
CONFIG = os.environ.get("PIPULSE_CONFIG", "/etc/pipulse/client.json")
CG = "/sys/fs/cgroup"
UNIT_RE = re.compile(r"^[A-Za-z0-9@._:\\-]+\.(service|scope|slice)$")
LOCAL_FS = {"ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "vfat", "exfat", "ntfs3", "fuseblk"}


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def run(cmd, timeout=10):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


# ---------------------------------------------------------------- encrypted link

class PinMismatch(Exception):
    pass


class Link:
    """HTTPS to the hub with the hub's certificate pinned by fingerprint.

    There is no certificate authority: the hub's cert is self-signed, so chain
    and hostname checks are off and the pin is the whole trust decision. It's
    checked after the handshake and before a single byte of the request is sent.
    """

    def __init__(self, host, port, token, pin):
        self.host, self.port, self.token = host, int(port), token
        self.pin = pin.replace(":", "").lower()
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE
        self.ctx.minimum_version = ssl.TLSVersion.TLSv1_2

    def request(self, method, path, body=None):
        conn = http.client.HTTPSConnection(self.host, self.port, timeout=10, context=self.ctx)
        try:
            conn.connect()
            got = hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest()
            if not self.pin or got != self.pin:
                raise PinMismatch(f"hub certificate {got[:16]}... does not match the pinned one; refusing to send")
            conn.request(method, path, body=body, headers={
                "Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            r = conn.getresponse()
            data = r.read()
            if r.status != 200:
                raise RuntimeError(f"hub answered {r.status}: {data[:200].decode(errors='replace')}")
            return data
        finally:
            conn.close()


# ---------------------------------------------------------------- static info

def node_id():
    mid = read("/etc/machine-id").strip()
    return mid[:12] if mid else socket.gethostname()


def static_info():
    osr = dict(line.split("=", 1) for line in read("/etc/os-release").splitlines() if "=" in line)
    return {
        "model": read("/proc/device-tree/model").strip("\x00\n ") or "Linux",
        "os": osr.get("PRETTY_NAME", "").strip('"'),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "cores": os.cpu_count() or 1,
        "cgroup2": os.path.exists(CG + "/cgroup.controllers"),
        "systemd": os.path.isdir("/run/systemd/system"),
        "client": VERSION,
    }


# ---------------------------------------------------------------- samplers

class Sampler:
    """Keeps the previous counters so each call returns rates, not totals."""

    def __init__(self):
        self.clk = os.sysconf("SC_CLK_TCK")
        self.page = os.sysconf("SC_PAGE_SIZE")
        self.t = None
        self.cpu = None
        self.net = None
        self.procs = {}
        self.units = {}
        self.throttle = (0, None)
        self.users = {}

    def cpu_times(self):
        out = []
        for line in read("/proc/stat").splitlines():
            if not line.startswith("cpu"):
                break
            v = [int(x) for x in line.split()[1:]]
            out.append((sum(v[:8]), v[3] + (v[4] if len(v) > 4 else 0)))
        return out

    def mem(self):
        m = {}
        for line in read("/proc/meminfo").splitlines():
            k, _, rest = line.partition(":")
            m[k] = int(rest.split()[0]) * 1024 if rest.strip() else 0
        return {"total": m.get("MemTotal", 0), "avail": m.get("MemAvailable", 0),
                "swap_total": m.get("SwapTotal", 0), "swap_free": m.get("SwapFree", 0)}

    def temp(self):
        best = None
        for i in range(4):
            raw = read(f"/sys/class/thermal/thermal_zone{i}/temp").strip()
            if raw.lstrip("-").isdigit():
                t = int(raw) / 1000
                best = t if best is None else max(best, t)
        return best

    def throttled(self):
        # vcgencmd is a subprocess, so only ask every 30 s.
        when, val = self.throttle
        if time.time() - when < 30:
            return val
        val = None
        code, out = run(["vcgencmd", "get_throttled"], timeout=3)
        if code == 0 and "=" in out:
            try:
                val = int(out.split("=", 1)[1], 16)
            except ValueError:
                pass
        self.throttle = (time.time(), val)
        return val

    def disks(self):
        seen, out = set(), []
        for line in read("/proc/mounts").splitlines():
            dev, mnt, fs = line.split()[:3]
            if fs not in LOCAL_FS or dev in seen or mnt.startswith(("/snap", "/run", "/sys", "/proc", "/dev")):
                continue
            seen.add(dev)
            try:
                s = os.statvfs(mnt)
            except OSError:
                continue
            total = s.f_blocks * s.f_frsize
            if total:
                out.append({"mount": mnt, "total": total, "used": total - s.f_bavail * s.f_frsize})
        return out

    def net_bytes(self):
        rx = tx = 0
        for line in read("/proc/net/dev").splitlines()[2:]:
            name, _, rest = line.partition(":")
            if name.strip() == "lo":
                continue
            v = rest.split()
            rx += int(v[0])
            tx += int(v[8])
        return rx, tx

    def user(self, uid):
        if uid not in self.users:
            try:
                self.users[uid] = pwd.getpwuid(uid).pw_name
            except (KeyError, AttributeError):
                self.users[uid] = str(uid)
        return self.users[uid]

    def processes(self, dt):
        cur, rows = {}, []
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            stat = read(f"/proc/{pid}/stat")
            if not stat:
                continue
            r = stat.rfind(")")
            comm = stat[stat.find("(") + 1:r]
            f = stat[r + 2:].split()
            ticks = int(f[11]) + int(f[12])
            cur[pid] = ticks
            prev = self.procs.get(pid)
            cpu = (ticks - prev) / self.clk / dt * 100 if prev is not None and dt else 0.0
            rows.append({"pid": int(pid), "name": comm, "state": f[0], "nice": int(f[16]),
                         "rss": int(f[21]) * self.page, "cpu": round(cpu, 1)})
        self.procs = cur
        top = sorted(rows, key=lambda p: -p["cpu"])[:10]
        top += [p for p in sorted(rows, key=lambda p: -p["rss"])[:10] if p not in top]
        for p in top:
            pid = p["pid"]
            try:
                p["user"] = self.user(os.stat(f"/proc/{pid}").st_uid)
            except OSError:
                p["user"] = "?"
            p["cmd"] = read(f"/proc/{pid}/cmdline").replace("\x00", " ").strip()[:200] or f"[{p['name']}]"
            # Innermost unit in the path; services can nest sub-cgroups (udevd has .../udev).
            parts = read(f"/proc/{pid}/cgroup").strip().split("::", 1)[-1].split("/")
            units = [c for c in parts if UNIT_RE.match(c) and not c.endswith(".slice")]
            p["unit"] = units[-1] if units else None
        return top, len(rows)

    def services(self, dt):
        base = CG + "/system.slice"
        if not os.path.isdir(base):
            return []
        cur, out = {}, []
        for name in os.listdir(base):
            if not name.endswith((".service", ".scope")):
                continue
            d = f"{base}/{name}"
            mem = read(d + "/memory.current").strip()
            if not mem.isdigit() or mem == "0":
                continue
            usage = 0
            for line in read(d + "/cpu.stat").splitlines():
                if line.startswith("usage_usec"):
                    usage = int(line.split()[1])
            cur[name] = usage
            prev = self.units.get(name)
            cpu = (usage - prev) / 1e6 / dt * 100 if prev is not None and dt else 0.0
            quota, period = (read(d + "/cpu.max").split() + ["max", "100000"])[:2]
            mmax = read(d + "/memory.max").strip()
            mhigh = read(d + "/memory.high").strip()
            weight = read(d + "/cpu.weight").strip()
            out.append({
                "unit": name, "cpu": round(max(cpu, 0), 1), "mem": int(mem),
                "tasks": int(read(d + "/pids.current", "0").strip() or 0),
                "cpu_quota": None if quota == "max" else round(int(quota) / int(period) * 100),
                "mem_max": None if mmax in ("", "max") else int(mmax),
                "mem_high": None if mhigh in ("", "max") else int(mhigh),
                "cpu_weight": int(weight) if weight.isdigit() else None,
            })
        self.units = cur
        limited = [s for s in out if s["cpu_quota"] or s["mem_max"] or (s["cpu_weight"] or 100) != 100]
        busy = sorted(out, key=lambda s: (-s["cpu"], -s["mem"]))[:25]
        return busy + [s for s in limited if s not in busy]

    def sample(self):
        now = time.time()
        dt = now - self.t if self.t else 0
        cpu = self.cpu_times()
        pct = []
        if self.cpu:
            for (t1, i1), (t0, i0) in zip(cpu, self.cpu):
                dtot = t1 - t0
                pct.append(round(100 * (1 - (i1 - i0) / dtot), 1) if dtot > 0 else 0.0)
        rx, tx = self.net_bytes()
        net = {"rx": 0, "tx": 0}
        if self.net and dt:
            net = {"rx": max(0, (rx - self.net[0]) / dt), "tx": max(0, (tx - self.net[1]) / dt)}
        procs, nprocs = self.processes(dt)
        services = self.services(dt)
        self.t, self.cpu, self.net = now, cpu, (rx, tx)
        return {
            "metrics": {
                "cpu": pct[0] if pct else None, "cores": pct[1:],
                "load": [float(x) for x in read("/proc/loadavg").split()[:3]],
                "mem": self.mem(), "temp": self.temp(), "throttled": self.throttled(),
                "disks": self.disks(), "net": net,
                "uptime": float(read("/proc/uptime", "0").split()[0]), "nprocs": nprocs,
            },
            "procs": procs,
            "services": services,
        }


# ---------------------------------------------------------------- actions

def _limit(a, cores):
    unit = a.get("unit", "")
    if not UNIT_RE.match(unit):
        return False, f"refusing unit name {unit!r}"
    props = []
    q = a.get("cpu_quota")
    if q is None:
        props.append("CPUQuota=")
    else:
        q = int(q)
        if not 5 <= q <= cores * 100:
            return False, f"CPU cap {q}% out of range 5..{cores * 100}"
        props.append(f"CPUQuota={q}%")
    m = a.get("mem_max_mb")
    if m is None:
        props += ["MemoryMax=", "MemoryHigh="]
    else:
        m = int(m)
        if m < 16:
            return False, "memory cap below 16 MB"
        # MemoryHigh throttles and reclaims before MemoryMax lets the OOM killer in.
        props += [f"MemoryMax={m}M", f"MemoryHigh={int(m * 0.9)}M"]
    w = a.get("cpu_weight")
    if w is None:
        props.append("CPUWeight=")
    else:
        w = int(w)
        if not 1 <= w <= 10000:
            return False, "CPU weight out of range 1..10000"
        props.append(f"CPUWeight={w}")
    cmd = ["systemctl", "set-property"]
    if unit.endswith(".scope"):
        cmd.append("--runtime")  # transient units cannot take persistent drop-ins
    code, out = run(cmd + [unit] + props)
    return code == 0, out or " ".join(props)


def _update(a, link):
    """Replace this file with the hub's client.py, if its hash matches, then restart."""
    new = link.request("GET", "/client.py")
    if hashlib.sha256(new).hexdigest() != a.get("sha256"):
        return False, "downloaded client did not match the expected checksum"
    me = os.path.abspath(__file__)
    tmp = me + ".new"
    with open(tmp, "wb") as f:
        f.write(new)
    os.chmod(tmp, 0o755)
    os.replace(tmp, me)
    return True, "updated; restarting"


def do_action(a, cores, link):
    kind = a.get("type")
    try:
        if kind == "limit":
            return _limit(a, cores)
        if kind == "renice":
            pid, nice = int(a["pid"]), int(a["nice"])
            if not -10 <= nice <= 19:
                return False, "nice out of range -10..19"
            os.setpriority(os.PRIO_PROCESS, pid, nice)
            return True, f"pid {pid} nice {nice}"
        if kind == "restart":
            unit = a.get("unit", "")
            if not UNIT_RE.match(unit) or not unit.endswith(".service"):
                return False, f"refusing unit name {unit!r}"
            code, out = run(["systemctl", "restart", unit], timeout=60)
            return code == 0, out or f"restarted {unit}"
        if kind == "update":
            return _update(a, link)
        return False, f"unknown action {kind!r}"
    except Exception as e:  # an action must never kill the reporting loop
        return False, str(e)


# ---------------------------------------------------------------- main loop

def load_config():
    cfg = {"hub": "", "port": 8751, "token": "", "pin": "", "interval": 5}
    try:
        with open(CONFIG) as f:
            cfg.update(json.load(f))
    except OSError:
        pass
    if not (cfg["hub"] and cfg["token"] and cfg["pin"]):
        sys.exit(f"{CONFIG} needs hub, token and pin. Install the client from the hub's dashboard (+ Add a Pi).")
    return cfg


def main():
    cfg = load_config()
    link = Link(cfg["hub"], cfg["port"], cfg["token"], cfg["pin"])
    info = static_info()
    ident = {"id": node_id(), "hostname": socket.gethostname(), "info": info}
    sampler = Sampler()

    if "--once" in sys.argv:
        sampler.sample()
        time.sleep(1)
        return print(json.dumps(dict(ident, **sampler.sample()), indent=1))
    if "--check" in sys.argv:
        try:
            print("hub reachable, certificate matches the pin, version", json.loads(link.request("GET", "/api/ping"))["version"])
        except Exception as e:
            sys.exit(f"cannot talk to the hub: {e}")
        return

    sampler.sample()  # prime the counters so the first report has real rates
    results, interval, restart = [], cfg["interval"], False
    print(f"PiPulse Client {VERSION} reporting to https://{cfg['hub']}:{cfg['port']} every {interval}s", flush=True)
    while True:
        time.sleep(interval)
        report = dict(ident, ts=time.time(), results=results, **sampler.sample())
        try:
            reply = json.loads(link.request("POST", "/api/report", json.dumps(report).encode()))
        except PinMismatch as e:
            print(f"SECURITY: {e}", flush=True)
            continue
        except Exception as e:  # hub down or unreachable: keep sampling, keep results
            print(f"report failed: {e}", flush=True)
            continue
        if restart:
            sys.exit(0)  # the update result has been delivered; systemd starts the new version
        results = []
        interval = max(2, int(reply.get("interval", interval)))
        for a in reply.get("actions", []):
            ok, msg = do_action(a, info["cores"], link)
            print(f"action {a.get('type')} {'ok' if ok else 'FAILED'}: {msg}", flush=True)
            results.append({"id": a.get("id"), "ok": ok, "msg": msg[:500]})
            restart = restart or (a.get("type") == "update" and ok)


if __name__ == "__main__":
    main()
