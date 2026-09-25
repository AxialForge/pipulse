# PiPulse

Two programs in one repo. **PiPulse Hub** (`hub/`) lives on one Raspberry Pi: it
hosts the dashboard, settings, SQLite logging and alerts. **PiPulse Client**
(`client/`) runs on every Pi, including the hub's, and reports to the hub over
an encrypted, certificate-pinned link. It also applies service limits, renices,
restarts and updates itself when the hub asks. It is a small-fleet home tool (a
handful of Pis), not Prometheus: no agents to configure, no time-series server,
no cloud.

## Non-negotiables

- **Standard library only**, on both sides. Everything must install on a bare
  Pi OS Lite with one `curl | sudo sh`. openssl is used once, to make the hub cert.
- **The client stays cheap.** It runs under `Nice=10 CPUQuota=10% MemoryMax=48M`
  and uses about 25 MB. Read `/proc` and `/sys` directly and run subprocesses
  rarely (vcgencmd every 30 s).
- **Pis never listen.** All traffic is client → hub; actions come back in the report reply.
- **Reports only travel encrypted.** The client refuses a hub whose cert doesn't
  match the pin (`Link.request`), and the dashboard port rejects `/api/report`
  (it's behind the session check). Don't add a plain-HTTP report path "for testing".
- **The client validates every action itself** (unit-name regex, value ranges,
  sha256 for updates), even though the hub validated it too.
- Limits go through `systemctl set-property` (persistent drop-ins; `--runtime`
  for `.scope`). Never write cgroup files directly.
- **The SD card is precious.** Samples are buffered and flushed every 30 s, not
  committed per report. Keep it that way.
- One version for both programs: `VERSION`. The hub stamps it into `client.py`
  when serving it, and `tools/package.py` does the same for releases.

## Commands

```
python hub/hub.py [--port 8750] [--link-port 8751] [--data DIR]
python tools/demo.py [host] [count]     # fake Pis over the real pinned link
python tools/demo.py --backfill         # 30 days of fake history (restart hub after)
python -m unittest discover tests       # end-to-end: spawns a real hub on free ports
python tools/package.py                 # dist/ release assets
```

## Architecture

| Path | What |
|---|---|
| `VERSION` | The one version number for hub and client |
| `hub/hub.py` | Entry point, `Hub` runtime state, report handling, background upkeep, both HTTP handlers (`WebHandler` for the dashboard, `LinkHandler` for TLS) |
| `hub/store.py` | SQLite: settings (secrets are `_`-prefixed and never sent to the browser), nodes, samples, hourly roll-ups, events, sessions. Holds `DEFAULTS`/`LIMITS` for settings |
| `hub/alerts.py` | `conditions()` (what's wrong now) and `Alerts` (sustain → raise → clear → event). `NOTIFIERS` is the hook for ntfy, Home Assistant and email |
| `hub/tls.py` | Self-signed ECDSA cert via openssl, SHA-256 fingerprint, server context |
| `hub/install.sh`, `hub/uninstall.sh` | Pi hub installer (`__SRC__`/`__PORT__` filled by the serving hub or by package.py) |
| `hub/static/` | Dashboard: `index.html`, `app.js` (hash routes `#pis`/`#events`/`#settings`), `style.css` |
| `client/client.py` | `Link` (pinned HTTPS), `Sampler`, actions, report loop, `--check`/`--once` |
| `client/install.sh`, `client/uninstall.sh` | Client installer; the hub fills host, ports, token, pin and sha256 |
| `tools/demo.py`, `tools/package.py` | Fake Pis and backfill; release packaging |
| `tests/test_link.py` | End-to-end tests with a real hub process |

On a Pi: the hub is in `/opt/pipulse-hub/{hub,client,VERSION}` (same layout as
the repo), data in `/var/lib/pipulse` (DB, `hub-cert.pem`, `hub-key.pem`), and
the service runs as user `pipulse` with ProtectSystem=strict. The client is
`/opt/pipulse-client/client.py` plus `/etc/pipulse/client.json` (hub, port,
token, pin), running as root because limits and renice need it. The hub Pi's
own client uses `127.0.0.1` (`install.sh?...&local=1`).

## Extension points

**A new client action.** Add it to `clean_action()` in hub.py, which returns the
payload and an event text. Add it to `do_action()` in client.py and validate it
again there. Add it to demo.py's action loop and give it a button in app.js that
calls `act({...})`.

**A new setting.** Add it to `DEFAULTS` and `LIMITS` in store.py, then add a
field to `SETTING_GROUPS` in app.js. `LIMITS` is the allow-list: anything not in
it is rejected.

**A notification channel.** Append a callable `(node_name, {"level", "text"})`
to `alerts.NOTIFIERS`. Put its configuration in settings with `_`-prefixed keys
for any secrets.

## Gotchas

- **Hub URL in install commands.** When the dashboard is opened as `localhost`,
  the hub swaps in a LAN IP (`lan_ip()`). The default route on the dev PC is the
  NordVPN tunnel (10.5.0.2), so it ranks 192.168.x first. Don't "simplify" it
  back to the UDP-connect trick alone.
- **Rows re-sort by CPU on every poll**, which made a Limit click land on the
  wrong service. `renderDetail()` skips the refresh while the pointer is over a
  table. The History tab has its own 30-second refresh for the same reason.
- **TLS handshake in `LinkHandler.setup()`, not at accept.** The listening socket
  is wrapped with `do_handshake_on_connect=False`. Handshaking in accept would let
  one stalled client block every other report.
- **The client checks the pin itself and turns chain checks off.** Python 3.13's
  default context enforces `VERIFY_X509_STRICT`, which is brittle with a
  self-signed cert that is its own CA. Fingerprint pinning is the trust decision,
  so don't "harden" it back to `create_default_context(cafile=...)`.
- **Alert state lives in memory.** After a hub restart, alerts that are still
  true get raised again, so you see a second "raised" event without a "cleared"
  in between. This is harmless. Persist the state if it ever annoys anyone.
- **A test that grepped the install script for a bare `__` flaked.** The random
  token can contain `__`. Check the named placeholders instead.
- Clearing a limit sets empty values (`CPUQuota=`). The `50-*.conf` drop-ins stay
  behind but hold nothing. That's systemd, not a bug.
- **WSL is the test Pi.** Ubuntu there has systemd. WSL stops its VM between
  `wsl` calls when idle, so put a multi-step test in one script and run it with
  one `wsl ... sh script`. Use ports 8760/8761 for a WSL hub so they don't clash
  with the PC dev hub.

## Roadmap

- Notifications through `NOTIFIERS`: ntfy, Home Assistant (MQTT discovery), email. The user chose all three.
- Guard rules: automatic limits when a service stays hot.
- HTTPS for the dashboard. The user didn't want it yet, since it means trusting a cert on each device.
- Per-client keys (revoke one Pi). The user didn't want it yet; the shared token now only travels encrypted.
