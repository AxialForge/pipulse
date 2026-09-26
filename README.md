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
link on **8751**) and a client for the hub Pi itself. It offers to create the dashboard's
**admin** account and to connect the NAS (see below), then prints the dashboard address. If
you skip the account, the first visit to the dashboard creates it. Behind Caddy, the dashboard
is `https://pipulse.home`.

**Updating:** the hub checks GitHub daily, and the **About** page shows **Update hub**
when a release is out. Then **Update all Pis** brings every client along. Re-running
the install line also upgrades. The database, password, token and certificate are
kept, so clients keep working.

## Add a Pi

In the dashboard, click **+ Add a Pi**. It shows a command like:

```
curl -fsSL 'http://<hub>:8750/client/install.sh?t=<token>' | sudo sh
```

Run that on the new Pi, and it appears within about 10 seconds. The dialog's
**From your PC over SSH** tab builds `ssh -t user@pi "…"` lines instead, one per Pi
address you type, to paste into PowerShell or a terminal on your PC.

Clients always install from your hub, so a client's version matches its hub.

On any client Pi, `sudo pipulse` opens a small menu with these options:
- status
- test the connection to the hub
- pair with a hub, after checking its certificate fingerprint
- update
- recent log
- restart
- uninstall

## What you get

The dashboard is a [Bracket](https://github.com/AxialForge/bracket) app, the same frame as
MediaLedger and Linewatch: a sidebar, stat tiles, cards and eight colour themes.

- **Pis**: a row of tiles per Pi (health, CPU, memory, temperature, disk and link latency),
  with a coloured edge on anything that needs attention. It refreshes every 5 seconds.
- **A Pi's page**: more tiles (throttling, filesystem, disk writes, OS updates, network,
  processes), then these tabs:
  - *Overview*: CPU per core, memory, temperature, storage, OS updates with **Install**, and
    **Reboot** / **Shut down**.
  - *History*: charts from 1 hour to 1 year.
  - *Services*: **Watch** (alert, optional auto-restart), **Limit** and **Restart**.
  - *Processes*: with **Nice**.
  - *Events*.
- **Events**: everything the hub logged, filterable and searchable.
- **Add a Pi**: the install command for one Pi, or SSH lines for several at once.
- **Settings**: report interval, alert thresholds, history limits, NAS storage and backups, guard
  rules, the client-link fingerprint, colour theme, and the Home Assistant status URL.
- **Security**: accounts (admin / standard), sessions, LAN-only, guest view and the audit log.
- **About**: versions, **Update hub**, **Update all Pis**, release notes, the changelog.

**Definitions everywhere.** Words like *load average*, *swap*, *throttling* or *CPU cap* have a
dotted underline. Hover for a one-line meaning, or click for a panel with the full explanation,
what healthy looks like, what to do if it isn't, and related terms.

A Pi that reboots without PiPulse asking it to is logged ("rebooted, not from PiPulse").

## NAS storage and backups

`sudo pipulse-hub nas` on the hub Pi mounts the NAS share at `/mnt/pipulse`. It
asks for the NAS login once and offers to reuse Linewatch's. From then on:

| What | Where (default) | When |
|---|---|---|
| Database mirror (`pipulse-live.db`) | `Local_APP_Tank\PiPulse` | every hour |
| Archive of data past the history limits (daily `.csv.gz` files) | `Local_APP_Tank\PiPulse\archive` | hourly; nothing is ever lost |
| Backup: database + hub certificate and key | `Backup_Pool\PiPulse Backup` | nightly at 3:00, newest 30 kept |

The live database stays on the Pi. SQLite over SMB can corrupt, and logging
would stop whenever the NAS sleeps. If the NAS is away, the hub keeps the data
until it's back, for up to a week. Nothing is written unless the share really
is mounted, so a dropped mount can't fill the SD card. Folders, times and
retention are in Settings, which also has **Mirror now** and **Back up now**.

Restore: `sudo pipulse-hub restore "/mnt/pipulse/Backup_Pool/PiPulse Backup/<file>"`.
It moves the current data aside, not away, and clients carry on because the
certificate comes back too.

### Keeping one program from starving a Pi

On a Pi's **Services** tab, click **Limit** to cap a service's CPU (in cores),
cap its memory, or lower its priority. systemd enforces these limits
(`systemctl set-property`). They survive reboots and don't change the program
itself. Near the memory cap the service is slowed down, and past it systemd
restarts it instead of letting the whole Pi freeze.

**Guard rules** (Settings) do this automatically: "if a service stays above 150%
CPU for 5 minutes, cap it at 1 core". Each rule fires once per service and is
logged. Rules never touch SSH, systemd's core services or PiPulse.

## Security

- **Client → hub traffic is encrypted.** The hub makes its own certificate the
  first time it starts, and every client pins that certificate's SHA-256
  fingerprint at install. A client won't send anything to a hub whose certificate
  doesn't match. No certificate authority is involved, so nothing costs money or
  expires. Reports on the unencrypted dashboard port are refused.
- The dashboard uses Bracket's security model:
  - **admin** and **standard** accounts
  - 30-day sessions
  - lockout after 8 failed sign-ins
  - LAN-only access
  - guest view off
  - the password asked again for reboot, shutdown, forgetting a Pi, settings changes and hub
    updates
  - an audit log on the Security page

  0.4's single password became the **admin** account.
- Open it through Caddy (`https://pipulse.home`) for HTTPS. Don't port-forward it; to reach it
  from outside, use your router's VPN (UniFi has WireGuard and Teleport built in).
- **Moving the hub to another Pi:** copy `/var/lib/pipulse` across, including
  `hub-cert.pem` and `hub-key.pem`. Otherwise every client needs reinstalling
  because its pin won't match.

The `pipulse-hub` command on the hub Pi has these subcommands:

| Command | What it does |
|---|---|
| `status` | Hub and local client service status |
| `nas` | Connect (or reconnect) the NAS |
| `restore FILE` | Restore a backup |
| `set-password` | Set or reset the admin password (restarts the hub) |
| `log` | Recent hub log |
| `update-log` | Log of the last update from the dashboard |

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
node tools/kit-upgrade.js --from ../Bracket   # show / --apply a newer Bracket kit into kit/
```

The pages are in `hub/web/` (`app.js`, `terms.js` for the definitions). `kit/` is Bracket's kit,
vendored whole and never edited here; the hub only ships its `renderer/`.

A running dev hub can also install itself onto a Pi, which is handy before a release exists:
`curl -fsSL http://<pc>:8750/hub/install.sh | sudo sh`.

Releases: bump `VERSION`, update `CHANGELOG.md`, then tag `vX.Y.Z` and push.
CI tests, packages and attaches `install-hub.sh`, `pipulse-hub.tar.gz`,
`pipulse-client.py` and `SHA256SUMS` to the release.

## Roadmap

- Notifications: phone push (ntfy), Home Assistant (MQTT discovery), email.
- HTTPS for the dashboard; per-client keys.
