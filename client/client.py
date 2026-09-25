#!/usr/bin/env python3
"""PiPulse Client: reports one Raspberry Pi's resources to a PiPulse Hub and applies
the limits the hub asks for.

Standard library only. Every few seconds it reads /proc and the cgroup v2 tree
and sends one JSON report over HTTPS to the hub's client link. The hub's
certificate must match the SHA-256 fingerprint pinned at install time, or
nothing is sent. The reply carries any actions to run, and which services to
watch. Actions are service limits via `systemctl set-property`, renice,
restart, reboot/shutdown, OS updates, or self-update. The Pi never listens on a port.

    client.py            run (config in /etc/pipulse/client.json)
    client.py --menu     the on-Pi menu (installed as `sudo pipulse`)
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
import threading
import time

try:
    import pwd
except ImportError:  # only the Windows demo imports this file
    pwd = None

VERSION = "dev"  # stamped by the hub / release packaging
CONFIG = os.environ.get("PIPULSE_CONFIG", "/etc/pipulse/client.json")
CG = "/sys/fs/cgroup"
UNIT_RE = re.compile(r"^[A-Za-z0-9@._:\\-]+\.(service|scope|slice)$")
DISK_RE = re.compile(r"^(mmcblk\d+|sd[a-z]+|nvme\d+n\d+|vd[a-z]+)$")
STATUS = "/run/pipulse-client.json"   # tmpfs: what the menu shows, no SD writes
LOG_UNIT = "pipulse-client"
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
        "boot_id": read("/proc/sys/kernel/random/boot_id").strip(),  # changes on every boot
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
        self.io = None

    def disk_io(self, dt):
        """Read/write rate to the physical disks (SD card, USB SSD, NVMe), not partitions."""
        rd = wr = 0
        for line in read("/proc/diskstats").splitlines():
            f = line.split()
            if len(f) > 9 and DISK_RE.match(f[2]):
                rd += int(f[5]) * 512
                wr += int(f[9]) * 512
        prev, self.io = self.io, (rd, wr)
        if not prev or not dt:
            return {"read": 0, "write": 0, "written_boot": wr}
        return {"read": max(0, (rd - prev[0]) / dt), "write": max(0, (wr - prev[1]) / dt), "written_boot": wr}

    @staticmethod
    def root_ro():
        for line in read("/proc/mounts").splitlines():
            f = line.split()
            if len(f) > 3 and f[1] == "/":
                return "ro" in f[3].split(",")
        return False

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
                "disks": self.disks(), "net": net, "disk_io": self.disk_io(dt), "root_ro": self.root_ro(),
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


def outside(*cmd, timeout=600, **props):
    """Run a command in its own transient systemd unit and wait for its output.
    This service is boxed in at 10% CPU / 48 MB and everything it starts inherits
    that box. apt inside it would be starved or OOM-killed, and could take this
    process down with it."""
    args = ["systemd-run", "--quiet", "--collect", "--wait", "--pipe"]
    for k, v in props.items():
        args += ["-p", f"{k}={v}"]
    return run(args + list(cmd), timeout=timeout)


def has_cmd(cmd):
    return any(os.access(os.path.join(p, cmd), os.X_OK) for p in os.environ.get("PATH", "/usr/bin").split(":"))


class Apt:
    """Waiting OS updates, checked every 6 h and again after an upgrade finishes."""
    JOB = "pipulse-apt-upgrade"

    def __init__(self):
        self.state = {"upgradable": None, "security": None, "checked": 0,
                      "reboot_required": False, "job": None}
        self.checking = False
        self.prev_job = None

    def due(self):
        if not self.checking and time.time() - self.state["checked"] > 6 * 3600 and has_cmd("apt-get"):
            self.check()

    def check(self):
        if self.checking:
            return
        self.checking = True

        def work():
            try:
                code, out = outside("apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade",
                                    MemoryMax="300M", CPUQuota="50%", Nice="10")
                inst = [line for line in out.splitlines() if line.startswith("Inst ")]
                if code == 0:
                    self.state.update(upgradable=len(inst), security=sum("security" in line.lower() for line in inst))
                self.state["checked"] = time.time()
            finally:
                self.checking = False
        threading.Thread(target=work, daemon=True).start()

    def job(self):
        _, out = run(["systemctl", "show", self.JOB, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState"])
        p = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        if p.get("LoadState") != "loaded":
            return None
        if p.get("ActiveState") == "failed":
            return "failed"
        return "running" if p.get("SubState") == "running" else "done"

    def upgrade(self):
        if self.job() == "running":
            return False, "an upgrade is already running"
        run(["systemctl", "stop", self.JOB])
        run(["systemctl", "reset-failed", self.JOB])
        code, out = run(["systemd-run", "--quiet", "--unit", self.JOB, "--remain-after-exit",
                         "-p", "Nice=10", "-p", "IOSchedulingClass=idle", "--setenv=DEBIAN_FRONTEND=noninteractive",
                         "sh", "-c", "apt-get update -q && apt-get -y -q -o Dpkg::Options::=--force-confdef "
                                     "-o Dpkg::Options::=--force-confold upgrade"])
        return code == 0, out or "upgrade started; its progress shows on the dashboard"

    def report(self):
        job = self.job()
        if self.prev_job == "running" and job in ("done", "failed"):
            self.state["checked"] = 0
            self.check()  # the counts just changed
        self.prev_job = job
        self.state["job"] = job
        self.state["reboot_required"] = os.path.exists("/var/run/reboot-required")
        return dict(self.state)


class Watch:
    """systemd state of the services the hub asked us to watch (checked every 15 s)."""

    def __init__(self):
        self.units, self.states, self.at = [], {}, 0

    def report(self, units):
        units = [u for u in units if UNIT_RE.match(u)][:50]
        if units != self.units or time.time() - self.at > 15:
            self.units, self.at = units, time.time()
            if units:
                _, out = run(["systemctl", "is-active", "--"] + units)
                lines = out.splitlines()
                self.states = {u: (lines[i] if i < len(lines) else "unknown") for i, u in enumerate(units)}
            else:
                self.states = {}
        return self.states


def do_action(a, cores, link, apt):
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
        if kind in ("reboot", "shutdown"):
            # Delayed, so this report's result reaches the hub before the network goes.
            verb = "reboot" if kind == "reboot" else "poweroff"
            code, out = run(["systemd-run", "--quiet", "--on-active=5", "systemctl", verb], timeout=15)
            return code == 0, out or f"{kind} in 5 seconds"
        if kind == "apt_upgrade":
            return apt.upgrade()
        if kind == "apt_check":
            apt.check()
            return True, "checking for OS updates"
        return False, f"unknown action {kind!r}"
    except Exception as e:  # an action must never kill the reporting loop
        return False, str(e)


# ---------------------------------------------------------------- config & pairing

def load_config(required=True):
    cfg = {"hub": "", "port": 8751, "token": "", "pin": "", "interval": 5}
    try:
        with open(CONFIG) as f:
            cfg.update(json.load(f))
    except OSError:
        pass
    if required and not (cfg["hub"] and cfg["token"] and cfg["pin"]):
        sys.exit(f"{CONFIG} needs hub, token and pin. Pair with `sudo pipulse`, or install from the hub's + Add a Pi.")
    return cfg


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    tmp = CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, CONFIG)


def peer_fingerprint(host, port):
    """The certificate fingerprint a host presents. Only used while pairing, where
    you compare it by eye with the one on the hub's Settings page."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
    conn = http.client.HTTPSConnection(host, int(port), timeout=10, context=ctx)
    try:
        conn.connect()
        return hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest()
    finally:
        conn.close()


def fmt_fp(fp):
    fp = fp.replace(":", "")
    return ":".join(fp[i:i + 2] for i in range(0, len(fp), 2)).upper()


def write_status(**kw):
    try:
        old = json.loads(read(STATUS) or "{}")
        with open(STATUS + ".tmp", "w") as f:
            json.dump(old | kw, f)
        os.replace(STATUS + ".tmp", STATUS)
    except (OSError, ValueError):
        pass


# ---------------------------------------------------------------- the report loop

def serve():
    cfg = load_config()
    link = Link(cfg["hub"], cfg["port"], cfg["token"], cfg["pin"])
    info = static_info()
    ident = {"id": node_id(), "hostname": socket.gethostname(), "info": info}
    sampler, apt, watch = Sampler(), Apt(), Watch()
    sampler.sample()  # prime the counters so the first report has real rates
    results, interval, restart, rtt, units = [], cfg["interval"], False, None, []
    write_status(version=VERSION, hub=cfg["hub"], port=cfg["port"], started=time.time())
    print(f"PiPulse Client {VERSION} reporting to https://{cfg['hub']}:{cfg['port']} every {interval}s", flush=True)
    while True:
        time.sleep(interval)
        apt.due()
        s = sampler.sample()
        s["metrics"]["rtt"] = rtt
        report = dict(ident, ts=time.time(), results=results, apt=apt.report(), watch=watch.report(units), **s)
        t0 = time.monotonic()
        try:
            reply = json.loads(link.request("POST", "/api/report", json.dumps(report).encode()))
        except PinMismatch as e:
            print(f"SECURITY: {e}", flush=True)
            write_status(last_error=f"SECURITY: {e}", last_error_at=time.time())
            continue
        except Exception as e:  # hub down or unreachable: keep sampling, keep results
            print(f"report failed: {e}", flush=True)
            write_status(last_error=str(e), last_error_at=time.time())
            continue
        rtt = round((time.monotonic() - t0) * 1000, 1)
        write_status(last_ok=time.time(), rtt=rtt, interval=interval)
        if restart:
            sys.exit(0)  # the update result has been delivered; systemd starts the new version
        results = []
        interval = max(2, int(reply.get("interval", interval)))
        units = reply.get("watch") or []
        for a in reply.get("actions", []):
            ok, msg = do_action(a, info["cores"], link, apt)
            print(f"action {a.get('type')} {'ok' if ok else 'FAILED'}: {msg}", flush=True)
            results.append({"id": a.get("id"), "ok": ok, "msg": msg[:500]})
            restart = restart or (a.get("type") == "update" and ok)


# ---------------------------------------------------------------- `sudo pipulse`: the on-Pi menu

def ask(prompt, default=""):
    try:
        v = input(f"{prompt}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        return default
    return v or default


def pause():
    ask("\nPress Enter to go back")


def status_lines():
    cfg = load_config(required=False)
    st = json.loads(read(STATUS) or "{}")
    _, active = run(["systemctl", "is-active", "pipulse-client"])
    lines = [f"PiPulse Client {VERSION} on {socket.gethostname()}   service: {active or 'unknown'}"]
    if not cfg["hub"]:
        return lines + ["Not paired with a hub yet: choose 'Pair with a hub'."]
    lines.append(f"Hub: {cfg['hub']}:{cfg['port']}   encrypted (TLS, hub certificate pinned)")
    if st.get("last_ok"):
        lines.append(f"Last report: {time.time() - st['last_ok']:.0f} s ago, {st.get('rtt', '?')} ms round trip")
    if st.get("last_error_at", 0) > st.get("last_ok", 0):
        lines.append(f"Last error: {st.get('last_error')}")
    return lines


def act_status():
    cfg = load_config(required=False)
    print("\n".join(status_lines()))
    if cfg["pin"]:
        print(f"\nPinned hub certificate:\n  {fmt_fp(cfg['pin'])}")
        print("It must match Settings > Encrypted client link on the hub.")
    pause()


def act_test():
    cfg = load_config(required=False)
    if not cfg["hub"]:
        print("Not paired yet.")
        return pause()
    print(f"Connecting to https://{cfg['hub']}:{cfg['port']} ...")
    try:
        got = peer_fingerprint(cfg["hub"], cfg["port"])
    except OSError as e:
        print(f"  cannot reach the hub: {e}\n  Is the hub on, and is port {cfg['port']} reachable from here?")
        return pause()
    if got != cfg["pin"].replace(":", "").lower():
        print("  CERTIFICATE MISMATCH: something other than your hub answered, or the hub was\n"
              "  reinstalled without its old certificate. Pair again only if you trust it.")
        print(f"  pinned: {fmt_fp(cfg['pin'])}\n  seen:   {fmt_fp(got)}")
        return pause()
    print("  encryption OK: the hub's certificate matches the pin")
    link = Link(cfg["hub"], cfg["port"], cfg["token"], cfg["pin"])
    try:
        link.request("GET", "/client.py")
        print("  token OK: the hub accepts this Pi")
        print("  hub version:", json.loads(link.request("GET", "/api/ping"))["version"])
    except Exception as e:
        print(f"  the hub refused this Pi's token ({e}). Pair again with the token from + Add a Pi.")
    pause()


def act_pair():
    cfg = load_config(required=False)
    print("Pair this Pi with a PiPulse Hub. You need the hub's address and its token")
    print("(the part after ?t= in the hub's  + Add a Pi  command).\n")
    host = ask("Hub address (IP or name)", cfg["hub"])
    port = ask("Hub client-link port", str(cfg["port"]))
    token = ask("Token", cfg["token"])
    if not (host and port.isdigit() and token):
        print("Cancelled.")
        return pause()
    try:
        fp = peer_fingerprint(host, port)
    except OSError as e:
        print(f"Cannot reach https://{host}:{port}: {e}")
        return pause()
    print(f"\nThe hub presents this certificate fingerprint:\n  {fmt_fp(fp)}")
    print("Compare it with Settings > Encrypted client link on the hub's dashboard.")
    if ask("Does it match? (yes/no)", "no").lower() not in ("y", "yes"):
        print("Not paired. Nothing was changed.")
        return pause()
    try:
        Link(host, port, token, fp).request("GET", "/client.py")
    except Exception as e:
        print(f"The hub rejected that token: {e}")
        return pause()
    save_config(cfg | {"hub": host, "port": int(port), "token": token, "pin": fp})
    run(["systemctl", "restart", "pipulse-client"])
    print("Paired. The client restarted and now reports over the encrypted link.")
    pause()


def act_update():
    cfg = load_config(required=False)
    try:
        new = Link(cfg["hub"], cfg["port"], cfg["token"], cfg["pin"]).request("GET", "/client.py")
        compile(new, "client.py", "exec")
    except Exception as e:
        print(f"Could not fetch the client from the hub: {e}")
        return pause()
    m = re.search(rb'^VERSION = "([^"]+)"', new, re.M)
    newv = m.group(1).decode() if m else "?"
    if newv == VERSION:
        print(f"Already up to date ({VERSION}).")
        return pause()
    me = os.path.abspath(__file__)
    with open(me + ".new", "wb") as f:
        f.write(new)
    os.chmod(me + ".new", 0o755)
    os.replace(me + ".new", me)
    run(["systemctl", "restart", "pipulse-client"])
    print(f"Updated {VERSION} -> {newv} and restarted. Reopen this menu to use the new version.")
    pause()
    sys.exit(0)


def act_log():
    subprocess.run(["journalctl", "-u", "pipulse-client", "-n", "40", "--no-pager", "-o", "short-iso"])
    pause()


def act_restart():
    code, out = run(["systemctl", "restart", "pipulse-client"])
    print("Restarted." if code == 0 else f"Restart failed: {out}")
    pause()


def act_uninstall():
    if ask("Remove the PiPulse Client from this Pi? (yes/no)", "no").lower() not in ("y", "yes"):
        return
    run(["systemctl", "disable", "--now", "pipulse-client"])
    for f in ("/etc/systemd/system/pipulse-client.service", CONFIG, "/usr/local/bin/pipulse", STATUS):
        try:
            os.remove(f)
        except OSError:
            pass
    run(["systemctl", "daemon-reload"])
    print("Removed. (Delete /opt/pipulse-client to remove this program file too.)")
    sys.exit(0)


MENU = [("Status", act_status), ("Test the connection to the hub", act_test),
        ("Pair with a hub (encryption)", act_pair), ("Update this client from the hub", act_update),
        ("Show the recent log", act_log), ("Restart the client", act_restart),
        ("Uninstall the client", act_uninstall), ("Quit", None)]


def pick(stdscr):
    import curses
    curses.curs_set(0)
    sel = 0
    while True:
        stdscr.erase()
        h, w = stdscr.getmaxyx()
        head = status_lines()
        for i, line in enumerate(head):
            stdscr.addnstr(i + 1, 2, line, max(1, w - 4), curses.A_BOLD if i == 0 else 0)
        top = len(head) + 2
        for i, (label, _) in enumerate(MENU):
            if top + i < h - 1:
                stdscr.addnstr(top + i, 4, f" {i + 1}. {label} ", max(1, w - 6), curses.A_REVERSE if i == sel else 0)
        if top + len(MENU) + 1 < h:
            stdscr.addnstr(top + len(MENU) + 1, 2, "Up/down + Enter, or a number. q quits.", max(1, w - 4))
        k = stdscr.getch()
        if k in (curses.KEY_UP, ord("k")):
            sel = (sel - 1) % len(MENU)
        elif k in (curses.KEY_DOWN, ord("j")):
            sel = (sel + 1) % len(MENU)
        elif k in (10, 13, curses.KEY_ENTER):
            return sel
        elif k in (ord("q"), 27):
            return len(MENU) - 1
        elif ord("1") <= k < ord("1") + len(MENU):
            return k - ord("1")


def menu():
    if os.geteuid() != 0:
        os.execvp("sudo", ["sudo", sys.executable, os.path.abspath(__file__), "--menu"])
    while True:
        try:
            # Arrow-key menu only on a real terminal. curses on a pipe grabs the input
            # meant for the numbered fallback.
            if not (sys.stdin.isatty() and sys.stdout.isatty()) or os.environ.get("TERM") in (None, "", "dumb"):
                raise RuntimeError("no terminal")
            import curses
            choice = curses.wrapper(pick)
        except Exception:  # no curses or a dumb terminal: plain numbered menu
            print("\n".join(status_lines()) + "\n")
            for i, (label, _) in enumerate(MENU, 1):
                print(f"  {i}. {label}")
            v = ask("Choose")
            choice = int(v) - 1 if v.isdigit() and 1 <= int(v) <= len(MENU) else len(MENU) - 1
        fn = MENU[choice][1]
        if fn is None:
            return
        print()
        fn()


def main():
    if "--menu" in sys.argv:
        return menu()
    if "--once" in sys.argv:
        sampler = Sampler()
        sampler.sample()
        time.sleep(1)
        return print(json.dumps(dict(info=static_info(), **sampler.sample()), indent=1))
    if "--check" in sys.argv:
        cfg = load_config()
        try:
            v = json.loads(Link(cfg["hub"], cfg["port"], cfg["token"], cfg["pin"]).request("GET", "/api/ping"))["version"]
            print("hub reachable, certificate matches the pin, version", v)
        except Exception as e:
            sys.exit(f"cannot talk to the hub: {e}")
        return
    serve()


if __name__ == "__main__":
    main()
