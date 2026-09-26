#!/bin/sh
# PiPulse Hub installer: runs the hub on this Pi and installs a client so the hub
# Pi is monitored too. Re-run to upgrade; the database, password, token and
# certificate are kept, so existing clients carry on without changes.
#
# Env: PIPULSE_PORT (dashboard port, default below; link port = +1),
#      PIPULSE_NONINTERACTIVE=1 (skip questions; used by the dashboard updater).
set -e
SRC="__SRC__"
PORT="${PIPULSE_PORT:-__PORT__}"
LINK=$((PORT + 1))

[ "$(id -u)" = 0 ] || { echo "Run with sudo (… | sudo sh)"; exit 1; }
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
NEED=""
python3 -c 'import sqlite3, ssl' 2>/dev/null || NEED="$NEED python3"
command -v openssl >/dev/null || NEED="$NEED openssl"
command -v curl >/dev/null || NEED="$NEED curl"
[ -z "$NEED" ] || { apt-get update -qq && apt-get install -y -qq $NEED; }

id pipulse >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pipulse --shell /usr/sbin/nologin pipulse
# PiPulse 0.2 kept the hub in /opt/pipulse; its data in /var/lib/pipulse is imported on first start.
[ -f /opt/pipulse/hub/hub.py ] && rm -rf /opt/pipulse
mkdir -p /opt/pipulse-hub /var/lib/pipulse
TMP=$(mktemp -d)
fetch "$SRC/pipulse-hub.tar.gz" "$TMP/pipulse-hub.tar.gz"
if fetch "$SRC/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null; then
  (cd "$TMP" && grep ' pipulse-hub.tar.gz$' SHA256SUMS | sha256sum -c --quiet -) \
    || { echo "pipulse-hub.tar.gz failed its checksum; not installing."; rm -rf "$TMP"; exit 1; }
fi
# Replaced whole on every install or upgrade; the kit is Bracket's renderer, vendored.
rm -rf /opt/pipulse-hub/hub /opt/pipulse-hub/client /opt/pipulse-hub/kit
tar -xzf "$TMP/pipulse-hub.tar.gz" -C /opt/pipulse-hub --no-same-owner
rm -rf "$TMP"
chown -R pipulse:pipulse /var/lib/pipulse
chmod 700 /var/lib/pipulse

cat > /etc/systemd/system/pipulse-hub.service <<EOF
[Unit]
Description=PiPulse Hub (dashboard :$PORT, encrypted client link :$LINK)
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
User=pipulse
ExecStart=/usr/bin/python3 /opt/pipulse-hub/hub/hub.py --data /var/lib/pipulse --port $PORT --link-port $LINK
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=always
RestartSec=5
Nice=5
CPUQuota=25%
MemoryMax=160M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/pipulse -/mnt/pipulse

[Install]
WantedBy=multi-user.target
EOF

# Updates from the dashboard: the hub (unprivileged) drops update/request.json,
# and this root-owned path unit runs the updater.
cat > /etc/systemd/system/pipulse-hub-updater.path <<'EOF'
[Unit]
Description=Watch for PiPulse Hub update requests from the dashboard
[Path]
PathExists=/var/lib/pipulse/update/request.json
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/pipulse-hub-updater.service <<'EOF'
[Unit]
Description=Update the PiPulse Hub to the requested release
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'cp /opt/pipulse-hub/hub/update.sh /run/pipulse-update.sh && exec sh /run/pipulse-update.sh'
EOF
install -m 755 /opt/pipulse-hub/hub/pipulse-hub.sh /usr/local/bin/pipulse-hub
install -d -o pipulse -g pipulse -m 700 /var/lib/pipulse/update

systemctl daemon-reload
systemctl enable pipulse-hub pipulse-hub-updater.path >/dev/null 2>&1
systemctl restart pipulse-hub
systemctl restart pipulse-hub-updater.path

i=0
until fetch "http://127.0.0.1:$PORT/api/ping" /dev/null 2>/dev/null; do
  i=$((i + 1)); [ $i -lt 30 ] || { echo "The hub did not start. See: journalctl -u pipulse-hub"; exit 1; }
  sleep 1
done

# This Pi's own client talks to the hub over loopback, so it survives IP changes.
TOKEN=$(python3 -c 'import json, sqlite3; print(json.loads(sqlite3.connect("/var/lib/pipulse/pipulse.db").execute("SELECT value FROM settings WHERE key = ?", ("_token",)).fetchone()[0]))')
fetch "http://127.0.0.1:$PORT/client/install.sh?t=$TOKEN&local=1" /tmp/pipulse-client-install.sh
sh /tmp/pipulse-client-install.sh >/dev/null
rm -f /tmp/pipulse-client-install.sh

# Dashboard account: on a fresh interactive install, make the admin now. (Otherwise the first
# visit to the dashboard creates it. PiPulse 0.4's password carries over as "admin".)
HAS_ACCOUNT=$(python3 -c 'import json; print(1 if json.load(open("/var/lib/pipulse/web.json")).get("users") else 0)' 2>/dev/null || echo 0)
if [ "$HAS_ACCOUNT" = 0 ] && [ -z "${PIPULSE_NONINTERACTIVE:-}" ] && [ -r /dev/tty ]; then
  printf 'Create the dashboard admin account now? [Y/n]: ' > /dev/tty
  read -r A < /dev/tty || A=n
  case "$A" in
    n*|N*) echo "Skipped: the first visit to the dashboard creates it." ;;
    *) sudo -u pipulse python3 /opt/pipulse-hub/hub/hub.py --data /var/lib/pipulse --set-password --if-no-account < /dev/tty \
         && systemctl restart pipulse-hub ;;
  esac
fi

# NAS storage (mirror, archive, backups): offered once, on an interactive install.
if ! grep -q " /mnt/pipulse cifs " /etc/fstab && [ -z "${PIPULSE_NONINTERACTIVE:-}" ] && [ -r /dev/tty ]; then
  printf 'Connect the NAS now for log mirror/archive and nightly backups? [Y/n]: ' > /dev/tty
  read -r A < /dev/tty || A=n
  case "$A" in n*|N*) echo "Skipped. Later:  sudo pipulse-hub nas" ;; *) sh /opt/pipulse-hub/hub/nas-setup.sh || echo "NAS not connected (the hub works without it). Try again:  sudo pipulse-hub nas" ;; esac
fi

IP=$(hostname -I | awk '{print $1}')
echo
echo "PiPulse Hub $(cat /opt/pipulse-hub/VERSION) is running, and this Pi is being monitored."
echo "  Dashboard:     http://$IP:$PORT   (sign in as admin; behind Caddy: https://pipulse.home)"
echo "  Client link:   port $LINK, encrypted. Add Pis from  + Add a Pi."
echo "  Commands:      pipulse-hub (NAS, restore, set-password)   sudo pipulse (this Pi's client menu)"
