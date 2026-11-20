#!/bin/bash
set -euo pipefail

# --publish pushes a clean candidate with the approved broker and opens its PR to custom/local.
publish=false
[[ "${1:-}" == --publish ]] && publish=true
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
if git show-ref --verify --quiet "refs/heads/$branch"; then
  printf 'Candidate %s already exists in %s.\n' "$branch" "$checkout"
  exit 0
fi
git worktree add -b "$branch" "$checkout" "$base"
if ! git -C "$checkout" -c commit.gpgsign=false merge --no-edit "$ref"; then
  printf 'Resolve the merge in %s before validation.\n' "$checkout" >&2
  git -C "$checkout" diff --name-only --diff-filter=U
  exit 2
fi
if git -C "$checkout" diff --quiet "$base" HEAD -- .github/workflows; then
  workflows=unchanged
else
  workflows=changed
fi
printf 'Candidate: %s\nWorktree: %s\nBase: %s\nWorkflows: %s\n' "$branch" "$checkout" "$base" "$workflows"
$publish || exit 0
# The broker refuses workflow changes; a person carries those through the MacBook path.
[[ "$workflows" == unchanged ]] || fail "$tag changes .github/workflows; hand $branch to the MacBook path."
cd "$checkout"
brokerctl push-agent --repo t3code --ref "$branch"
printf 'Merges the official %s release into custom/local.\n\nPrepared by scripts/fork-prepare-upstream.sh from custom/local %s.\n' \
  "$tag" "$base" | brokerctl open-pr --repo t3code --ref "$branch" --title "chore(fork): merge upstream $tag" --body-file -
