#!/bin/sh
# Removes the PiPulse Hub and this Pi's client. Add --purge to also delete the
# database, certificate and settings (every client would then need reinstalling).
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
systemctl disable --now pipulse-hub pipulse-client pipulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/pipulse-hub.service /etc/systemd/system/pipulse-client.service /etc/systemd/system/pipulse-agent.service
rm -f /etc/pipulse/client.json /etc/pipulse/agent.json
rm -rf /opt/pipulse-hub /opt/pipulse-client /opt/pipulse-agent /opt/pipulse
rmdir /etc/pipulse 2>/dev/null || true
systemctl daemon-reload
if [ "$1" = "--purge" ]; then
  rm -rf /var/lib/pipulse
  userdel pipulse 2>/dev/null || true
  echo "PiPulse Hub removed, data deleted."
else
  echo "PiPulse Hub removed. Data kept in /var/lib/pipulse (reinstall picks it up)."
fi
