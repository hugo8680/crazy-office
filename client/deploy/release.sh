#!/bin/sh
# Run on the production host: release.sh /path/to/verified/dist 20261020-client-v4
set -eu
umask 022
[ "$#" -eq 2 ] || { echo 'Usage: release.sh <built-dist-directory> <release-id>' >&2; exit 2; }
source_dir=$(CDPATH= cd "$1" && pwd -P)
release_id=$2
case "$release_id" in ''|.|..|*[!A-Za-z0-9_.-]*) echo 'Invalid release id' >&2; exit 2;; esac
base=/opt/office.laisengou.com/client
release=$base/releases/$release_id
[ -f "$source_dir/index.html" ] && [ -f "$source_dir/asset-manifest.json" ] || { echo 'Missing client build output' >&2; exit 1; }
mkdir -p "$base/releases"
chmod 755 "$base" "$base/releases"
exec 9>"$base/.release.lock"
flock -n 9 || { echo 'Another client release is in progress' >&2; exit 1; }
[ ! -e "$release" ] && [ ! -L "$release" ] || { echo 'Release already exists' >&2; exit 1; }
[ ! -e "$base/current" ] || [ -L "$base/current" ] || { echo 'Client current must be a managed symlink' >&2; exit 1; }
nginx -t
stage=$base/releases/.staging-$release_id-$$
link=$base/.current.$$
trap 'rm -rf "$stage"; rm -f "$link"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$stage"
cp -R "$source_dir/." "$stage/"
find "$stage" -type d -exec chmod 755 {} \;
find "$stage" -type f -exec chmod 644 {} \;
mv -T "$stage" "$release"
if [ -L "$base/current" ]; then readlink "$base/current" > "$base/previous-release"; fi
ln -s "$release" "$link"
mv -Tf "$link" "$base/current"
echo "Client release: $release_id"
echo 'The Go service and persistent company data were not changed.'
