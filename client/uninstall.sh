#!/bin/sh
# Removes the PiPulse Client. Service limits you set stay in place; clear them from
# the dashboard first, or delete /etc/systemd/system.control/<unit>.d/50-*.conf.
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
systemctl disable --now pipulse-client pipulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/pipulse-client.service /etc/systemd/system/pipulse-agent.service
rm -f /etc/pipulse/client.json /etc/pipulse/agent.json
rm -rf /opt/pipulse-client /opt/pipulse-agent
rmdir /etc/pipulse 2>/dev/null || true
systemctl daemon-reload
echo "PiPulse Client removed."
