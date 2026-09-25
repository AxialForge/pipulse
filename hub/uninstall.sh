#!/bin/sh
# Removes the PiPulse Hub and this Pi's client. Add --purge to also delete the
# database, certificate and settings (every client would then need reinstalling)
# and the NAS mount. Files already on the NAS (mirror, archive, backups) are
# never touched.
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
systemctl disable --now pipulse-hub pipulse-hub-updater.path pipulse-client pipulse-agent 2>/dev/null || true
rm -f /etc/systemd/system/pipulse-hub.service /etc/systemd/system/pipulse-hub-updater.path \
      /etc/systemd/system/pipulse-hub-updater.service /etc/systemd/system/pipulse-client.service \
      /etc/systemd/system/pipulse-agent.service /usr/local/bin/pipulse-hub /usr/local/bin/pipulse
rm -f /etc/pipulse/client.json /etc/pipulse/agent.json
rm -rf /opt/pipulse-hub /opt/pipulse-client /opt/pipulse-agent /opt/pipulse
if [ "$1" = "--purge" ]; then
  systemctl disable --now pipulse-nas-remount.timer 2>/dev/null || true
  rm -f /etc/systemd/system/pipulse-nas-remount.service /etc/systemd/system/pipulse-nas-remount.timer
  mountpoint -q /mnt/pipulse && umount /mnt/pipulse || true
  sed -i '\| /mnt/pipulse cifs |d' /etc/fstab
  rm -f /etc/pipulse/nas.cred
  rmdir /mnt/pipulse 2>/dev/null || true
fi
rmdir /etc/pipulse 2>/dev/null || true
systemctl daemon-reload
if [ "$1" = "--purge" ]; then
  rm -rf /var/lib/pipulse
  userdel pipulse 2>/dev/null || true
  echo "PiPulse Hub removed, data deleted. (Nothing on the NAS was touched.)"
else
  echo "PiPulse Hub removed. Data kept in /var/lib/pipulse (reinstall picks it up)."
fi
