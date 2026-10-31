#!/bin/sh
# The release archive checksum authenticates this installer and SHA256SUMS.
# File checksums protect the staged bytes; no system Node or service is needed.
set -eu
umask 077
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1"; }
  check() { sha256sum -c SHA256SUMS; }
elif command -v shasum >/dev/null 2>&1; then
  hash() { shasum -a 256 "$1"; }
  check() { shasum -a 256 -c SHA256SUMS; }
else
  echo 'SHA256 verifier missing (sha256sum or shasum required)' >&2
  exit 1
fi
verify() (
  cd "$1"
  [ -f SHA256SUMS ] && [ ! -L SHA256SUMS ]
  # No absolute/traversal/escaped names, duplicate records, or special files.
  awk '
    length($1) != 64 || $1 ~ /[^0-9a-f]/ { exit 1 }
    NF != 2 || $2 !~ /^[A-Za-z0-9_.\/@+-]+$/ { exit 1 }
    $2 ~ /^\// || $2 ~ /(^|\/)\.\.?($|\/)/ || $2 ~ /\/\// { exit 1 }
    $2 == "SHA256SUMS" || seen[$2]++ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' SHA256SUMS
  [ -z "$(find . ! -type f ! -type d -print)" ]
  [ "$(find . -type f | wc -l | tr -d ' ')" = "$(($(wc -l < SHA256SUMS) + 1))" ]
  check
  for executable in bin/node bin/pi-host bin/pi-desktop-host-core install.sh; do
    [ -x "$executable" ]
  done
  [ -f pi-host.js ]
)
if [ "${1:-}" = "--verify" ]; then
  verify "$source_dir"
  exit 0
fi
root=${PI_HOST_INSTALL_DIR:-$HOME/.pi-desktop/pi-host}
mkdir -p "$root"
root=$(CDPATH= cd -- "$root" && pwd -P)
# Linux locks are kernel-owned and release on crashes; no stale PID takeover.
if [ "$(uname -s)" = "Linux" ]; then
  command -v flock >/dev/null 2>&1 || { echo 'flock is required on Linux' >&2; exit 1; }
  exec 8>"$root/.install.lock"
  flock -w 120 8 || { echo 'Another install is active' >&2; exit 1; }
  lock=$(mktemp -d "$root/.install.XXXXXXXX")
else
  lock="$root/.install-lock"
  mkdir "$lock" || { echo 'Another install is active' >&2; exit 1; }
fi
stage=
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage"
  rm -rf "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "$root/.stage.XXXXXXXX")
cp -R "$source_dir"/. "$stage"/
verify "$stage"
digest=$(hash "$stage/SHA256SUMS")
digest=${digest%% *}
version="$root/sha256-$digest"
if [ -e "$version" ] || [ -L "$version" ]; then
  [ -d "$version" ] && [ ! -L "$version" ]
  verify "$version"
  cmp "$stage/SHA256SUMS" "$version/SHA256SUMS"
else
  mv "$stage" "$version"
  stage=
fi
# Refuse a legacy real directory, then rename a new symlink atomically. Unlike
# ln -sfn or portable mv, rename never follows an existing directory symlink.
[ ! -e "$root/current" ] || [ -L "$root/current" ]
ln -s "$version" "$lock/current"
NODE_OPTIONS= NODE_PATH= "$version/bin/node" --input-type=module -e 'import { renameSync } from "node:fs"; renameSync(process.argv[1], process.argv[2]);' "$lock/current" "$root/current"
echo "PI_HOST_INSTALLED $version"
