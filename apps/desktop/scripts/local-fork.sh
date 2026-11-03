#!/bin/bash
set -euo pipefail
umask 077

repo=$(cd "$(dirname "$0")/../../.." && pwd -P)
cd "$repo"
state=$(git rev-parse --absolute-git-dir)
data="$HOME/.t3-custom"
lock="$state/local-fork.lock"
built="$state/local-fork-built"
action=${1:-status}

fail() { printf '%s\n' "$*" >&2; exit 1; }
clean() {
  [ "$(git branch --show-current)" = custom/local ] || fail 'Switch to custom/local first.'
  [ -z "$(git status --porcelain)" ] || fail 'Commit or stash your changes before continuing.'
}
acquire() {
  if ! mkdir "$lock" 2>/dev/null; then
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    case "$owner" in ''|*[!0-9]*) fail "Inspect stale lock manually: $lock" ;; esac
    if kill -0 "$owner" 2>/dev/null; then
      fail 'Custom app or maintenance is running. Quit the app before updating.'
    fi
    rm "$lock/pid"
    rmdir "$lock"
    mkdir "$lock" || fail 'Another process acquired the lock.'
  fi
  printf '%s\n' "$$" > "$lock/pid"
  trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
}
vp() {
  if [ -x ./node_modules/.bin/vp ]; then
    ./node_modules/.bin/vp "$@"
  else
    command -v bunx >/dev/null || fail 'Install Bun, then run this command again.'
    bunx --package vite-plus@1.4.0 vp "$@"
  fi
}
build() {
  rm -f "$built"
  vp install --frozen-lockfile
  vp run check:changed upstream/main --concurrency 2
  vp run build:desktop
  git rev-parse HEAD > "$built"
}

case "$action" in
  status)
    git status --short --branch
    printf 'Source: %s\nData: %s\n' "$repo" "$data"
    printf 'Built commit: '; cat "$built" 2>/dev/null || true
    git log -1 --format='Upstream: %h %s' upstream/main
    ;;
  build)
    clean
    acquire
    build
    ;;
  start)
    clean
    acquire
    [ -f "$built" ] && [ "$(cat "$built")" = "$(git rev-parse HEAD)" ] || fail 'Run apps/desktop/scripts/local-fork.sh build first; this revision has not passed checks and built.'
    mkdir -p "$data"
    [ "$(cd "$data" && pwd -P)" = "$data" ] || fail 'Custom data directory must not be a symlink.'
    unset VITE_DEV_SERVER_URL VITE_HTTP_URL VITE_WS_URL ELECTRON_RUN_AS_NODE
    export T3CODE_HOME="$data"
    export T3CODE_LOCAL_FORK=1
    export T3CODE_DISABLE_AUTO_UPDATE=true
    export T3CODE_DESKTOP_APP_USER_MODEL_ID=com.bamnenim.t3code.custom
    export T3CODE_COMMIT_HASH
    T3CODE_COMMIT_HASH=$(git rev-parse HEAD)
    vp run start:desktop
    ;;
  update)
    clean
    acquire
    [ "$(git remote get-url upstream)" = 'https://github.com/pingdotgg/t3code.git' ] || fail 'Unexpected upstream URL.'
    git fetch upstream main
    git fetch origin custom/local
    git merge --ff-only origin/custom/local
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    backup="backup/local-$stamp"
    git branch "$backup"
    printf '%s\n' "$backup" > "$state/local-fork-backup"
    if [ -d "$data" ]; then
      [ "$(cd "$data" && pwd -P)" = "$data" ] || fail 'Custom data directory must not be a symlink.'
      mkdir -p "$HOME/.t3-custom-backups"
      tar -czf "$HOME/.t3-custom-backups/$stamp.tgz" -C "$data" .
    fi
    rm -f "$built"
    printf 'Recovery branch: %s\n' "$backup"
    if ! git -c commit.gpgsign=false merge --no-edit upstream/main; then
      fail 'Merge stopped. Resolve and commit conflicts, or use git merge --abort. No build or push was attempted.'
    fi
    build
    git push origin HEAD:refs/heads/custom/local
    printf 'Updated and built. Run apps/desktop/scripts/local-fork.sh start. Recovery: %s\n' "$backup"
    ;;
  *) fail 'Usage: apps/desktop/scripts/local-fork.sh {status|build|start|update}' ;;
esac
