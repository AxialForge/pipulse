#!/bin/sh
# Restore a PiPulse Hub backup:  sudo pipulse-hub restore <pipulse-backup-....tar.gz>
# Puts back the database (settings, Pis, history, events) and the hub's certificate
# and key, so clients keep trusting it. The current data is moved aside first,
# not deleted.
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
F="$1"
[ -f "$F" ] || { echo "Usage: sudo pipulse-hub restore <backup .tar.gz>  (backups are in the NAS backup folder)"; exit 1; }
for want in pipulse.db hub-cert.pem hub-key.pem; do
  tar -tzf "$F" | grep -qx "$want" || { echo "$F is not a PiPulse backup (no $want)"; exit 1; }
done
DATA=/var/lib/pipulse
ASIDE="$DATA/pre-restore-$(date +%Y%m%d-%H%M%S)"
systemctl stop pipulse-hub
mkdir -p "$ASIDE"
for f in pipulse.db pipulse.db-wal pipulse.db-shm hub-cert.pem hub-key.pem; do
  [ -e "$DATA/$f" ] && mv "$DATA/$f" "$ASIDE/"
done
tar -xzf "$F" -C "$DATA" pipulse.db hub-cert.pem hub-key.pem
chown -R pipulse:pipulse "$DATA"
chmod 600 "$DATA/hub-key.pem"
systemctl start pipulse-hub
echo "Restored from $(basename "$F"). The previous data is in $ASIDE."
