#!/usr/bin/env bash
# Build a T3 server runtime (CLI archive, darwin-arm64) from the fork worktree.
# Usage: build.sh [worktree]   -> ~/permissionlabs/t3-fork-build/<sha>/
set -euo pipefail
ROOT="$HOME/permissionlabs/t3-fork-build"
REPO="${1:-$HOME/permissionlabs/oti-worktrees/t3-fork-server}"
. "$ROOT/tools/env.sh"
cd "$REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "worktree has tracked changes; commit or stash first" >&2; exit 1; }
SHA=$(git rev-parse --short=10 HEAD)
VERSION="${T3_FORK_VERSION:-0.1.8-fork.$(date +%Y%m%d)+g${SHA}}"
OUT="$ROOT/$SHA"
mkdir -p "$OUT"
echo "[build] repo=$REPO sha=$SHA version=$VERSION out=$OUT"
# Public (non-secret) cloud config copied from the official 0.1.7 build, so the relay link keeps working.
set -a; . "$ROOT/public-config.env"; set +a
restore() { git -C "$REPO" checkout -- apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json; }
trap restore EXIT
node scripts/update-release-package-versions.ts "$VERSION"
vp run --filter t3 build
node apps/server/scripts/cli.ts build-exe
# Resource monitor: reuse the official 0.1.7 binary (Rust, unchanged by the fork; no cargo here).
RM="$OUT/resource-monitor"; rm -rf "$RM"; mkdir -p "$RM"
cp -R "$HOME/.t3/runtime/versions/0.1.7/resource-monitor/darwin-arm64" "$RM/"
node scripts/build-cli-archive.ts --platform mac --arch arm64 --version "$VERSION" \
  --resource-monitor-dir "$RM" --output-dir "$OUT"
ARCHIVE="$OUT/t3-${VERSION}-darwin-arm64.tar.gz"
rm -rf "$OUT/runtime"; mkdir -p "$OUT/runtime"
tar -xzf "$ARCHIVE" -C "$OUT/runtime" --strip-components=1
printf '%s\n' "$VERSION" > "$OUT/VERSION"
git rev-parse HEAD > "$OUT/COMMIT"
echo "[build] done: $OUT/runtime ($(cat "$OUT/VERSION"))"
