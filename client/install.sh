#!/bin/sh
# PiPulse Client installer. Your hub serves this with its address, token and
# certificate fingerprint filled in:  + Add a Pi  on the dashboard shows the command.
# Re-run it to reinstall or repair.
set -e
HOST="__HOST__"
WEB="__WEB__"
PORT="__LINK_PORT__"
TOKEN="__TOKEN__"
PIN="__PIN__"
SHA="__SHA256__"
VERSION="__VERSION__"

[ "$(id -u)" = 0 ] || { echo "Run with sudo (… | sudo sh)"; exit 1; }
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
command -v python3 >/dev/null || { apt-get update -qq && apt-get install -y -qq python3; }

# PiPulse 0.1/0.2 called the client "the agent".
if [ -f /etc/systemd/system/pipulse-agent.service ]; then
  systemctl disable --now pipulse-agent 2>/dev/null || true
  rm -f /etc/systemd/system/pipulse-agent.service /etc/pipulse/agent.json /opt/pipulse/agent.py
  rm -rf /opt/pipulse-agent
fi

mkdir -p /opt/pipulse-client /etc/pipulse
fetch "$WEB/client/client.py" /opt/pipulse-client/client.py.new
echo "$SHA  /opt/pipulse-client/client.py.new" | sha256sum -c --quiet - \
  || { echo "The client download was corrupted; try again."; rm -f /opt/pipulse-client/client.py.new; exit 1; }
mv /opt/pipulse-client/client.py.new /opt/pipulse-client/client.py

umask 077
cat > /etc/pipulse/client.json <<EOF
{"hub": "$HOST", "port": $PORT, "token": "$TOKEN", "pin": "$PIN", "interval": 5}
EOF
umask 022

cat > /etc/systemd/system/pipulse-client.service <<'EOF'
[Unit]
Description=PiPulse Client (reports this Pi to the PiPulse Hub)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 /opt/pipulse-client/client.py
Environment=PYTHONDONTWRITEBYTECODE=1
Restart=always
RestartSec=10
# The monitor must never be the thing that starves the Pi.
Nice=10
CPUQuota=10%
MemoryMax=48M

[Install]
WantedBy=multi-user.target
EOF

if ! python3 /opt/pipulse-client/client.py --check; then
  echo "Installed, but the hub can't be reached at https://$HOST:$PORT yet."
  echo "The client will keep retrying. Check that port $PORT is open on the hub."
fi
systemctl daemon-reload
systemctl enable pipulse-client >/dev/null 2>&1
systemctl restart pipulse-client
echo "PiPulse Client $VERSION installed. $(hostname) reports to $HOST over an encrypted link."
