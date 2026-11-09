#!/bin/bash
# Package the local fork as a standalone, stably signed app.
#
# A stable Apple Development signature keeps macOS privacy grants (Full Disk
# Access and friends) across rebuilds; the ad-hoc signed dev runtime loses them
# every time. The app carries the fork environment in LSEnvironment, so Finder
# and Dock launches use the same data directory as local-fork.sh start.
#
# Usage: apps/desktop/scripts/t3-update.sh [--skip-update] [--install]
#   --skip-update  do not run local-fork.sh update first
#   --install      replace /Applications/T3 Code (Custom).app (keeps .prev);
#                  refused while the packaged app cannot read the dev data
#
# Works from a bare login shell: fork-env.sh puts node_modules/.bin (vp),
# node (mise/nvm) and cargo on PATH the same way for local-fork.sh.
set -euo pipefail
umask 022

repo=$(cd "$(dirname "$0")/../../.." && pwd -P)
cd "$repo"
state=$(git rev-parse --absolute-git-dir)
lock="$state/local-fork.lock"
data="$HOME/.t3-custom"
app_id=com.bamnenim.t3code.custom
product='T3 Code (Custom)'
identity=${T3CODE_SIGN_IDENTITY:-'Apple Development: Jungwoo Yun (8Q9B7566HL)'}
out="$repo/release/custom"
dest="/Applications/$product.app"

recover="cd $repo && apps/desktop/scripts/local-fork.sh build && apps/desktop/scripts/local-fork.sh start"
fail() {
  printf '%s\n' "$*" >&2
  printf 'Back to the dev-run app: %s\n' "$recover" >&2
  exit 1
}
. "$repo/apps/desktop/scripts/fork-env.sh"

skip_update=0
install=0
for arg in "$@"; do
  case "$arg" in
    --skip-update) skip_update=1 ;;
    --install) install=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) fail "Unknown option: $arg" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || fail 'macOS only.'
case "$identity" in 'Developer ID'*) fail 'Use the personal Apple Development identity, not a Developer ID.' ;; esac
security find-identity -v -p codesigning | grep -qF "\"$identity\"" ||
  fail "Signing identity not found in the keychain: $identity"

if [ "$skip_update" = 0 ]; then
  apps/desktop/scripts/local-fork.sh update ||
    fail 'local-fork.sh update failed. If the custom app is running, quit it and retry, or pass --skip-update.'
fi

[ -z "$(git status --porcelain)" ] || fail 'Commit or stash your changes before packaging.'

# Same lock as local-fork.sh: the build rewrites dist folders the dev-run app loads.
if ! mkdir "$lock" 2>/dev/null; then
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  case "$owner" in ''|*[!0-9]*) fail "Inspect stale lock manually: $lock" ;; esac
  kill -0 "$owner" 2>/dev/null && fail 'Custom app or maintenance is running. Quit it before packaging.'
  rm "$lock/pid"
  rmdir "$lock"
  mkdir "$lock" || fail 'Another process acquired the lock.'
fi
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT

# The shell may run under Rosetta; build for the hardware.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi
# node_modules/.bin (the build spawns `vp` by name), node, and cargo for the
# resource monitor (keg-only Homebrew rustup or ~/.cargo/bin).
fork_env
command -v node >/dev/null || fail 'node not found. Install it with mise (mise use -g node@22) or nvm, then retry.'
command -v vp >/dev/null || fail "vp not found in $repo/node_modules/.bin. Run apps/desktop/scripts/local-fork.sh build once to install dependencies."
command -v cargo >/dev/null || fail 'Install Rust (arch -arm64 brew install rustup; rustup default stable).'

unset VITE_DEV_SERVER_URL VITE_HTTP_URL VITE_WS_URL ELECTRON_RUN_AS_NODE
rm -rf "$out"
printf 'Packaging %s (%s) into %s\n' "$product" "$arch" "$out"
env \
  T3CODE_DESKTOP_APP_ID="$app_id" \
  T3CODE_DESKTOP_PRODUCT_NAME="$product" \
  T3CODE_LOCAL_FORK=1 \
  T3CODE_HOME="$data" \
  T3CODE_DISABLE_AUTO_UPDATE=true \
  T3CODE_DESKTOP_SIGNED=false \
  T3CODE_COMMIT_HASH="$(git rev-parse HEAD)" \
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch "$arch" --output-dir "$out"

app=$(find "$out" -maxdepth 2 -type d -name "$product.app" | head -n 1)
[ -n "$app" ] || fail "No $product.app under $out"

printf 'Signing with %s (approve keychain access if asked)\n' "$identity"
codesign --force --deep --timestamp=none --sign "$identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
printf 'Signed: %s\n' "$app"

# Launched from Finder or the Dock, the app only sees LSEnvironment. Without
# T3CODE_HOME it would open ~/.t3 and look empty.
plist="$app/Contents/Info.plist"
lsenv() { /usr/libexec/PlistBuddy -c "Print :LSEnvironment:$1" "$plist" 2>/dev/null || true; }
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = "$app_id" ] ||
  fail "Bundle identifier is not $app_id: $plist"
[ "$(lsenv T3CODE_HOME)" = "$data" ] || fail "LSEnvironment T3CODE_HOME is '$(lsenv T3CODE_HOME)', expected $data: $plist"
[ "$(lsenv T3CODE_LOCAL_FORK)" = 1 ] || fail "LSEnvironment T3CODE_LOCAL_FORK is not 1: $plist"
printf 'LSEnvironment: T3CODE_HOME=%s\n' "$data"

# Electron encrypts the connection catalog, saved secrets and cookies under
# $data with the "<app name> Safe Storage" keychain key. local-fork.sh start runs
# a bare Electron binary, so its key is "Electron Safe Storage"; the packaged app
# takes its name from app.asar's package.json. Different keys cannot decrypt each
# other's data, which shows up as an empty window ("No projects yet",
# "Connect to see limits").
packaged_name=$(node -e '
  const fs = require("fs");
  const fd = fs.openSync(process.argv[1], "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const size = head.readUInt32LE(12);
  const json = Buffer.alloc(size);
  fs.readSync(fd, json, 0, size, 16);
  const entry = JSON.parse(json.toString()).files["package.json"];
  const body = Buffer.alloc(entry.size);
  fs.readSync(fd, body, 0, entry.size, 8 + head.readUInt32LE(4) + Number(entry.offset));
  const pkg = JSON.parse(body.toString());
  process.stdout.write(pkg.productName || pkg.name);
' "$app/Contents/Resources/app.asar") || fail "Could not read the app name from $app/Contents/Resources/app.asar"
packaged_key="$packaged_name Safe Storage"
dev_key='Electron Safe Storage'
printf 'Safe storage key: packaged "%s", dev-run "%s"\n' "$packaged_key" "$dev_key"
key_mismatch=0
if [ "$packaged_key" != "$dev_key" ] && [ -d "$data/userdata" ] &&
  security find-generic-password -s "$dev_key" >/dev/null 2>&1; then
  key_mismatch=1
fi

if [ "$install" = 1 ]; then
  if [ "$key_mismatch" = 1 ]; then
    fail "Not installing: $data was written by the dev-run app with the \"$dev_key\" keychain key, but the packaged app uses \"$packaged_key\". It would open without projects or sign-in. /Applications was not changed."
  fi
  pgrep -f "$product.app/Contents/MacOS/" >/dev/null && fail "$product is running. Quit it before installing."
  rm -rf "$dest.prev"
  [ -e "$dest" ] && mv "$dest" "$dest.prev"
  ditto "$app" "$dest"
  codesign --verify --deep --strict "$dest"
  printf 'Installed: %s (previous copy: %s.prev)\n' "$dest" "$dest"
  printf 'Open it with: open "%s"\n' "$dest"
  printf 'Check that your projects and sign-in appear. If the window is empty, quit it and run:\n  %s\n' "$recover"
elif [ "$key_mismatch" = 1 ]; then
  printf 'Note: --install would be refused. This app uses "%s" and cannot read data the dev-run app wrote with "%s".\n' "$packaged_key" "$dev_key"
  printf 'Do not open %s against %s.\n' "$app" "$data"
fi
