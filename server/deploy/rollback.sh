#!/bin/sh
# Pause new jobs and wait for active work before invoking this script.
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: rollback.sh <existing-Go-release-id>' >&2; exit 2; }
case "$1" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Invalid release id' >&2; exit 2;; esac
base=/opt/office.laisengou.com/server
release=$base/releases/$1
[ -d "$release" ] && [ ! -L "$release" ] && [ -x "$release/office-api" ] || { echo 'Unknown Go release' >&2; exit 1; }
exec 9>"$base/.release.lock"
flock -n 9 || { echo 'Another server release is in progress' >&2; exit 1; }
[ ! -e "$base/current" ] || [ -L "$base/current" ] || { echo 'Server current must be a managed symlink' >&2; exit 1; }
if systemctl is-active --quiet office-lab; then echo 'Stop the old Node service before starting Go against the same data.' >&2; exit 1; fi
link=$base/.current.$$
trap 'rm -f "$link"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ln -s "$release" "$link"
mv -Tf "$link" "$base/current"
systemctl restart office-api
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl --silent --show-error --fail --max-time 3 -o /dev/null -H 'Host: office.laisengou.com' http://127.0.0.1:8080/api/livez; then healthy=1; break; fi
    sleep 1
done
[ "$healthy" -eq 1 ] || { echo 'Rollback selected, but the API health check failed; keep work paused.' >&2; exit 1; }
echo "Server rollback: $1"
echo 'Persistent data was preserved; no database backup was restored over live business data.'
