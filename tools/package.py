#!/usr/bin/env python3
"""Build the release assets into dist/:

    install-hub.sh        one-line hub installer, pointed at this release
    pipulse-hub.tar.gz    the hub (and the client it hands out)
    pipulse-client.py     the client on its own, version stamped
    SHA256SUMS

    python tools/package.py [--repo AxialForge/pipulse]
"""
import hashlib
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR / "hub"))
import hub  # noqa: E402

repo = sys.argv[sys.argv.index("--repo") + 1] if "--repo" in sys.argv else "AxialForge/pipulse"
version = hub.VERSION
dist = REPO_DIR / "dist"
dist.mkdir(exist_ok=True)

src = f"https://github.com/{repo}/releases/download/v{version}"
(dist / "install-hub.sh").write_text(
    (REPO_DIR / "hub" / "install.sh").read_text().replace("__SRC__", src).replace("__PORT__", "8750"), newline="\n")
(dist / "pipulse-hub.tar.gz").write_bytes(hub.bundle())
(dist / "pipulse-client.py").write_bytes(hub.client_source())

names = ("install-hub.sh", "pipulse-hub.tar.gz", "pipulse-client.py")
sums = "".join(f"{hashlib.sha256((dist / n).read_bytes()).hexdigest()}  {n}\n" for n in names)
(dist / "SHA256SUMS").write_text(sums, newline="\n")
print(f"PiPulse {version} packaged into {dist}:\n{sums}", end="")
