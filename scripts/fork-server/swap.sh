#!/usr/bin/env bash
# Swap mini-1's headless T3 service (launchd com.t3tools.t3code.service) from the official
# runtime to a fork build, or roll it back. Run once, by a human, from a shell that is NOT
# a T3 agent session on this machine (the restart kills every agent process of the service).
#
#   swap.sh [--dry-run] [--build DIR] [--block-updates] [--no-auto-rollback]
#   swap.sh --rollback [--dry-run] [--backup DIR]
#
# How the official runtime picks its version (apps/server/src/serviceLauncher.ts):
#   launchd runs  <plist ProgramArguments[0]> __service-launcher
#   the launcher reads ~/.t3/runtime/service-state.json {"protocol":3,"activeVersion":V}
#   and spawns    ~/.t3/runtime/versions/V/t3 serve   (needs versions/V/.install-complete == V)
# So a swap must change service-state.json as well as the plist; this mirrors what
# `t3 service install` does (bootService.ts), minus any download.
#
# Does NOT touch settings.json. --block-updates (opt-in) adds
# T3CODE_RELEASE_BASE_URL=http://127.0.0.1:9 to ~/.t3/service.env so a remote
# "update server" request or `t3 update` cannot download an official runtime.
set -euo pipefail

LABEL="com.t3tools.t3code.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
T3HOME="$HOME/.t3"
VERSIONS="$T3HOME/runtime/versions"
STATE="$T3HOME/runtime/service-state.json"
SERVICE_ENV="$T3HOME/service.env"
RUNTIME_INFO="$T3HOME/userdata/server-runtime.json"
OFFICIAL_VERSION="0.1.7"
PORT=3773
ROOT="$HOME/permissionlabs/t3-fork-build"
BACKUPS="$ROOT/backups"
DOMAIN="gui/$(id -u)"
BLOCK_URL="http://127.0.0.1:9"

DRY_RUN=0 ROLLBACK=0 BLOCK_UPDATES=0 AUTO_ROLLBACK=1
BUILD_DIR="$ROOT/current" BACKUP_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    --build) BUILD_DIR="$2"; shift ;;
    --backup) BACKUP_DIR="$2"; shift ;;
    --block-updates) BLOCK_UPDATES=1 ;;
    --no-auto-rollback) AUTO_ROLLBACK=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

log() { printf '[swap] %s\n' "$*"; }
die() { printf '[swap] ERROR: %s\n' "$*" >&2; exit 1; }
# Every mutating step goes through run(); --dry-run prints it instead.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}
# write_file <path> <mode> <content>: atomic replace via temp + rename.
write_file() {
  local dest="$1" mode="$2" content="$3"
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] write %s (mode %s):\n%s\n' "$dest" "$mode" "$content"; return; fi
  local tmp; tmp="$(mktemp "$(dirname "$dest")/.swap.XXXXXX")"
  printf '%s\n' "$content" > "$tmp"; chmod "$mode" "$tmp"; mv -f "$tmp" "$dest"
}

state_version() { /usr/bin/plutil -extract activeVersion raw -o - "$1" 2>/dev/null || true; }
plist_program() { /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$1"; }
plist_path_env() { /usr/bin/plutil -extract EnvironmentVariables.PATH raw -o - "$1"; }
service_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
port_open() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; }
running_version() { /usr/bin/plutil -extract serverVersion raw -o - "$RUNTIME_INFO" 2>/dev/null || true; }
running_pid() { /usr/bin/plutil -extract pid raw -o - "$RUNTIME_INFO" 2>/dev/null || true; }

stop_service() {
  if ! service_loaded; then log "service not loaded; nothing to stop"; return; fi
  log "stopping $LABEL (bootout; launcher gets up to ExitTimeOut=90s)"
  run launchctl bootout "$DOMAIN/$LABEL" || true
  [ "$DRY_RUN" = 1 ] && return
  local i
  for i in $(seq 1 120); do
    if ! service_loaded && ! port_open; then log "stopped after ${i}s"; return; fi
    sleep 1
  done
  die "service still loaded or port $PORT still open after 120s"
}

start_service() {
  log "starting $LABEL"
  run launchctl enable "$DOMAIN/$LABEL" || true   # clear a persisted disable override
  if ! run launchctl bootstrap "$DOMAIN" "$PLIST"; then
    log "bootstrap failed; trying kickstart -k"
    run launchctl kickstart -k "$DOMAIN/$LABEL"
  fi
}

# wait_for_version <expected-version> <old-pid>: port answers and runtime state names the version.
wait_for_version() {
  local want="$1" oldpid="$2" i v p
  [ "$DRY_RUN" = 1 ] && { log "(dry-run) would wait for :$PORT and serverVersion=$want"; return 0; }
  for i in $(seq 1 180); do
    if port_open; then
      v="$(running_version)"; p="$(running_pid)"
      if [ "$v" = "$want" ] && [ "$p" != "$oldpid" ]; then
        log "up after ${i}s: :$PORT answers, serverVersion=$v pid=$p"; return 0
      fi
    fi
    sleep 1
  done
  log "not healthy after 180s (serverVersion=$(running_version)); see $T3HOME/userdata/logs/boot-service.log"
  return 1
}

# True when this shell descends from the running T3 service (an agent shell it spawned).
inside_service() {
  local pid="$$" cmd
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in *"/.t3/runtime/versions/"*) return 0 ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

preflight_basic() {
  [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || die "expects macOS arm64"
  if inside_service; then
    log "WARNING: this shell runs under the T3 service; the restart will kill it mid-way."
    if [ "$DRY_RUN" = 0 ]; then read -r -p "continue anyway? [y/N] " a; [ "$a" = y ] || exit 1; fi
  fi
}

preflight_swap() {
  preflight_basic
  [ -f "$PLIST" ] || die "missing $PLIST"
  [ "$(/usr/bin/plutil -extract Label raw -o - "$PLIST")" = "$LABEL" ] || die "unexpected plist label"
  /usr/bin/plutil -lint "$PLIST" >/dev/null || die "plist does not lint"
  [ -f "$STATE" ] || die "missing $STATE"
  if grep -q '"pending"' "$STATE"; then die "a service update is pending in $STATE; wait for it to finish"; fi
}

do_swap() {
  BUILD_DIR="$(cd "$BUILD_DIR" && pwd -P)" || die "no build dir"
  local NEW src cur_prog cur_ver cur_path new_prog new_path ts oldpid
  NEW="$(cat "$BUILD_DIR/VERSION")"
  src="$BUILD_DIR/runtime"
  [ -x "$src/t3" ] && [ -f "$src/client/index.html" ] && [ -d "$src/node_modules" ] && [ -d "$src/resource-monitor" ] \
    || die "incomplete runtime in $src"
  [ "$("$src/t3" --version 2>/dev/null)" = "t3 v$NEW" ] || die "$src/t3 --version does not report $NEW"
  preflight_swap
  cur_prog="$(plist_program "$PLIST")"
  cur_ver="$(state_version "$STATE")"
  log "current: plist program=$cur_prog, activeVersion=$cur_ver, running=$(running_version)"
  log "target:  $NEW (commit $(cat "$BUILD_DIR/COMMIT" 2>/dev/null || echo ?)) from $src"
  [ "$cur_ver" != "$NEW" ] || die "already on $NEW"
  [ -f "$VERSIONS/$cur_ver/.install-complete" ] || die "current runtime $VERSIONS/$cur_ver is incomplete; refusing"

  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUPS/$ts"
  log "backup -> $BACKUP_DIR"
  run mkdir -p "$BACKUP_DIR"
  run cp -p "$PLIST" "$BACKUP_DIR/plist"
  run cp -p "$STATE" "$BACKUP_DIR/service-state.json"
  if [ -f "$SERVICE_ENV" ]; then run cp -p "$SERVICE_ENV" "$BACKUP_DIR/service.env"; fi
  # The fork server prunes runtimes nothing references (pinnedRuntime.ts). ~/.local/bin/t3 still
  # points at $cur_ver, which keeps it, but keep an APFS clone too so rollback never depends on that.
  run cp -cRp "$VERSIONS/$cur_ver" "$BACKUP_DIR/runtime-$cur_ver"
  if [ "$DRY_RUN" = 0 ]; then
    printf '%s\n' "$cur_ver" > "$BACKUP_DIR/previous-version"
    printf '%s\n' "$NEW" > "$BACKUP_DIR/new-version"
    ln -sfn "$BACKUP_DIR" "$BACKUPS/last"
  else
    printf '[dry-run] record previous-version=%s new-version=%s, link %s/last\n' "$cur_ver" "$NEW" "$BACKUPS"
  fi

  # Install the runtime the way pinnedRuntime.ts does: staged copy, sentinel, then rename.
  if [ -f "$VERSIONS/$NEW/.install-complete" ]; then
    log "runtime $NEW already installed"
  else
    log "installing runtime -> $VERSIONS/$NEW"
    run rm -rf "$VERSIONS/.staging-$NEW"
    run /usr/bin/ditto "$src" "$VERSIONS/.staging-$NEW"
    write_file "$VERSIONS/.staging-$NEW/.install-complete" 644 "$NEW"
    run chmod 700 "$VERSIONS/.staging-$NEW"
    run mv "$VERSIONS/.staging-$NEW" "$VERSIONS/$NEW"
  fi
  [ "$DRY_RUN" = 1 ] || "$VERSIONS/$NEW/t3" --version >/dev/null || die "installed runtime does not run"

  new_prog="$VERSIONS/$NEW/t3"
  cur_path="$(plist_path_env "$PLIST")"
  # Swap the exact PATH entry for the old runtime dir (bash 3.2-safe; no pattern substitution).
  new_path="$(printf '%s' "$cur_path" | OLD="$VERSIONS/$cur_ver" NEWDIR="$VERSIONS/$NEW" \
    awk 'BEGIN{RS=":";ORS=""} {sub(/\n$/,""); printf "%s%s", (NR>1?":":""), ($0==ENVIRON["OLD"]?ENVIRON["NEWDIR"]:$0)}')"
  case ":$new_path:" in *":$VERSIONS/$NEW:"*) ;; *) new_path="$new_path:$VERSIONS/$NEW" ;; esac
  # Build and check the new plist off to the side (also in --dry-run), before any downtime.
  # PlistBuddy Set edits in place; `plutil -replace ProgramArguments.0` would insert instead.
  local tmpdir newplist
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/t3swap.XXXXXX")"
  newplist="$tmpdir/$LABEL.plist"
  cp "$PLIST" "$newplist"
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $new_prog" -c "Set :EnvironmentVariables:PATH $new_path" "$newplist" >/dev/null
  /usr/bin/plutil -lint "$newplist" >/dev/null || die "generated plist does not lint"
  [ "$(/usr/bin/plutil -extract ProgramArguments json -o - "$newplist" | tr -d '\\')" = "[\"$new_prog\",\"__service-launcher\"]" ] \
    || die "generated plist has unexpected ProgramArguments"
  [ "$(plist_path_env "$newplist")" = "$new_path" ] || die "generated plist PATH mismatch"
  log "new plist checked ($newplist): program=$new_prog"
  log "new PATH tail: ...${new_path: -90}"
  oldpid="$(running_pid)"

  stop_service
  write_file "$STATE" 600 "{
  \"protocol\": 3,
  \"activeVersion\": \"$NEW\"
}"
  run cp "$newplist" "$PLIST"
  run chmod 644 "$PLIST"
  if [ "$BLOCK_UPDATES" = 1 ]; then
    log "blocking official runtime downloads via $SERVICE_ENV"
    if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] set T3CODE_RELEASE_BASE_URL=%s in %s\n' "$BLOCK_URL" "$SERVICE_ENV"
    else
      touch "$SERVICE_ENV"; grep -v '^T3CODE_RELEASE_BASE_URL=' "$SERVICE_ENV" > "$SERVICE_ENV.swap" || true
      printf 'T3CODE_RELEASE_BASE_URL=%s\n' "$BLOCK_URL" >> "$SERVICE_ENV.swap"; chmod 600 "$SERVICE_ENV.swap"; mv -f "$SERVICE_ENV.swap" "$SERVICE_ENV"
    fi
  fi
  start_service
  if wait_for_version "$NEW" "$oldpid"; then
    log "swap done: $NEW is serving :$PORT. Roll back with: $0 --rollback"
  elif [ "$AUTO_ROLLBACK" = 1 ]; then
    log "fork did not come up; rolling back automatically"
    do_rollback
    exit 1
  else
    die "fork did not come up; run: $0 --rollback"
  fi
}

do_rollback() {
  [ -n "$BACKUP_DIR" ] || BACKUP_DIR="$BACKUPS/last"
  BACKUP_DIR="$(cd "$BACKUP_DIR" 2>/dev/null && pwd -P)" || die "no backup dir (looked for $BACKUPS/last)"
  [ -f "$BACKUP_DIR/plist" ] && [ -f "$BACKUP_DIR/service-state.json" ] || die "incomplete backup $BACKUP_DIR"
  local prev oldpid
  prev="$(cat "$BACKUP_DIR/previous-version" 2>/dev/null || state_version "$BACKUP_DIR/service-state.json")"
  [ -n "$prev" ] || prev="$OFFICIAL_VERSION"
  if [ ! -f "$PLIST" ]; then log "plist missing; restoring from backup"; fi
  if [ -f "$STATE" ] && grep -q '"pending"' "$STATE"; then log "WARNING: pending update in $STATE will be discarded"; fi
  log "rollback to $prev using $BACKUP_DIR"
  if [ ! -f "$VERSIONS/$prev/.install-complete" ]; then
    [ -d "$BACKUP_DIR/runtime-$prev" ] || die "runtime $prev missing and not in backup"
    log "restoring runtime $prev from backup clone"
    run rm -rf "$VERSIONS/$prev"
    run cp -cRp "$BACKUP_DIR/runtime-$prev" "$VERSIONS/$prev"
  fi
  oldpid="$(running_pid)"
  stop_service
  run cp -p "$BACKUP_DIR/service-state.json" "$STATE"
  run cp -p "$BACKUP_DIR/plist" "$PLIST"
  if [ -f "$BACKUP_DIR/service.env" ]; then run cp -p "$BACKUP_DIR/service.env" "$SERVICE_ENV"; fi
  start_service
  wait_for_version "$prev" "$oldpid" || die "rollback did not come up; check $T3HOME/userdata/logs/boot-service.log"
  log "rollback done: $prev is serving :$PORT (fork runtime dir left in $VERSIONS; $prev's own prune may remove it)"
}

[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing will be changed"
if [ "$ROLLBACK" = 1 ]; then preflight_basic; do_rollback; else do_swap; fi
