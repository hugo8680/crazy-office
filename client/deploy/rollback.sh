#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: rollback.sh <release-id>' >&2; exit 2; }
case "$1" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Invalid release id' >&2; exit 2;; esac
base=/opt/office.laisengou.com/client
release=$base/releases/$1
[ -d "$release" ] && [ ! -L "$release" ] && [ -f "$release/index.html" ] && [ -f "$release/asset-manifest.json" ] || { echo 'Unknown client release' >&2; exit 1; }
exec 9>"$base/.release.lock"
flock -n 9 || { echo 'Another client release is in progress' >&2; exit 1; }
[ ! -e "$base/current" ] || [ -L "$base/current" ] || { echo 'Client current must be a managed symlink' >&2; exit 1; }
nginx -t
link=$base/.current.$$
trap 'rm -f "$link"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ln -s "$release" "$link"
mv -Tf "$link" "$base/current"
echo "Client rollback: $1"
