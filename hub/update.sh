#!/bin/sh
# Runs as root via pipulse-hub-updater.service when the hub (which can't write its
# own files) drops update/request.json. Downloads that release's install-hub.sh,
# checks it against the release's SHA256SUMS, runs it, and leaves
# update/result.json for the hub to log. install.sh copies this script to /run
# before running it, because the upgrade replaces /opt/pipulse-hub under it.
set -u
DIR=/var/lib/pipulse/update
REQ=$DIR/request.json
RES=$DIR/result.json
LOG=$DIR/update.log
[ -f "$REQ" ] || exit 0
V=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$REQ" 2>/dev/null)
rm -f "$REQ"

result() {
  python3 -c 'import json, sys, time; json.dump({"version": sys.argv[1], "ok": sys.argv[2] == "1", "msg": sys.argv[3], "at": time.time()}, open(sys.argv[4], "w"))' \
    "$V" "$1" "$2" "$RES"
  chown pipulse:pipulse "$RES" "$LOG" 2>/dev/null
}

echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { result 0 "update refused: bad version '$V'"; exit 1; }
REPO=$(cat /opt/pipulse-hub/REPO 2>/dev/null || echo AxialForge/pipulse)
BASE="https://github.com/$REPO/releases/download/v$V"
PORT=$(sed -n 's/.* --port \([0-9]*\).*/\1/p' /etc/systemd/system/pipulse-hub.service | head -1)
T=$(mktemp -d)
{
  echo "== $(date) updating to $V from $BASE"
  curl -fsSL "$BASE/SHA256SUMS" -o "$T/SHA256SUMS" \
    && curl -fsSL "$BASE/install-hub.sh" -o "$T/install-hub.sh" \
    && (cd "$T" && grep ' install-hub.sh$' SHA256SUMS | sha256sum -c -) \
    && PIPULSE_PORT="${PORT:-8750}" PIPULSE_NONINTERACTIVE=1 sh "$T/install-hub.sh"
} > "$LOG" 2>&1
rc=$?
rm -rf "$T"
if [ $rc -eq 0 ]; then
  result 1 "hub updated to $V. Use 'Update all Pis' to bring the clients along."
else
  result 0 "hub update to $V failed: $(tail -n 3 "$LOG" | tr '\n' ' ')"
fi
