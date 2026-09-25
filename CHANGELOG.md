# Changelog

All notable changes to PiPulse. Format: [Keep a Changelog](https://keepachangelog.com).

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
