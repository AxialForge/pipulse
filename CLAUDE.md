# PiPulse

Two programs in one repo. **PiPulse Hub** (`hub/`) lives on one Raspberry Pi: it
hosts the dashboard, settings, SQLite logging and alerts. **PiPulse Client**
(`client/`) runs on every Pi, including the hub's, and reports to the hub over
an encrypted, certificate-pinned link. It also applies service limits, renices,
restarts, reboots, installs OS updates and updates itself when the hub asks. The
hub mirrors, archives and backs up to the user's NAS, and updates itself from
GitHub releases. The dashboard is a **Bracket app**: the vendored Bracket kit's renderer
(`kit/renderer`) in front of `hub/web.py`, a stdlib port of Bracket's Python adapter. It is a small-fleet home tool (a handful of Pis), not Prometheus:
no agents to configure, no time-series server, no cloud.

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
- **The live database never lives on the NAS.** The NAS gets a mirror
  (VACUUM INTO locally, then copy + rename), day-file CSV archives and backups.
  Every NAS write goes through `nas.check_dir()`, which refuses a folder on the
  same device as `/` (an unmounted mountpoint). NAS jobs run in their own thread,
  because a hung CIFS mount must never stall the hub.
- **Anything heavy the client starts runs outside its cgroup** (`systemd-run`):
  apt checks, apt upgrades, delayed reboot and poweroff. Children inherit the
  client's 10% / 48 MB box, and apt inside it gets OOM-killed along with the client.
- **The hub never updates itself directly.** It runs unprivileged under
  ProtectSystem=strict. It writes `update/request.json`, and the root
  `pipulse-hub-updater.path` unit runs `hub/update.sh`. That script verifies the
  release's SHA256SUMS before running `install-hub.sh`.
- **`kit/` is Bracket's, vendored whole and never edited here.** Upgrade it with
  `node tools/kit-upgrade.js --from ../Bracket --apply`. A change the kit needs goes into
  AxialForge/bracket first (a new kit version), then comes back through an upgrade. PiPulse's look
  lives in `hub/web/app.css` on top of `kit.css`.
- **The dashboard contract is Bracket's**: `hub/web/bridge-shape.js` lists every channel;
  `tests/test_web.py` fails when a channel is listed but not served, or served but not listed.
  Security defaults from the kit don't loosen: LAN-only on, guest off, re-auth for SENSITIVE,
  cookie `pipulse_session`.
- One version for both programs: `VERSION`. The hub stamps it into `client.py`
  when serving it, and `tools/package.py` does the same for releases.

## Commands

```
python hub/hub.py [--port 8750] [--link-port 8751] [--data DIR]
python tools/demo.py [host] [count]     # fake Pis over the real pinned link
python tools/demo.py --backfill         # 30 days of fake history (restart hub after)
python -m unittest discover tests       # end-to-end: spawns a real hub on free ports
python tools/package.py                 # dist/ release assets
node tools/screenshots.js               # docs/screenshots from a running hub (headless Edge/Chrome; PIPULSE_SHOT_PASSWORD)
```

## Architecture

| Path | What |
|---|---|
| `VERSION` | The one version number for hub and client |
| `hub/hub.py` | Entry point, `Hub` runtime state, report handling (reboot detection, watchdog, guards), background upkeep, `bundle()` (deterministic tarball), both HTTP handlers (`WebHandler` for the dashboard, `LinkHandler` for TLS) |
| `hub/store.py` | SQLite schema v2: settings (secrets and state are `_`-prefixed and never sent to the browser), nodes (+ prefs), samples, hourly roll-ups, events, sessions. `DEFAULTS`/`LIMITS`/`PATHS` define the settings |
| `hub/alerts.py` | `conditions()` and `watch_conditions()` say what's wrong now. `Alerts` does sustain → raise → clear → event. `NOTIFIERS` is the hook for ntfy, Home Assistant and email |
| `hub/nas.py` | Mirror, archive + prune, and backup jobs. `check_dir` is the mounted-share guard |
| `hub/updater.py` | GitHub release check and the update request file. `managed()` is true only on a Pi install |
| `hub/guards.py` | Guard rules: validate + the sustained-over-limit engine. `PROTECTED` units |
| `hub/tls.py` | Self-signed ECDSA cert via openssl, SHA-256 fingerprint, server context |
| `hub/install.sh`, `hub/uninstall.sh` | Pi hub installer (`__SRC__`/`__PORT__` filled by the serving hub or by package.py; env `PIPULSE_PORT`, `PIPULSE_NONINTERACTIVE`) |
| `hub/update.sh` | Root updater, run by `pipulse-hub-updater.service` from a copy in /run |
| `hub/nas-setup.sh`, `hub/restore.sh`, `hub/pipulse-hub.sh` | NAS mount + credentials + remount timer; restore a backup; the `pipulse-hub` command |
| `hub/web.py` | The Bracket contract on http.server: accounts/roles/sessions/lockout/LAN-only/re-auth/audit (`web.json`), kit channels, static files, SSE, `/api/status` |
| `hub/web/` | The pages: `index.html`, `app-meta.js`, `bridge-shape.js` (the contract), `app.js` (views `pis`, `pi/<id>/<tab>`, `events`, `add`, `settings`; kit `security`, `about`), `terms.js` (glossary), `app.css`, `logo.svg` |
| `kit/` | Bracket kit, vendored whole (0.2.0). Only `kit/renderer` + `kit/VERSION` ship in the hub tarball |
| `client/client.py` | `Link` (pinned HTTPS), `Sampler`, `Apt`, `Watch`, actions, report loop, `--menu` (curses, with a numbered fallback) / `--check` / `--once` |
| `client/install.sh`, `client/uninstall.sh` | Client installer (also `/usr/local/bin/pipulse`); the hub fills host, ports, token, pin and sha256 |
| `tools/demo.py`, `tools/package.py`, `tools/screenshots.js` | Fake Pis (reboots, apt, watchdog crash) and backfill; release packaging |
| `tests/test_link.py`, `tests/test_features.py` | End-to-end tests with a real hub process, plus unit tests for NAS and guards |

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

**A new dashboard channel.** Add the leaf to `hub/web/bridge-shape.js`, register it in
`register_channels()` in hub.py with `@h("group:name")` (`ctx=True` for the request context), and
put it in `ROLES` (GUEST/STANDARD/SENSITIVE) if it isn't admin-only. `tests/test_web.py` checks
the three agree.

**A new term.** Add it to `hub/web/terms.js` and mark it with `T('key', 'label')` in app.js.
`tests/test_terms.py` checks every marked key exists and every `[[link]]` resolves.

**A new setting.** Add it to `DEFAULTS` and `LIMITS` in store.py (or `PATHS`
for a folder), then add a field to `SETTING_GROUPS` in app.js. The fifth element
is `'path'` or `'bool'` for non-numbers. `LIMITS`/`PATHS` are the allow-list:
anything not in them is rejected.

**A new NAS job.** Add a method to `Nas`, schedule it in `Nas.due()` and record
it with `_record()`. Call `check_dir()` first, always.

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
- **webbridge.js URL-encodes the channel** (`/api/fleet%3Astate`). The first build compared the
  raw path and every call answered "unknown channel fleet%3Astate". `Web.post` unquotes it.
- **Card headings are flex boxes**, so the space between a glossary term and the text after it
  collapsed ("CLIENT& POWER"). Wrap mixed heading text in one `<span>`.
- **The CLI password reset and the running hub share `web.json`.** The hub keeps accounts in
  memory and saves them back (session last-seen, every minute), overwriting a reset made from
  the shell. `pipulse-hub set-password` restarts the hub; the installer does too after creating
  the account.
- **Two `.tabs` navs on one page.** The Add-a-Pi dialog got tabs, came earlier
  in the DOM, and `$('.tabs')` silently bound the Pi dialog's handler to it, so
  the Pi tabs stopped switching. The Pi tabs are `#nodeTabs` now. Select by ID.
- **curses on a pipe eats stdin.** `pipulse` fed from a pipe started curses,
  which swallowed the answers meant for the numbered fallback. The menu uses
  curses only when stdin and stdout are TTYs.
- **No `x-systemd.automount` for the NAS.** The hub's ProtectSystem sandbox is its
  own mount namespace, and triggering an automount from inside it is unreliable.
  nas-setup.sh uses a plain `nofail` mount plus `pipulse-nas-remount.timer`, and
  restarts the hub (the sandbox only sees mounts that existed when it started).
  `ReadWritePaths=-/mnt/pipulse` has the `-` so a missing mount can't stop the hub.
- **A failed NAS job must not count as done.** In 0.4.0 the first start (NAS not
  mounted yet) recorded a failed mirror, and scheduling from that timestamp
  postponed the next try by a whole hour. The log looked clean, because NAS
  errors go to Events, not stdout. `Nas.due()` now retries failures after
  `RETRY` (10 min), and the backup schedules off `ok_at` (the last success).
- **`update.sh` runs from a copy in /run.** The upgrade replaces
  `/opt/pipulse-hub` while the script is running, and sh reads scripts
  incrementally.
- **The hub bundle must be deterministic** (gzip `mtime=0`, fixed owner and mode),
  or `/hub/SHA256SUMS` stops matching the tarball fetched a moment later.
- **Windows dev hub + NAS.** `check_dir` skips the mounted-share test on Windows
  (`os.name == "nt"`), so the dev hub can write to real `\\192.168.1.204\...` UNC
  paths. Tests set `PIPULSE_NAS_ALLOW_LOCAL=1` to use temp folders on Linux CI.
- **Shell heredocs mangle backslashes and quotes in patches** (Git Bash turned
  `\a` into a BEL character, and a Python heredoc with nested quotes wouldn't
  parse). Write patch scripts with the Write tool, as Linewatch learned too.
- **Screenshots go on GitHub, so nothing secret may be in them.** `tools/screenshots.js` blanks
  the install token to `<token>` before capturing. Run it against a throwaway hub: `subst N:` onto
  a scratch folder gives tidy `N:\...` paths in Settings and About, and `PIPULSE_DEMO_DATA` /
  `PIPULSE_DEMO_LINK_PORT` point the demo at that hub instead of `hub/data`.
- **WSL is the test Pi.** Ubuntu there has systemd. WSL stops its VM between
  `wsl` calls when idle, so put a multi-step test in one script and run it with
  one `wsl ... sh script`. Use ports 8760/8761 for a WSL hub so they don't clash
  with the PC dev hub.

## Roadmap

- Notifications through `NOTIFIERS`: ntfy, Home Assistant (MQTT discovery), email. The user chose all three.
- HTTPS for the dashboard. The user didn't want it yet, since it means trusting a cert on each device.
- Per-client keys (revoke one Pi). The user didn't want it yet; the shared token now only travels encrypted.
