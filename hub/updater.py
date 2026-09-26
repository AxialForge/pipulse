"""Hub updates from GitHub releases.

The hub runs as the unprivileged `pipulse` user and can't replace its own
files. So "Update hub" only writes update/request.json into the data folder.
A root-owned systemd path unit (pipulse-hub-updater.path, set up by
install.sh) notices it and runs hub/update.sh, which does these steps:
  1. downloads the release's install-hub.sh;
  2. checks it against the release's SHA256SUMS;
  3. runs it;
  4. writes update/result.json.
The hub picks the result up in its upkeep loop and logs it as an event.

Client updates don't need any of this: clients update themselves from the hub
(the `update` action) once the hub is on the new version.
"""
import json
import re
import threading
import time
import urllib.request
from pathlib import Path

REPO = "AxialForge/pipulse"
INSTALL_DIR = Path("/opt/pipulse-hub")
PATH_UNIT = Path("/etc/systemd/system/pipulse-hub-updater.path")


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")[:3])


class Updater:
    def __init__(self, hub):
        self.hub, self.store = hub, hub.store
        self.dir = hub.data / "update"
        self.dir.mkdir(exist_ok=True)
        self.checking = False

    @property
    def latest(self):
        return self.store.settings.get("_latest") or {}

    def managed(self):
        """True when this hub was installed by install.sh, so it can update itself."""
        return Path(__file__).resolve().parent.parent == INSTALL_DIR and PATH_UNIT.exists()

    def available(self):
        v = self.latest.get("version")
        return v if v and vtuple(v) > vtuple(self.hub.version) else None

    def check_now(self):
        """Ask GitHub now and wait for the answer (the About page's "Check for updates")."""
        if not self.checking:
            self.checking = True
            self._fetch(quiet=False)

    def check(self, quiet=False):
        """Ask GitHub for the latest release (in a thread). Records the result in settings."""
        if self.checking:
            return
        self.checking = True
        threading.Thread(target=self._fetch, args=(quiet,), daemon=True).start()

    def _fetch(self, quiet):
        """Ask GitHub for the latest release and record it (or the error) in settings."""
        try:
            req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/latest",
                                         headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": f"PiPulse-Hub/{self.hub.version}"})
            with urllib.request.urlopen(req, timeout=15) as r:
                rel = json.load(r)
            before = self.available()
            self.store.put("_latest", {
                "version": rel["tag_name"].lstrip("v"), "notes": rel.get("body") or "",
                "url": rel.get("html_url"), "published": rel.get("published_at"),
                "checked": time.time(), "error": None})
            now = self.available()
            if now and now != before:
                self.store.add_event(None, "info", "update", f"PiPulse {now} is available")
        except Exception as e:
            if getattr(e, "code", None) == 404:
                e = "no release published on GitHub yet"
            self.store.put("_latest", self.latest | {"checked": time.time(), "error": str(e)})
            if not quiet:
                self.store.add_event(None, "warn", "update", f"update check failed: {e}")
        finally:
            self.checking = False

    def due(self, now):
        if self.store.settings["update_check"] and now - self.latest.get("checked", 0) > 86400:
            self.check(quiet=True)
        res = self.dir / "result.json"
        if res.exists():
            try:
                r = json.loads(res.read_text())
                self.store.add_event(None, "ok" if r.get("ok") else "error", "update", r.get("msg", "update finished"))
            except ValueError:
                pass
            res.unlink(missing_ok=True)

    def request(self):
        v = self.available()
        if not v:
            raise ValueError("no newer release to install")
        if not self.managed():
            raise ValueError("this hub wasn't installed with install.sh, so it can't update itself")
        tmp = self.dir / "request.json.tmp"
        tmp.write_text(json.dumps({"version": v, "at": time.time()}))
        tmp.replace(self.dir / "request.json")
        self.store.add_event(None, "info", "update", f"hub update to {v} started")
        return v

    def view(self):
        return {"current": self.hub.version, "latest": self.latest, "available": self.available(),
                "managed": self.managed(), "checking": self.checking,
                "in_progress": (self.dir / "request.json").exists(), "repo": REPO}
