#!/bin/sh
# Connect the PiPulse Hub to the NAS:  sudo pipulse-hub nas
#
# Mounts the share at /mnt/pipulse (owned by the pipulse user) and creates the
# folders the hub writes to:
#   <share>/Local_APP_Tank/PiPulse          database mirror + archive of old data
#   <share>/Backup_Pool/PiPulse Backup      nightly backups
# The folder paths can be changed later in the dashboard (Settings > NAS storage).
# Asks for the NAS login once and keeps it in /etc/pipulse/nas.cred (root only).
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
MOUNT=/mnt/pipulse
CREDS=/etc/pipulse/nas.cred
TTY=/dev/tty
ask() { printf '%s' "$1" > "$TTY"; read -r REPLY < "$TTY"; }

command -v mount.cifs >/dev/null || { apt-get update -qq && apt-get install -y -qq cifs-utils; }

SHARE=$(awk -v m="$MOUNT" '$2==m && $3=="cifs" {print $1}' /etc/fstab)
if [ -z "$SHARE" ]; then
  ask "NAS share [//192.168.1.204/Apocrypha_Main_Pool]: "
  SHARE=${REPLY:-//192.168.1.204/Apocrypha_Main_Pool}
fi

mkdir -p /etc/pipulse
if [ ! -f "$CREDS" ]; then
  if [ -f /etc/linewatch-cifs.cred ]; then
    ask "Use the same NAS login as Linewatch? [Y/n]: "
    case "$REPLY" in n*|N*) ;; *) cp /etc/linewatch-cifs.cred "$CREDS" ;; esac
  fi
  if [ ! -f "$CREDS" ]; then
    ask "NAS username: "; U=$REPLY
    stty -echo < "$TTY"; ask "NAS password: "; P=$REPLY; stty echo < "$TTY"; echo > "$TTY"
    ( umask 077; printf 'username=%s\npassword=%s\n' "$U" "$P" > "$CREDS" )
  fi
  chmod 600 "$CREDS"
fi

UID_N=$(id -u pipulse); GID_N=$(id -g pipulse)
# No automount: the hub runs in a sandboxed mount namespace, where triggering an
# automount is unreliable. A plain nofail mount plus a retry timer (below) instead.
LINE="$SHARE $MOUNT cifs credentials=$CREDS,uid=$UID_N,gid=$GID_N,file_mode=0660,dir_mode=0770,vers=3.0,iocharset=utf8,_netdev,nofail 0 0"
mkdir -p "$MOUNT"
if grep -qF " $MOUNT cifs " /etc/fstab; then sed -i "\| $MOUNT cifs |c\\$LINE" /etc/fstab; else echo "$LINE" >> /etc/fstab; fi
systemctl daemon-reload
mountpoint -q "$MOUNT" && umount "$MOUNT" || true
mount "$MOUNT" || { echo "Mount failed. Check the login in $CREDS, then: dmesg | tail"; exit 1; }

for d in "Local_APP_Tank/PiPulse" "Backup_Pool/PiPulse Backup"; do
  sudo -u pipulse mkdir -p "$MOUNT/$d" && sudo -u pipulse touch "$MOUNT/$d/.pipulse-write-test" \
    && rm -f "$MOUNT/$d/.pipulse-write-test" && echo "  writable: $SHARE/$d" \
    || { echo "  NOT writable: $SHARE/$d (check that NAS user's permissions)"; exit 1; }
done

# If the NAS was asleep at boot, the nofail mount gave up; retry every 10 minutes.
cat > /etc/systemd/system/pipulse-nas-remount.service <<EOF
[Unit]
Description=Remount the PiPulse NAS share if it dropped
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'mountpoint -q $MOUNT || mount $MOUNT'
EOF
cat > /etc/systemd/system/pipulse-nas-remount.timer <<'EOF'
[Unit]
Description=Retry the PiPulse NAS mount every 10 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now pipulse-nas-remount.timer >/dev/null 2>&1
# The hub's sandbox only sees mounts that existed when it started.
systemctl restart pipulse-hub 2>/dev/null || true
echo "NAS connected at $MOUNT. Mirror, archive and nightly backups are on (see the dashboard's Settings)."
