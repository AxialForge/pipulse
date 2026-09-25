# PiPulse

PiPulse watches a handful of Raspberry Pis from one dashboard, and stops any one
program from starving a Pi of CPU or memory.

It is two programs:

- **PiPulse Hub** lives on one Pi. It hosts the web dashboard, the settings, the
  logs (SQLite) and the alerts, and it monitors its own Pi too.
- **PiPulse Client** goes on every other Pi. It's a small service that reports to
  the hub every few seconds over an encrypted link and applies the limits you set.
  It's capped at 10% CPU and 48 MB RAM and uses about 25 MB.

Both are plain Python 3 standard library: no pip, no Docker, nothing to compile.
Raspberry Pi OS Lite already has everything they need.

## Install the hub

On the Pi that will be the hub, run:

```
curl -fsSL https://github.com/AxialForge/pipulse/releases/latest/download/install-hub.sh | sudo sh
```

It installs the `pipulse-hub` service (dashboard on port **8750**, encrypted client
link on **8751**) and a client for the hub Pi itself. Then it prints the dashboard
address. Open it and create your password.

Re-run the same line to upgrade. The database, password, token and certificate are
kept, so existing clients keep working.

## Add a Pi

In the dashboard, click **+ Add a Pi**. It shows a command like:

```
curl -fsSL 'http://<hub>:8750/client/install.sh?t=<token>' | sudo sh
```

Run that on the new Pi, and it appears within about 10 seconds. Clients always
install from your hub, so a client's version matches its hub. When the hub is
upgraded, each Pi shows an **Update** button.

## What you get

- **Pis**: a card per Pi with CPU, RAM, temperature, disk, a one-hour sparkline and active alerts.
- **Per-Pi detail**:
  - *Overview*: per-core CPU, disks, network, throttling and under-voltage flags.
  - *History*: charts for 1 hour up to 1 year.
  - *Services*: CPU and RAM per systemd service, with **Limit** and **Restart**.
  - *Processes*: the busiest and biggest processes, with **Nice**.
  - *Events*.
- **Events**: everything the hub has logged (alerts raised and cleared, actions,
  sign-ins, settings changes), filterable and searchable.
- **Settings**: report interval, offline timeout, alert thresholds, how long a
  problem must last before it alerts, history retention, the client-link
  fingerprint and the password.

### Keeping one program from starving a Pi

On a Pi's **Services** tab, click **Limit** to cap a service's CPU (in cores),
cap its memory, or lower its priority. systemd enforces these limits
(`systemctl set-property`). They survive reboots and don't change the program
itself. Near the memory cap the service is slowed down, and past it systemd
restarts it instead of letting the whole Pi freeze.

## Security

- **Client → hub traffic is encrypted.** The hub makes its own certificate the
  first time it starts, and every client pins that certificate's SHA-256
  fingerprint at install. A client won't send anything to a hub whose certificate
  doesn't match. No certificate authority is involved, so nothing costs money or
  expires. Reports on the unencrypted dashboard port are refused.
- The dashboard needs a password, which you create on first visit. Sessions last 30 days.
- The dashboard itself is plain HTTP, so it's meant for your home network. To
  reach it from outside, use your router's VPN (UniFi has WireGuard and Teleport
  built in). Don't port-forward it.
- **Moving the hub to another Pi:** copy `/var/lib/pipulse` across, including
  `hub-cert.pem` and `hub-key.pem`. Otherwise every client needs reinstalling
  because its pin won't match.

Forgot the password:

```
sudo -u pipulse python3 /opt/pipulse-hub/hub/hub.py --data /var/lib/pipulse --set-password
```

## Remove

- Client: `curl -fsSL http://<hub>:8750/client/uninstall.sh | sudo sh`
- Hub: `curl -fsSL http://<hub>:8750/hub/uninstall.sh | sudo sh`. Add `-s -- --purge` at the end to also delete its data.

## Develop

```
python hub/hub.py                  # dev hub on this PC (needs openssl; Git for Windows' copy works)
python tools/demo.py               # three fake Pis over the real encrypted link
python tools/demo.py --backfill    # 30 days of fake history for them (restart the hub afterwards)
python -m unittest discover tests  # end-to-end tests against a real hub process
python tools/package.py            # release assets into dist/
```

A running dev hub can also install itself onto a Pi, which is handy before a release exists:
`curl -fsSL http://<pc>:8750/hub/install.sh | sudo sh`.

Releases: bump `VERSION`, update `CHANGELOG.md`, then tag `vX.Y.Z` and push.
CI tests, packages and attaches `install-hub.sh`, `pipulse-hub.tar.gz`,
`pipulse-client.py` and `SHA256SUMS` to the release.

## Roadmap

- Notifications: phone push (ntfy), Home Assistant (MQTT discovery), email.
- Automatic guard rules ("if a service stays above X for Y minutes, limit it").
- HTTPS for the dashboard.
