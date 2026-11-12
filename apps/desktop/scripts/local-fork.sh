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
. "$repo/apps/desktop/scripts/fork-env.sh"
fork_env
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
stable_pattern='^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$'
# Latest official stable release: plain vX.Y.Z tags only, never nightly or preview.
latest_stable() {
  git ls-remote --tags --refs upstream 'v*' | sed 's|.*refs/tags/||' | grep -E "$stable_pattern" | sort -V | tail -n 1
}
# Stable release this checkout is based on; checks and status compare against it.
merged_stable() {
  git tag --merged HEAD --list 'v*' | grep -E "$stable_pattern" | sort -V | tail -n 1
}
vp() {
  if [ -x ./node_modules/.bin/vp ]; then
    ./node_modules/.bin/vp "$@"
  else
    command -v bunx >/dev/null || fail 'Install Bun, then run this command again.'
    bunx --package vite-plus@1.5.1 vp "$@"
  fi
}
build() {
  rm -f "$built"
  base=$(merged_stable) || fail 'No stable release tag found. Run: git fetch upstream --tags'
  vp install --frozen-lockfile
  vp run check:changed "$base" --concurrency 2
  vp run build:desktop
  git rev-parse HEAD > "$built"
}
# Pushes custom/local (only that branch, never forced) to origin with the
# human gh login. The token is read once per run (GH_TOKEN/GITHUB_TOKEN, else
# 1Password's gh plugin with one Touch ID) and reaches git only through
# GIT_CONFIG_* in the environment: no argv, no disk, no credential helper, no
# terminal prompt. Fetching needs no token: both remotes are public.
pushed_count() { git rev-list --count refs/remotes/origin/custom/local..refs/heads/custom/local 2>/dev/null || printf '?'; }
push_fork() {
  local token='' header n
  n=$(pushed_count)
  if [ "$n" = 0 ]; then printf 'origin/custom/local is up to date.\n'; return 0; fi
  if ! git merge-base --is-ancestor refs/remotes/origin/custom/local refs/heads/custom/local; then
    printf 'origin/custom/local has commits that local custom/local lacks. Not pushing (no force).\n' >&2
    return 1
  fi
  token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
  if [ -z "$token" ] && command -v op >/dev/null 2>&1; then
    printf 'Approve 1Password Touch ID for gh (one push).\n'
    token=$(op plugin run -- gh auth token 2>/dev/null) || token=''
  fi
  if [ -z "$token" ]; then
    printf '%s local commit(s) not pushed. Push later: apps/desktop/scripts/local-fork.sh push\n' "$n" >&2
    return 1
  fi
  header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  token=''
  if ! GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
    GIT_CONFIG_KEY_1=http.https://github.com/.extraheader GIT_CONFIG_VALUE_1="$header" \
    git push origin refs/heads/custom/local:refs/heads/custom/local; then
    printf 'A 403 means the gh token cannot write to origin (a fine-grained token needs Contents: write on it).\n' >&2
    printf '%s local commit(s) not pushed. Push later: apps/desktop/scripts/local-fork.sh push\n' "$n" >&2
    return 1
  fi
  printf 'Pushed %s commit(s) to origin/custom/local.\n' "$n"
}

case "$action" in
  status)
    git status --short --branch
    printf 'Source: %s\nData: %s\n' "$repo" "$data"
    printf 'Built commit: '; cat "$built" 2>/dev/null || true
    printf 'Based on stable: %s\n' "$(merged_stable || printf unknown)"
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
    stable=$(latest_stable) || fail 'Could not find an official stable release.'
    git fetch upstream "refs/tags/$stable:refs/tags/$stable"
    git fetch origin refs/heads/custom/local:refs/remotes/origin/custom/local
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
    git merge --ff-only origin/custom/local
    if ! git -c commit.gpgsign=false merge --no-edit "refs/tags/$stable"; then
      fail 'Merge stopped. Resolve and commit conflicts, or use git merge --abort. No build or push was attempted.'
    fi
    build
    push_fork || true
    printf 'Updated and built. Run apps/desktop/scripts/local-fork.sh start. Recovery: %s\n' "$backup"
    ;;
  push)
    git rev-parse --verify --quiet refs/heads/custom/local >/dev/null || fail 'No local custom/local branch.'
    git fetch origin refs/heads/custom/local:refs/remotes/origin/custom/local
    push_fork
    ;;
  *) fail 'Usage: apps/desktop/scripts/local-fork.sh {status|build|start|update|push}' ;;
esac
