#!/bin/bash
set -euo pipefail

upstream=https://github.com/pingdotgg/t3code.git
repo=$(git rev-parse --show-toplevel)
cd "$repo"
fail() { printf '%s\n' "$*" >&2; exit 1; }

base=$(pl-gh-read t3code branches/custom/local | jq -er '.commit.sha | select(test("^[0-9a-f]{40}$"))')
git cat-file -e "$base^{commit}" 2>/dev/null ||
  fail 'Fetch the fork with pl-sync t3code, then run this from that checkout.'
refs=$(GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote --tags --refs "$upstream" 'v*')
tag=$(printf '%s\n' "$refs" | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ {
  sub(/^refs\/tags\//, "", $2); print $2
}' | sort -V | tail -1)
[[ -n "$tag" ]] || fail 'No official stable release tag found.'
ref="refs/tags/$tag"
remote_tag=$(printf '%s\n' "$refs" | awk -v ref="$ref" '$2 == ref {print $1}')
GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --no-tags "$upstream" "$ref:$ref"
[[ "$(git rev-parse "$ref")" == "$remote_tag" ]] || fail "Official tag changed during fetch: $tag"

if git merge-base --is-ancestor "$ref^{commit}" "$base"; then
  printf '%s is already included in custom/local (%s).\n' "$tag" "$base"
  exit 0
fi

branch="agent/upstream-${tag#v}-${base:0:10}"
checkout="$(dirname "$repo")/t3-upstream-${tag#v}-${base:0:10}"
git worktree add -b "$branch" "$checkout" "$base"
if ! git -C "$checkout" -c commit.gpgsign=false merge --no-edit "$ref"; then
  printf 'Resolve the merge in %s before validation.\n' "$checkout" >&2
  git -C "$checkout" diff --name-only --diff-filter=U
  exit 1
fi
printf 'Candidate: %s\nWorktree: %s\nBase: %s\n' "$branch" "$checkout" "$base"
