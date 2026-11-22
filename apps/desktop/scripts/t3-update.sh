#!/bin/bash
# Package the local fork as a standalone, stably signed app.
#
# A stable Apple Development signature keeps macOS privacy grants (Full Disk
# Access and friends) across rebuilds; the ad-hoc signed dev runtime loses them
# every time. The app carries the fork environment in LSEnvironment, so Finder
# and Dock launches use the same data directory as local-fork.sh start.
#
# Usage: apps/desktop/scripts/t3-update.sh [--skip-update] | --install | --rollback | --back-to-dev
#   (default)      local-fork.sh update, then package and sign into release/custom.
#                  The installed app keeps running, so an agent inside it can do this.
#   --skip-update  package the current checkout without local-fork.sh update
#   --install      with the app quit: back up userdata, then replace
#                  /Applications/T3 Code (Custom).app with the packaged one (keeps .prev)
#   --rollback     with the app quit: put .prev back (data is not restored)
#   --back-to-dev  restore the dev-run connection catalog backup, then print
#                  how to start the dev-run app again
#
# Safe storage: the packaged app is named "T3 Code (Custom)" and encrypts with
# the "T3 Code (Custom) Safe Storage" keychain key; local-fork.sh start runs a
# bare Electron binary that uses "Electron Safe Storage". On its first launch the
# packaged app reads the old key once (macOS asks to allow access to "Electron
# Safe Storage"), re-encrypts userdata/connection-catalog.json with its own key
# and keeps the original as connection-catalog.json.bak-<time>. The dev run
# cannot read the re-encrypted file; --back-to-dev puts the backup back.
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
catalog="$data/userdata/connection-catalog.json"
fail() {
  printf '%s\n' "$*" >&2
  printf 'Back to the dev-run app: %s\n' "$recover" >&2
  exit 1
}
. "$repo/apps/desktop/scripts/fork-env.sh"

# The bundle name has parentheses: escape them, or pgrep reads a regex group and never matches.
app_pattern="/Applications/T3 Code \(Custom\)\.app/Contents/MacOS/"
running() {
  local rc=0
  pgrep -f "$app_pattern" >/dev/null || rc=$?
  case "$rc" in 0) return 0 ;; 1) return 1 ;; *) fail "Could not check whether $product is running." ;; esac
}
# Locks are mkdir directories holding the owner's pid. The checkout lock (same as
# local-fork.sh, also held by a dev run) guards release/custom; the shared lock in the
# data directory guards the installed bundle and userdata across checkouts.
held_locks=()
release_locks() {
  local l
  for l in ${held_locks[@]+"${held_locks[@]}"}; do rm -f "$l/pid"; rmdir "$l" 2>/dev/null || true; done
}
trap release_locks EXIT
take_lock() {
  local l=$1 owner
  if ! mkdir "$l" 2>/dev/null; then
    owner=$(cat "$l/pid" 2>/dev/null || true)
    case "$owner" in ''|*[!0-9]*) fail "Inspect stale lock manually: $l" ;; esac
    kill -0 "$owner" 2>/dev/null && fail 'A local-fork.sh dev run or another update is running. Quit it and retry.'
    rm "$l/pid"
    rmdir "$l"
    mkdir "$l" || fail 'Another process acquired the lock.'
  fi
  printf '%s\n' "$$" > "$l/pid"
  held_locks+=("$l")
}
take_install_lock() {
  [ -d "$data" ] || (umask 077 && mkdir -p "$data")
  take_lock "$data/app-install.lock"
}
# Reads a field of the package.json inside an app bundle's app.asar.
asar_field() {
  node -e '
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
    process.stdout.write(String(JSON.parse(body.toString())[process.argv[2]] ?? ""));
  ' "$1/Contents/Resources/app.asar" "$2"
}

mode=package
skip_update=0
for arg in "$@"; do
  case "$arg" in
    --skip-update) skip_update=1 ;;
    --install|--rollback|--back-to-dev)
      [ "$mode" = package ] || fail "Use only one of --install, --rollback, --back-to-dev."
      mode=${arg#--} ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) fail "Unknown option: $arg" ;;
  esac
done
[ "$mode" = package ] || [ "$skip_update" = 0 ] || fail "--skip-update only applies to packaging."

# Moves the packaged app's catalog aside (never deletes it) and restores the
# newest dev-run backup. Connections changed in the packaged app since the
# backup are only in the moved-aside file.
if [ "$mode" = back-to-dev ]; then
  running && fail "$product is running. Quit it first."
  latest=$(ls -t "$catalog".bak-* 2>/dev/null | head -n 1 || true)
  if [ -z "$latest" ]; then
    printf 'No %s.bak-* backup: the packaged app never migrated, dev data is unchanged.\n' "$catalog"
  else
    aside="$catalog.custom-$(date +%Y%m%dT%H%M%S)"
    [ -e "$catalog" ] && mv "$catalog" "$aside" && printf 'Moved the packaged app catalog to %s\n' "$aside"
    cp -p "$latest" "$catalog"
    printf 'Restored %s\n' "$latest"
  fi
  printf 'Start the dev-run app: %s\n' "$recover"
  exit 0
fi

if [ "$mode" = install ]; then
  take_lock "$lock"
  take_install_lock
  running && fail "$product is running. Quit it (Cmd-Q) before installing."
  [ -f "$out/commit" ] || fail "Nothing packaged under $out. Run $0 first."
  commit=$(cat "$out/commit")
  app="$out/$(cat "$out/app" 2>/dev/null || true)"
  [ "$app" != "$out/" ] && [ -d "$app" ] || fail "Packaged app missing under $out. Run $0 again."
  git merge-base --is-ancestor "$commit" refs/remotes/origin/custom/local 2>/dev/null ||
    fail "Packaged commit $commit is not on origin/custom/local. Package an approved commit."
  codesign --verify --deep --strict "$app"
  embedded=$(asar_field "$app" t3codeCommitHash) || fail "Could not read the commit inside $app."
  [ -n "$embedded" ] && [ "${commit#"$embedded"}" != "$commit" ] ||
    fail "The packaged app was built from '$embedded', not $commit. Run $0 again."
  if [ -d "$dest" ] && [ "$(asar_field "$dest" t3codeCommitHash 2>/dev/null || true)" = "$embedded" ]; then
    printf '%s is already installed at %s.\n' "$commit" "$dest"
    exit 0
  fi
  if [ -d "$data/userdata" ]; then
    [ "$(cd "$data" && pwd -P)" = "$data" ] || fail 'Custom data directory must not be a symlink.'
    (umask 077 && mkdir -p "$HOME/.t3-custom-backups")
    archive="$HOME/.t3-custom-backups/$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:10}-userdata.tgz"
    (umask 077 && tar -czf "$archive.partial" -C "$data" userdata)
    mv "$archive.partial" "$archive"
    printf 'Data backup: %s\n' "$archive"
  fi
  # Copy and verify next to the destination first, and keep the older .prev until the new
  # app is in place, so any failed step leaves a working app at the launch path.
  rm -rf "$dest.new" "$dest.prev.old"
  ditto "$app" "$dest.new"
  codesign --verify --deep --strict "$dest.new"
  [ -e "$dest.prev" ] && mv "$dest.prev" "$dest.prev.old"
  if [ -e "$dest" ] && ! mv "$dest" "$dest.prev"; then
    [ -e "$dest.prev.old" ] && mv "$dest.prev.old" "$dest.prev"
    fail "Could not move the current app aside; nothing was replaced."
  fi
  if ! mv "$dest.new" "$dest"; then
    [ -e "$dest.prev" ] && mv "$dest.prev" "$dest"
    [ -e "$dest.prev.old" ] && mv "$dest.prev.old" "$dest.prev"
    fail "Could not put the new app in place; the current app is back."
  fi
  rm -rf "$dest.prev.old"
  printf 'Installed %s at %s (previous copy: %s.prev)\n' "$commit" "$dest" "$dest"
  if [ -f "$catalog" ] && ! ls "$catalog".bak-* >/dev/null 2>&1; then
    printf 'First launch migrates your connections: when macOS asks to use "Electron Safe Storage", click Allow.\n'
  fi
  printf 'Open it: open "%s"\nIf it misbehaves, quit it and run: %s --rollback\n' "$dest" "$0"
  exit 0
fi

if [ "$mode" = rollback ]; then
  take_install_lock
  running && fail "$product is running. Quit it (Cmd-Q) before rolling back."
  [ -d "$dest.prev" ] || fail "No previous copy at $dest.prev."
  codesign --verify --deep --strict "$dest.prev"
  aside="$dest.rolled-back-$(date +%Y%m%dT%H%M%S)"
  [ -e "$dest" ] && mv "$dest" "$aside"
  if ! mv "$dest.prev" "$dest"; then
    [ -e "$aside" ] && mv "$aside" "$dest"
    fail "Could not restore $dest.prev; the current app is back in place."
  fi
  printf 'Restored the previous app. The replaced one is at %s.\n' "$aside"
  printf 'Data was not restored. If the newer build migrated it, restore the matching %s archive with the app quit.\n' "$HOME/.t3-custom-backups/*-userdata.tgz"
  printf 'Open it: open "%s"\n' "$dest"
  exit 0
fi

# Held from here through publishing, so an install never reads a half-written package.
take_lock "$lock"
# A failed run below must not leave an older package that --install would accept.
rm -f "$out/commit"
[ "$(uname -s)" = Darwin ] || fail 'macOS only.'
case "$identity" in 'Developer ID'*) fail 'Use the personal Apple Development identity, not a Developer ID.' ;; esac
security find-identity -v -p codesigning | grep -qF "\"$identity\"" ||
  fail "Signing identity not found in the keychain: $identity"

if [ "$skip_update" = 0 ]; then
  LOCAL_FORK_LOCK_OWNER=$$ apps/desktop/scripts/local-fork.sh update ||
    fail 'local-fork.sh update failed; see the message above.'
fi

[ -z "$(git status --porcelain)" ] || fail 'Commit or stash your changes before packaging.'

# The shell may run under Rosetta; build for the hardware.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi
# node_modules/.bin (the build spawns `vp` by name), node, and cargo for the
# resource monitor (keg-only Homebrew rustup or ~/.cargo/bin).
fork_env
command -v node >/dev/null || fail 'node not found. Install it with mise (mise use -g node@22) or nvm, then retry.'
command -v vp >/dev/null || fail "vp not found in $repo/node_modules/.bin. Run apps/desktop/scripts/local-fork.sh build once to install dependencies."
command -v cargo >/dev/null || fail 'Install Rust (arch -arm64 brew install rustup; rustup default stable).'

unset VITE_DEV_SERVER_URL VITE_HTTP_URL VITE_WS_URL ELECTRON_RUN_AS_NODE T3CODE_DESKTOP_SKIP_BUILD
commit=$(git rev-parse HEAD)
rm -rf "$out"
printf 'Packaging %s (%s) into %s\n' "$product" "$arch" "$out"
env \
  T3CODE_DESKTOP_APP_ID="$app_id" \
  T3CODE_DESKTOP_PRODUCT_NAME="$product" \
  T3CODE_LOCAL_FORK=1 \
  T3CODE_HOME="$data" \
  T3CODE_DISABLE_AUTO_UPDATE=true \
  T3CODE_DESKTOP_SIGNED=false \
  T3CODE_COMMIT_HASH="$commit" \
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

# Electron names the safe storage keychain key "<app name> Safe Storage" from
# app.asar's package.json (productName, else name). The fork must not fall back
# to "t3code": that is the official app's key.
packaged_name=$(asar_field "$app" productName) || fail "Could not read the app name from $app/Contents/Resources/app.asar"
embedded=$(asar_field "$app" t3codeCommitHash) || fail "Could not read the commit from $app/Contents/Resources/app.asar"
[ -n "$embedded" ] && [ "${commit#"$embedded"}" != "$commit" ] || fail "Packaged app was built from '$embedded', not $commit."
[ "$packaged_name" = "$product" ] ||
  fail "Packaged app name is \"$packaged_name\", expected \"$product\": it would use the \"$packaged_name Safe Storage\" keychain key. Not installing."
printf 'Safe storage key: "%s Safe Storage" (dev run: "Electron Safe Storage")\n' "$packaged_name"

printf '%s\n' "${app#"$out/"}" > "$out/app"
printf '%s\n' "$commit" > "$out/commit"
printf 'Packaged %s. Quit %s (Cmd-Q), then run: %s --install\n' "$commit" "$product" "$0"
