# Changelog

All notable changes to PiPulse. Format: [Keep a Changelog](https://keepachangelog.com).

## [0.4.1] - 2026-09-25

### Fixed
- NAS setup took whatever was typed at the share prompt, so a username there
  became a broken fstab entry ("mount.cifs: bad UNC"). It now only accepts a
  `//server/share` address, and says to press Enter for the default. A bad
  entry saved by 0.4.0 is asked for again instead of reused.
- A failed NAS step no longer ends the hub install early. The hub works without
  it, and the summary with the dashboard address is still printed.

## [0.4.0] - 2026-09-25

### Added
- **NAS storage.** `sudo pipulse-hub nas` mounts the NAS share on the hub Pi. Then:
  - Every hour the database is mirrored to `Local_APP_Tank\PiPulse\pipulse-live.db`.
  - Data past the history limits is archived there as daily `.csv.gz` files instead of deleted, so the NAS keeps everything.
  - Every night a backup goes to `Backup_Pool\PiPulse Backup`: the database plus the hub's certificate and key, keeping the last 30.
  - `sudo pipulse-hub restore <file>` puts a backup back, and clients keep working.
  - Nothing is written unless the share is really mounted, so a dropped mount can't fill the SD card.
- **Updater.** The hub checks GitHub daily. **Update hub** on the new About page installs the new release after checking its SHA256SUMS. **Update all Pis** then updates every client over the encrypted link.
- **About page**: version, update status, release notes, the changelog and hub details.
- **Add a Pi over SSH**: a second tab builds `ssh -t user@pi "…"` lines for one or more Pis, to paste into your PC's terminal.
- **`sudo pipulse` on every client Pi**: a menu to see status, test the connection, pair with a hub (check the certificate fingerprint), update, view the log, restart or uninstall.
- **Service watchdog**: watch any service per Pi, get an alert if it stops, and optionally auto-restart it (at most 3 times an hour).
- **Remote reboot and shutdown**, and **OS updates**: see waiting apt updates (with the security count) and install them from the dashboard. They run in their own systemd unit, outside the client's CPU and memory cap.
- **Health**: disk-write rate and total since boot (SD wear), a read-only root filesystem alert, reboot detection ("rebooted, not from PiPulse"), and link latency to the hub. New History charts for disk writes and latency.
- **Guard rules**: "if a service stays above X for Y minutes, cap it at Z", for all Pis or one. They never touch SSH, systemd's core services or PiPulse itself.

### Changed
- The hub tarball is byte-for-byte reproducible, so its checksum can be published and verified.

## [0.3.0] - 2026-09-25

The first release, split into two programs.

### Added
- **PiPulse Hub**: runs on a Raspberry Pi as the `pipulse-hub` service. It holds
  the dashboard, the settings, the logs and the alerts, and installs a client on
  its own Pi so that Pi is monitored too.
- **PiPulse Client**: a small reporter on each Pi (`pipulse-client`, capped at
  10% CPU / 48 MB), installed from the hub's **+ Add a Pi** command.
- Encrypted client link. Reports go over HTTPS on the hub's own certificate, and
  each client pins the certificate's fingerprint at install, refusing to send to anything else.
- Logging in SQLite. Full detail for 7 days and hourly averages for a year (both
  configurable), plus a searchable Events page.
- History tab with CPU, memory, temperature, load, disk and network charts over 1h, 6h, 24h, 7d, 30d or 1y.
- Settings page for the report interval, offline timeout, alert thresholds, how
  long a problem must last before it alerts, history retention, and the dashboard password.
- Alerts are raised and cleared with an event for each, and are ready for notification channels.
- Service limits (CPU cap, memory cap, priority), renice, restart, and one-click client updates from the dashboard.
- Upgrading from the 0.2 prototype keeps the password, the token and the known Pis.
