#!/bin/sh
# `pipulse-hub`: hub housekeeping from the command line (installed to /usr/local/bin).
H=/opt/pipulse-hub/hub
case "$1" in
  status)
    systemctl --no-pager status pipulse-hub pipulse-client | head -n 20 ;;
  nas)
    exec sudo sh "$H/nas-setup.sh" ;;
  backup)
    echo "Use the dashboard: Settings > NAS storage > Back up now (or wait for the nightly backup)." ;;
  restore)
    shift; exec sudo sh "$H/restore.sh" "$@" ;;
  set-password)
    exec sudo -u pipulse python3 "$H/hub.py" --data /var/lib/pipulse --set-password ;;
  log)
    exec journalctl -u pipulse-hub -n 60 --no-pager ;;
  update-log)
    exec sudo cat /var/lib/pipulse/update/update.log ;;
  *)
    cat <<'EOF'
pipulse-hub <command>
  status          hub and local client service status
  nas             connect (or reconnect) the NAS for mirror, archive and backups
  restore FILE    restore a backup .tar.gz (moves current data aside first)
  set-password    reset the dashboard password
  log             recent hub log
  update-log      log of the last update from the dashboard
EOF
    ;;
esac
