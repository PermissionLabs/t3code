#!/bin/bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 2 || $# == 3 ]] || fail 'Usage: fork-build-release.sh <custom/local SHA> <absolute output directory> [base version]'
sha=$1
output=$2
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$output" == /* ]] || fail 'Pass a full SHA and absolute output directory.'
[[ "$(uname -s):$(uname -m)" == Darwin:arm64 ]] || fail 'Build on an Apple Silicon Mac.'
for tool in pl-gh-read jq corepack cargo; do
  command -v "$tool" >/dev/null || fail "Build tool missing: $tool"
done

cd "$(git rev-parse --show-toplevel)"
[[ "$(git rev-parse HEAD)" == "$sha" ]] || fail 'Check out the requested commit in the build worktree.'
[[ -z "$(git status --porcelain)" ]] || fail 'Use a clean build worktree.'
remote=$(pl-gh-read t3code branches/custom/local | jq -er '.commit.sha')
[[ "$remote" == "$sha" ]] || fail 'Requested SHA is not the current remote custom/local head.'

node_version=$(node -p 'require("./package.json").engines.node')
[[ "$(node -p 'process.versions.node')" == "$node_version" ]] ||
  fail "Select Node $node_version before building."
base=$(git tag --merged "$sha" --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
[[ -n "$base" ]] || fail 'Fetch official tags to identify the stable base.'
minimum_version=${3:-0.0.0}
[[ "$minimum_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail 'Base version must be X.Y.Z.'
manifest_version=$(node -p 'require("./apps/server/package.json").version.split(/[+-]/)[0]')
server_version=$(printf '%s\n' "$minimum_version" "$manifest_version" "${base#v}" | sort -V | tail -1)
# Use the commit time in UTC so retries resolve to the same release directory.
commit_time=$(TZ=UTC git show -s --format=%cd --date=format-local:%Y%m%d%H%M%S "$sha")
version="$server_version-fork.$commit_time+g$sha"
release="$output/v$version"
archive="t3-$version-darwin-arm64.tar.gz"
mkdir -p "$output"
lock="$output/.v$version.lock"
mkdir "$lock" || fail "Release build lock already exists: $lock"
stage=
cleanup() {
  if [[ -n "$stage" && -f "$stage/server-package.json" ]]; then
    cp "$stage/server-package.json" apps/server/package.json
  fi
  if [[ -n "$stage" ]]; then rm -rf "$stage"; fi
  rmdir "$lock"
}
trap cleanup EXIT
if [[ -e "$release" ]]; then
  jq -e --arg version "$version" --arg commit "$sha" --arg archive "$archive" \
    '.version == $version and .commit == $commit and .archive == $archive' \
    "$release/release.json" >/dev/null || fail "Release manifest mismatch: $release"
  expected=$(cat "$release/SHA256SUMS")
  actual=$(cd "$release" && shasum -a 256 "$archive")
  [[ "$expected" == "$actual" ]] || fail "Release checksum mismatch: $release"
  printf 'Release already verified: %s\n' "$release"
  exit 0
fi
stage=$(mktemp -d "$output/.t3-fork-build.XXXXXX")
cp apps/server/package.json "$stage/server-package.json"

corepack pnpm install --frozen-lockfile
export PATH="$PWD/node_modules/.bin:$PATH"
(cd apps/web && APP_VERSION="$version" vp build)
node - "$version" <<'JS'
const fs = require("node:fs");
const path = "apps/server/package.json";
const original = fs.readFileSync(path, "utf8");
fs.writeFileSync(path, original.replace(/"version": "[^"]+"/, `"version": "${process.argv[2]}"`));
JS
T3CODE_TELEMETRY_CHANNEL=dev node apps/server/scripts/cli.ts build-exe
mkdir -p apps/server/dist/client "$stage/resource-monitor/darwin-arm64" "$stage/release"
ditto apps/web/dist apps/server/dist/client
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target-dir "$stage/cargo"
cp "$stage/cargo/release/t3-resource-monitor" "$stage/resource-monitor/darwin-arm64/"
node scripts/build-cli-archive.ts --platform mac --arch arm64 --version "$version" \
  --resource-monitor-dir "$stage/resource-monitor" --output-dir "$stage/release"
protocol=$(node --input-type=module -e '
  import { SERVICE_LAUNCHER_PROTOCOL } from "./apps/server/src/cloud/serviceProtocol.ts";
  console.log(SERVICE_LAUNCHER_PROTOCOL);
')
node scripts/smoke-cli-archive.ts --archive "$stage/release/$archive" --expect-version "$version" \
  --service-launcher-protocol "$protocol"
(cd "$stage/release" && shasum -a 256 "$archive" > SHA256SUMS)
jq -n --arg version "$version" --arg commit "$sha" --arg upstream "$base" --arg archive "$archive" \
  '{version:$version,commit:$commit,upstream:$upstream,archive:$archive}' > "$stage/release/release.json"
[[ ! -e "$release" ]] || fail "Release already exists: $release"
mv "$stage/release" "$release"
printf 'Release ready for publication: %s\n' "$release"
