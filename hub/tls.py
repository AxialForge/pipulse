"""The hub's own TLS certificate for the encrypted client link.

No certificate authority is involved. The hub makes a self-signed ECDSA cert on
first start, and every client pins its SHA-256 fingerprint at install time. A
client refuses to send anything to a hub whose certificate doesn't match, so
nothing on the network can pose as the hub or read the reports.
"""
import hashlib
import os
import shutil
import ssl
import subprocess
from pathlib import Path


def find_openssl():
    exe = shutil.which("openssl")
    if exe:
        return exe
    for p in (r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\Git\mingw64\bin\openssl.exe"):
        if Path(p).exists():  # dev hub on Windows: Git for Windows ships one
            return p
    return None


def ensure_cert(data: Path):
    cert, key = data / "hub-cert.pem", data / "hub-key.pem"
    if not (cert.exists() and key.exists()):
        exe = find_openssl()
        if not exe:
            raise RuntimeError("openssl is needed once to create the hub certificate (sudo apt install openssl)")
        subprocess.run([exe, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                        "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "9999",
                        "-subj", "/CN=PiPulse hub"], check=True, capture_output=True)
        try:
            os.chmod(key, 0o600)
        except OSError:
            pass
    return cert, key, fingerprint(cert)


def fingerprint(cert: Path):
    der = ssl.PEM_cert_to_DER_cert(cert.read_text())
    return hashlib.sha256(der).hexdigest()


def server_context(cert, key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    return ctx
