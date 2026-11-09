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
#   --install      replace /Applications/T3 Code (Custom).app (keeps .prev)
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

fail() { printf '%s\n' "$*" >&2; exit 1; }

skip_update=0
install=0
for arg in "$@"; do
  case "$arg" in
    --skip-update) skip_update=1 ;;
    --install) install=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
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
# The resource monitor needs cargo: rustup's ~/.cargo/bin or keg-only Homebrew rustup.
for dir in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
  if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
done
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

if [ "$install" = 1 ]; then
  pgrep -f "$product.app/Contents/MacOS/" >/dev/null && fail "$product is running. Quit it before installing."
  rm -rf "$dest.prev"
  [ -e "$dest" ] && mv "$dest" "$dest.prev"
  ditto "$app" "$dest"
  codesign --verify --deep --strict "$dest"
  printf 'Installed: %s (previous copy: %s.prev)\n' "$dest" "$dest"
fi
