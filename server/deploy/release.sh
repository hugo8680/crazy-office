#!/bin/sh
# Caller must pause scheduling, finish/cancel active tasks, and verify a backup first.
set -eu
umask 022
[ "$#" -eq 2 ] || { echo 'Usage: release.sh <verified-artifact-directory> <release-id>' >&2; exit 2; }
source_dir=$(CDPATH= cd "$1" && pwd -P)
release_id=$2
case "$release_id" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Invalid release id' >&2; exit 2;; esac
base=/opt/office.laisengou.com/server
release=$base/releases/$release_id
[ -f "$source_dir/office-api" ] && [ -f "$source_dir/import-roster" ] && [ -f "$source_dir/SHA256SUMS" ] && [ -f "$source_dir/RELEASE" ] && [ -d "$source_dir/data" ] && [ -d "$source_dir/config" ] || { echo 'Missing verified Go release output' >&2; exit 1; }
mkdir -p "$base/releases"
chmod 755 "$base" "$base/releases"
exec 9>"$base/.release.lock"
flock -n 9 || { echo 'Another server release is in progress' >&2; exit 1; }
[ ! -e "$release" ] && [ ! -L "$release" ] || { echo 'Release already exists' >&2; exit 1; }
[ ! -e "$base/current" ] || [ -L "$base/current" ] || { echo 'Server current must be a managed symlink' >&2; exit 1; }
if systemctl is-active --quiet office-lab; then
    echo 'The old Node service is still active. Complete the migration preflight and stop it before starting Go against the same data.' >&2
    exit 1
fi
(cd "$source_dir" && sha256sum -c SHA256SUMS)
stage=$base/releases/.staging-$release_id-$$
link=$base/.current.$$
trap 'rm -rf "$stage"; rm -f "$link"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$stage"
install -m 755 "$source_dir/office-api" "$stage/office-api"
install -m 755 "$source_dir/import-roster" "$stage/import-roster"
cp -R "$source_dir/data" "$source_dir/config" "$stage/"
cp "$source_dir/RELEASE" "$source_dir/SHA256SUMS" "$stage/"
find "$stage/data" "$stage/config" -type d -exec chmod 755 {} \;
find "$stage/data" "$stage/config" -type f -exec chmod 644 {} \;
mv -T "$stage" "$release"
previous=
if [ -L "$base/current" ]; then previous=$(cd "$base/current" && pwd -P); printf '%s\n' "$previous" > "$base/previous-release"; fi
ln -s "$release" "$link"
mv -Tf "$link" "$base/current"
healthy=0
if systemctl restart office-api; then
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if curl --silent --show-error --fail --max-time 3 -o /dev/null -H 'Host: office.laisengou.com' http://127.0.0.1:8080/api/livez; then healthy=1; break; fi
        sleep 1
    done
fi
if [ "$healthy" -ne 1 ]; then
    echo 'Health check failed.' >&2
    if [ -n "$previous" ] && [ -x "$previous/office-api" ]; then
        ln -s "$previous" "$link"
        mv -Tf "$link" "$base/current"
        systemctl restart office-api
        echo 'The previous Go release was restored; verify its health before resuming work.' >&2
    else
        systemctl stop office-api
        echo 'Go service stopped. Restore the previous site and office-lab service using the migration runbook.' >&2
    fi
    exit 1
fi
echo "Server release: $release_id"
echo 'Client files, office.env, and the persistent company directory were not replaced.'
