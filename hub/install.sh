#!/bin/sh
# PiPulse Hub installer: runs the hub on this Pi and installs a client so the hub
# Pi is monitored too. Re-run to upgrade; the database, password, token and
# certificate are kept, so existing clients carry on without changes.
set -e
SRC="__SRC__"
PORT="__PORT__"
LINK=$((PORT + 1))

[ "$(id -u)" = 0 ] || { echo "Run with sudo (… | sudo sh)"; exit 1; }
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
NEED=""
python3 -c 'import sqlite3, ssl' 2>/dev/null || NEED="$NEED python3"
command -v openssl >/dev/null || NEED="$NEED openssl"
[ -z "$NEED" ] || { apt-get update -qq && apt-get install -y -qq $NEED; }

id pipulse >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pipulse --shell /usr/sbin/nologin pipulse
# PiPulse 0.2 kept the hub in /opt/pipulse; its data in /var/lib/pipulse is imported on first start.
[ -f /opt/pipulse/hub/hub.py ] && rm -rf /opt/pipulse
mkdir -p /opt/pipulse-hub /var/lib/pipulse
TMP=$(mktemp)
fetch "$SRC/pipulse-hub.tar.gz" "$TMP"
rm -rf /opt/pipulse-hub/hub /opt/pipulse-hub/client
tar -xzf "$TMP" -C /opt/pipulse-hub --no-same-owner
rm -f "$TMP"
chown -R pipulse:pipulse /var/lib/pipulse
chmod 700 /var/lib/pipulse

cat > /etc/systemd/system/pipulse-hub.service <<EOF
[Unit]
Description=PiPulse Hub (dashboard :$PORT, encrypted client link :$LINK)
After=network-online.target
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
ReadWritePaths=/var/lib/pipulse

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pipulse-hub >/dev/null 2>&1
systemctl restart pipulse-hub

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

IP=$(hostname -I | awk '{print $1}')
echo
echo "PiPulse Hub is running, and this Pi is being monitored."
echo "  Dashboard:     http://$IP:$PORT   (first visit: create your password)"
echo "  Client link:   port $LINK, encrypted. Clients install from  + Add a Pi."
echo "  Forgot the password?  sudo -u pipulse python3 /opt/pipulse-hub/hub/hub.py --data /var/lib/pipulse --set-password"
